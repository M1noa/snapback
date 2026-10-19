// the /restore controls. one handler per (surface, action); the object slot says
// which one this is, because the router keys on the pair.
//
// a restore is confirmed with a one-time nonce, and the clear is confirmed twice:
// once by typing the guild's name, and once by pressing a button that carries the
// nonce (D4PLAN 12.7).

import { listJobsByGuild } from "../../../db/queries/jobs.ts";
import { DEFAULT_RESTORE_OPTIONS, type RestoreOptions } from "../../../services/restore/types.ts";
import { label, textInput } from "../../components/row.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { Handler, HandlerContext, HandlerResult, Router } from "../../interactions/router.ts";
import { STATE_TTL_MS } from "../../interactions/state.ts";
import {
  RESTORE_ACTION,
  RESTORE_OBJECT,
  RESTORE_SURFACE,
  type RestoreDeps,
  restoreCustomId,
} from "./deps.ts";
import { clearPage, confirmRestorePage, jobPage, planPage } from "./pages.ts";
import { backupLabel, payloadString } from "./support.ts";

type Container = Parameters<HandlerContext["surface"]["reply"]>[0]["message"];

async function answer(ctx: HandlerContext, message: Container): Promise<HandlerResult> {
  await ctx.surface.reply({ message, ephemeral: true, update: true });
  return { kind: "reply" };
}

/** the categories the operator ticked. an unticked box contributes nothing. */
function chosenCategories(ctx: HandlerContext, selectId: string): string[] {
  const submitted = ctx.surface.values[selectId];
  const raw = Array.isArray(submitted) ? submitted : submitted === undefined ? [] : [submitted];
  return raw.filter((value): value is string => typeof value === "string");
}

/** the options a ticked set implies, on top of the guild's restore settings. */
async function optionsFor(
  deps: RestoreDeps,
  guildId: string,
  categories: readonly string[],
): Promise<RestoreOptions> {
  const settings = await deps.settings(guildId);
  const on = new Set(categories);
  return {
    ...DEFAULT_RESTORE_OPTIONS,
    guild: on.has("guild"),
    emojis: on.has("emojis"),
    stickers: on.has("stickers"),
    sounds: on.has("sounds"),
    roles: on.has("roles"),
    channels: on.has("channels"),
    overwrites: on.has("overwrites"),
    threads: on.has("threads"),
    onboarding: on.has("onboarding"),
    automod: on.has("automod"),
    events: on.has("events"),
    members: on.has("members"),
    bans: on.has("bans"),
    messages: on.has("messages"),
    clearBefore: settings.restore_clear_before,
    timestampSuffix: settings.restore_message_timestamp_suffix,
  };
}

/** the selection page's "restore" button: the ticked categories become the
 *  options, and the confirm button carries a one-time nonce. */
function openHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const selectId = restoreCustomId({
      guildId: ctx.id.guild,
      object: RESTORE_OBJECT.confirm,
      action: RESTORE_ACTION.submit,
    });
    const categories = chosenCategories(ctx, selectId);
    const stored = await deps.state.get(ctx.id.cursor);
    const backupId = payloadString(stored?.payload, "backupId") ?? "";
    const targetId = payloadString(stored?.payload, "targetId") ?? ctx.id.guild;
    if (backupId === "") {
      return await answer(ctx, failurePage("no backup selected", "the selection lost its backup."));
    }

    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: RESTORE_SURFACE,
      payload: {
        action: "restore",
        backupId,
        targetId,
        categories,
      },
    });

    const row = await deps.lookup(ctx.id.guild, backupId);
    return await answer(
      ctx,
      confirmRestorePage({
        guildId: ctx.id.guild,
        backupLabel: row === null ? backupId : backupLabel(row),
        targetLabel: targetId,
        nonce,
        expiresAt: deps.now() + STATE_TTL_MS,
        cancelId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.select,
          action: RESTORE_ACTION.open,
        }),
      }),
    );
  };
}

