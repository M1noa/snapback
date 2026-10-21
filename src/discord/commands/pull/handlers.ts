// the /pull controls.
//
// the confirm button carries a one-time nonce, so a pull only runs when the
// operator who asked for it presses it. the router re-checks access on every
// press, so a control rendered for an admin last week fails closed today
// (AGENTS.md rule 8).
//
// the reset is guarded the same way, and one step further: the operator types
// the account's name before the counters go.

import {
  DEFAULT_GUILD_SETTINGS,
  type GuildSettings,
  mergeGuildSettings,
} from "../../../config/defaults.ts";
import { getAccountCounter, upsertAccountCounter } from "../../../db/queries/counters.ts";
import { getGuildSettings, setGuildSettings } from "../../../db/queries/guilds.ts";
import { getJob } from "../../../db/queries/jobs.ts";
import { clampInt } from "../../../lib/validate.ts";
import type { PullLimits } from "../../../services/pull/counter.ts";
import { blankCounter, utcDay } from "../../../services/pull/counter.ts";
import { label, textInput } from "../../components/row.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { Handler, HandlerContext, HandlerResult, Router } from "../../interactions/router.ts";
import {
  PULL_ACTION,
  PULL_LIMIT_SOURCES,
  PULL_OBJECT,
  PULL_SURFACE,
  type PullDeps,
  pullCustomId,
} from "./deps.ts";
import {
  configPageFor,
  countersPageFor,
  findAccount,
  planPageFor,
  reportPageFor,
  resetPageFor,
} from "./index.ts";

type Container = Parameters<HandlerContext["surface"]["reply"]>[0]["message"];

async function answer(ctx: HandlerContext, message: Container): Promise<HandlerResult> {
  await ctx.surface.reply({ message, ephemeral: true, update: true });
  return { kind: "reply" };
}

/** the text a modal submitted, trimmed. */
function typed(ctx: HandlerContext, id: string): string {
  const value = ctx.surface.values[id];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

/** the plan's confirm button. the nonce decides, and it is one-time. */
function confirmHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation expired",
          "confirmations live for 15 minutes, and this one is gone.",
          undefined,
          "press the button again to get a fresh confirmation.",
        ),
      );
    }
    // one press, one run: the nonce goes before the job is queued.
    await deps.state.delete(ctx.id.cursor);
    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation is not yours",
          "it was minted for a different user or server, so it will not be used.",
          undefined,
          "press the button again to get a fresh confirmation.",
        ),
      );
    }

    const payload = nonce.payload as { excludeRevoked?: unknown; max?: unknown };
    const excludeRevoked = payload.excludeRevoked !== false;
    const max = typeof payload.max === "number" ? payload.max : null;

    const job = await deps.jobs.enqueue("pull", {
      guildId: ctx.id.guild,
      requestedBy: ctx.identity.userId,
      payload: { excludeRevoked, max },
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "pull.start",
      target: job.id,
      detail: { excludeRevoked, max },
    });
    return await answer(ctx, await reportPageFor(deps, ctx.id.guild));
  };
}

/** the plan's other button: nothing was pulled. */
function backHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    return await answer(ctx, await reportPageFor(deps, ctx.id.guild));
  };
}

/** the page again, with a fresh read. the object says which page. */
function refreshHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    if (ctx.id.object === PULL_OBJECT.counters) {
      return await answer(ctx, await countersPageFor(deps, ctx.id.guild));
    }
    return await answer(ctx, await reportPageFor(deps, ctx.id.guild));
  };
}

/** open the plan page from the report. */
function planHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    return await answer(
      ctx,
      await planPageFor(deps, ctx.id.guild, ctx.identity.userId, {
        excludeRevoked: true,
        max: null,
      }),
    );
  };
}

/** stop the run. the engine stops at the next account, not in the middle of one. */
function cancelHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    const jobId = ctx.id.cursor;
    await deps.jobs.cancel(jobId);
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "pull.job.cancel",
      target: jobId,
    });
    return await answer(ctx, await reportPageFor(deps, ctx.id.guild));
  };
}