/** the confirm page's button: the job starts. */
function confirmHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation expired",
          "confirmations live for 15 minutes, and this one is gone.",
          undefined,
          "press restore again to get a fresh confirmation.",
        ),
      );
    }
    // one press, one restore: the row goes before the write.
    await deps.state.delete(ctx.id.cursor);
    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation is not yours",
          "it was minted for a different user or server, so it will not be used.",
        ),
      );
    }

    const payload = nonce.payload as {
      action?: string;
      backupId?: string;
      targetId?: string;
      categories?: string[];
      clearBefore?: boolean;
    };
    const backupId = payload.backupId ?? "";
    const targetId = payload.targetId ?? ctx.id.guild;
    const options = await optionsFor(deps, ctx.id.guild, payload.categories ?? []);
    const withClear = payload.clearBefore === true ? { ...options, clearBefore: true } : options;

    const job = await deps.jobs.enqueue("restore", {
      guildId: ctx.id.guild,
      requestedBy: ctx.identity.userId,
      payload: { backupId, targetId, options: withClear },
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "restore.start",
      target: backupId,
      detail: { jobId: job.id, targetId, categories: payload.categories ?? [] },
    });

    return await answer(
      ctx,
      jobPage({
        guildId: ctx.id.guild,
        lines: [
          `job \`${job.id.slice(0, 8)}\` is restoring into <#${targetId}>.`,
          "the phases run in order, and each one is checkpointed, so a restart resumes rather than starts over.",
        ],
        state: "info",
        refreshId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.job,
          action: RESTORE_ACTION.refresh,
        }),
        cancelId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.job,
          action: RESTORE_ACTION.cancel,
        }),
      }),
    );
  };
}

/** the selection page's "preview" button: the plan, and nothing is written. */
function planHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const selectId = restoreCustomId({
      guildId: ctx.id.guild,
      object: RESTORE_OBJECT.confirm,
      action: RESTORE_ACTION.submit,
    });
    const categories = chosenCategories(ctx, selectId);
    const stored = await deps.state.get(ctx.id.cursor);
    const backupId = payloadString(stored?.payload, "backupId") ?? "";
    if (backupId === "") {
      return await answer(ctx, failurePage("no backup selected", "the selection lost its backup."));
    }
    const options = await optionsFor(deps, ctx.id.guild, categories);
    const plan = (await deps.plan(backupId, options)) as {
      phases?: readonly { phase: string; ops: readonly { what: string; count: number }[] }[];
    };
    const lines: string[] = [];
    for (const phase of plan.phases ?? []) {
      for (const op of phase.ops) lines.push(`**${phase.phase}** ${op.what} (${op.count})`);
    }
    if (lines.length === 0) lines.push("this backup holds nothing to restore.");

    return await answer(
      ctx,
      planPage({
        guildId: ctx.id.guild,
        lines,
        backId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.select,
          action: RESTORE_ACTION.open,
        }),
        submitId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.confirm,
          action: RESTORE_ACTION.open,
        }),
      }),
    );
  };
}

/** the selection page's "clear target first" button: a modal that asks for the
 *  guild's name, because this is the most destructive thing the bot does. */
function clearHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const stored = await deps.state.get(ctx.id.cursor);
    const targetId = payloadString(stored?.payload, "targetId") ?? "";
    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: RESTORE_SURFACE,
      payload: { action: "clear", targetId },
    });
    const id = restoreCustomId({
      guildId: ctx.id.guild,
      object: RESTORE_OBJECT.clear,
      action: RESTORE_ACTION.typed,
      cursor: nonce,
    });
    await ctx.surface.openModal({
      customID: id,
      title: "type the guild's name",
      components: [
        label({
          label: "the guild's name",
          description: "the restore refuses to clear anything until this matches exactly.",
          component: textInput({ id, style: 1, required: true, maxLength: 100 }),
        }),
      ],
    });
    return { kind: "reply" };
  };
}

/** the modal's submit: the typed name decides. then the destructive page, with
 *  its own nonce on the confirm button. */
function clearSubmitHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(ctx, failurePage("that confirmation expired", "try again."));
    }
    const targetId = payloadString(nonce.payload, "targetId") ?? "";
    const typed = ctx.surface.values[ctx.id.raw];
    const value = Array.isArray(typed) ? (typed[0] ?? "") : (typed ?? "");

    const targets = await deps.guilds();
    const target = targets.find((guild) => guild.id === targetId);
    const expected = target?.name ?? "";
    if (expected === "" || value.trim() !== expected) {
      return await answer(
        ctx,
        failurePage(
          "that is not the guild's name",
          "the name has to match exactly, so a stray click cannot clear a server.",
          undefined,
          `type \`${expected}\` and press the button again.`,
        ),
      );
    }

    // the destructive page gets its own nonce, and the modal's row is spent.
    await deps.state.delete(ctx.id.cursor);
    const armed = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: RESTORE_SURFACE,
      payload: { action: "clear", targetId, typed: true },
    });
    return await answer(
      ctx,
      clearPage({
        guildId: ctx.id.guild,
        targetName: expected,
        nonce: armed,
        expiresAt: deps.now() + STATE_TTL_MS,
        cancelId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.select,
          action: RESTORE_ACTION.open,
        }),
      }),
    );
  };
}

/** the destructive page's button: the clear runs, then the restore. */
function clearConfirmHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(ctx, failurePage("that confirmation expired", "try again."));
    }
    await deps.state.delete(ctx.id.cursor);
    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage("that confirmation is not yours", "it will not be used."),
      );
    }
    if (payloadString(nonce.payload, "typed") !== "true") {
      return await answer(
        ctx,
        failurePage("the name was not confirmed", "the clear is not armed."),
      );
    }
    const targetId = payloadString(nonce.payload, "targetId") ?? "";
    const job = await deps.jobs.enqueue("restore", {
      guildId: ctx.id.guild,
      requestedBy: ctx.identity.userId,
      payload: {
        backupId: "",
        targetId,
        options: { ...DEFAULT_RESTORE_OPTIONS, clearBefore: true },
      },
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "restore.clear",
      target: targetId,
      detail: { jobId: job.id },
    });
    return await answer(
      ctx,
      jobPage({
        guildId: ctx.id.guild,
        lines: [`job \`${job.id.slice(0, 8)}\` is clearing <#${targetId}> first.`],
        state: "warning",
        refreshId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.job,
          action: RESTORE_ACTION.refresh,
        }),
        cancelId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.job,
          action: RESTORE_ACTION.cancel,
        }),
      }),
    );
  };
}

/** the job page's refresh and cancel. */
function jobHandler(deps: RestoreDeps): Handler {
  return async (ctx) => {
    const jobs = (await listJobsByGuild(deps.db, ctx.id.guild)).filter(
      (job) => job.kind === "restore",
    );
    const latest = jobs[0];
    if (latest === undefined) {
      return await answer(
        ctx,
        jobPage({
          guildId: ctx.id.guild,
          lines: ["no restore has run in this server yet."],
          state: "info",
          refreshId: ctx.id.raw,
          cancelId: ctx.id.raw,
        }),
      );
    }
    if (ctx.id.action === RESTORE_ACTION.cancel) {
      await deps.jobs.cancel(latest.id);
      await deps.audit({
        guildId: ctx.id.guild,
        actorUserId: ctx.identity.userId,
        action: "restore.cancel",
        target: latest.id,
      });
    }
    return await answer(
      ctx,
      jobPage({
        guildId: ctx.id.guild,
        lines: [
          `job \`${latest.id.slice(0, 8)}\` · ${latest.status}`,
          latest.error_code === null
            ? "no error"
            : `**${latest.error_code}** ${latest.error_body ?? ""}`,
        ],
        state:
          latest.status === "failed"
            ? "danger"
            : latest.status === "succeeded"
              ? "success"
              : "info",
        refreshId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.job,
          action: RESTORE_ACTION.refresh,
        }),
        cancelId: restoreCustomId({
          guildId: ctx.id.guild,
          object: RESTORE_OBJECT.job,
          action: RESTORE_ACTION.cancel,
        }),
      }),
    );
  };
}

export function registerRestoreHandlers(router: Router, deps: RestoreDeps): void {
  router.register(RESTORE_SURFACE, RESTORE_ACTION.submit, openHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.confirm, confirmHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.plan, planHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.open, clearHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.typed, clearSubmitHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.clear, clearConfirmHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.refresh, jobHandler(deps));
  router.register(RESTORE_SURFACE, RESTORE_ACTION.cancel, jobHandler(deps));
}