/** hold the run, or let it go again when it is already held. */
function pauseHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    const jobId = ctx.id.cursor;
    const job = await getJob(deps.db, jobId);
    if (job === null) {
      return await answer(ctx, failurePage("that job is gone", "the job row is not there."));
    }
    if (job.status === "paused") await deps.jobs.resume(jobId);
    else await deps.jobs.pause(jobId);
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: job.status === "paused" ? "pull.job.resume" : "pull.job.pause",
      target: jobId,
    });
    return await answer(ctx, await reportPageFor(deps, ctx.id.guild));
  };
}

/** the reset page's button: the modal asks for the name, so a stray click
 *  cannot clear a counter. */
function resetHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    const userId = ctx.id.cursor;
    const account = await findAccount(deps, ctx.id.guild, userId);
    if (account === null) {
      return await answer(
        ctx,
        failurePage("that account is gone", "nobody in this server matches that id any more."),
      );
    }

    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: PULL_SURFACE,
      payload: { action: "reset", userId },
    });
    const id = pullCustomId({
      guildId: ctx.id.guild,
      object: PULL_OBJECT.reset,
      action: PULL_ACTION.confirmReset,
      cursor: nonce,
    });
    await ctx.surface.openModal({
      customID: id,
      title: "type the name to confirm",
      components: [
        label({
          label: "the account's name",
          description: "it has to match exactly, so a stray click cannot clear a counter.",
          component: textInput({ id, required: true, maxLength: 32 }),
        }),
      ],
    });
    return { kind: "reply" };
  };
}

/** the modal's submit: the name decides, and then the counters go. */
function confirmResetHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation expired",
          "confirmations live for 15 minutes, and this one is gone.",
          undefined,
          "run `/pull reset` again to get a fresh confirmation.",
        ),
      );
    }
    // one press, one reset: the nonce goes before the counters do.
    await deps.state.delete(ctx.id.cursor);
    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation is not yours",
          "it was minted for a different user or server, so it will not be used.",
          undefined,
          "run `/pull reset` again to get a fresh confirmation.",
        ),
      );
    }

    const payload = nonce.payload as { userId?: unknown };
    const userId = typeof payload.userId === "string" ? payload.userId : "";
    const account = await findAccount(deps, ctx.id.guild, userId);
    if (account === null) {
      return await answer(
        ctx,
        failurePage("that account is gone", "nobody in this server matches that id any more."),
      );
    }

    const name = account.username ?? "unknown";
    if (typed(ctx, ctx.id.raw) !== name) {
      return await answer(
        ctx,
        failurePage(
          "that is not the name",
          "the name has to match exactly, so a stray click cannot clear a counter.",
          undefined,
          `type \`${name}\` and press the button again.`,
        ),
      );
    }

    const now = new Date(deps.now());
    const before = await getAccountCounter(deps.db, userId, ctx.id.guild, utcDay(now));
    // the counters go back to zero. the attempt history stays: it is the record
    // of what happened, and a reset is not an erasure.
    await upsertAccountCounter(deps.db, blankCounter(userId, ctx.id.guild, now));
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "pull.reset",
      target: userId,
      detail: {
        day: utcDay(now),
        attempts: before?.attempts ?? 0,
        successes: before?.successes ?? 0,
        failures: before?.failures ?? 0,
        restricted: before?.restricted ?? false,
      },
    });

    return await answer(ctx, await resetPageFor(deps, ctx.id.guild, account, true));
  };
}

/** the limits in force, and where they come from. */
function configHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    return await answer(ctx, await configPageFor(deps, ctx.id.guild));
  };
}

/** the config page's edit button: the modal opens with the values in place, and
 *  carries a nonce so a stale submit cannot write after the page is gone. */
function editLimitsHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    if (!(await deps.authorize(ctx.identity.userId, ctx.id.guild))) {
      return await answer(
        ctx,
        failurePage(
          "not your server's pull",
          "only this server's snapback admins can pull into it.",
          undefined,
          "ask one of this server's snapback admins, or the instance owner, for access.",
        ),
      );
    }
    const limits = await deps.limits(ctx.id.guild);

    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: PULL_SURFACE,
      payload: { action: "limits" },
    });
    const base = { guildId: ctx.id.guild, object: PULL_OBJECT.config };
    const row = (cursor: string) =>
      pullCustomId({
        guildId: ctx.id.guild,
        object: PULL_OBJECT.config,
        action: PULL_ACTION.saveLimits,
        cursor,
      });
    await ctx.surface.openModal({
      customID: pullCustomId({ ...base, action: PULL_ACTION.saveLimits, cursor: nonce }),
      title: "the pull limits",
      components: [
        label({
          label: "attempts per account per day",
          description: "daily attempt budget",
          component: textInput({
            id: row("daily"),
            required: false,
            value: String(limits.dailyLimit),
          }),
        }),
        label({
          label: "failure cooldown (minutes)",
          description: "how long a burst of failures holds an account",
          component: textInput({
            id: row("failure"),
            required: false,
            value: String(limits.failureCooldownMinutes),
          }),
        }),
        label({
          label: "restricted hold (hours)",
          description: "how long a restricted account stays out",
          component: textInput({
            id: row("restricted"),
            required: false,
            value: String(limits.restrictedHours),
          }),
        }),
      ],
    });
    return { kind: "reply" };
  };
}

/** the modal's submit: three numbers, each clamped, then one audited write. */
function saveLimitsHandler(deps: PullDeps): Handler {
  return async (ctx) => {
    if (!(await deps.authorize(ctx.identity.userId, ctx.id.guild))) {
      return await answer(
        ctx,
        failurePage(
          "not your server's pull",
          "only this server's snapback admins can pull into it.",
          undefined,
          "ask one of this server's snapback admins, or the instance owner, for access.",
        ),
      );
    }
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(
        ctx,
        failurePage(
          "that edit expired",
          "the modal lives for 15 minutes, and this one is gone.",
          undefined,
          "press edit again to get a fresh modal.",
        ),
      );
    }
    // one press, one write: the nonce goes before the settings do.
    await deps.state.delete(ctx.id.cursor);
    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage(
          "that edit is not yours",
          "it was minted for a different user or server, so it will not be used.",
          undefined,
          "press edit again to get a fresh modal.",
        ),
      );
    }

    const row = (cursor: string) =>
      pullCustomId({
        guildId: ctx.id.guild,
        object: PULL_OBJECT.config,
        action: PULL_ACTION.saveLimits,
        cursor,
      });
    const before = await deps.limits(ctx.id.guild);
    const patch: Partial<GuildSettings> = {};
    // a cursor per row, keyed by the limit the row edits.
    const CURSORS: Record<keyof PullLimits, string> = {
      dailyLimit: "daily",
      failureCooldownMinutes: "failure",
      restrictedHours: "restricted",
    };
    for (const source of PULL_LIMIT_SOURCES) {
      const raw = typed(ctx, row(CURSORS[source.key]));
      if (raw === "") continue; // left blank: the stored value stands
      const value = clampInt(raw, { min: source.min, max: source.max });
      if (value === null) {
        return await answer(
          ctx,
          failurePage(
            "that value does not fit",
            `**${source.setting}** has to be a whole number between ${source.min} and ${source.max}. nothing was written.`,
            undefined,
            "press edit, fix the number, and submit again.",
          ),
        );
      }
      // the patch is numbers into number fields; Partial's union read disagrees,
      // so the write goes in through a plain record.
      (patch as Record<string, unknown>)[source.setting] = value;
    }

    const current = (await getGuildSettings(deps.db, ctx.id.guild)) ?? DEFAULT_GUILD_SETTINGS;
    await setGuildSettings(deps.db, ctx.id.guild, mergeGuildSettings(current, patch));
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "pull.limits.edit",
      target: "settings",
      detail: {
        before: {
          dailyLimit: before.dailyLimit,
          failureCooldownMinutes: before.failureCooldownMinutes,
          restrictedHours: before.restrictedHours,
        },
        patch,
      },
    });
    return await answer(ctx, await configPageFor(deps, ctx.id.guild));
  };
}

export function registerPullHandlers(router: Router, deps: PullDeps): void {
  router.register(PULL_SURFACE, PULL_ACTION.confirm, confirmHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.back, backHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.cancel, cancelHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.pause, pauseHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.refresh, refreshHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.plan, planHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.reset, resetHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.confirmReset, confirmResetHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.config, configHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.edit, editLimitsHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.saveLimits, saveLimitsHandler(deps));
}
