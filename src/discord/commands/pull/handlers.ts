// the /pull controls.
//
// the confirm button carries a one-time nonce, so a pull only runs when the
// operator who asked for it presses it. the router re-checks access on every
// press, so a control rendered for an admin last week fails closed today
// (AGENTS.md rule 8).

import { getJob } from "../../../db/queries/jobs.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { Handler, HandlerContext, HandlerResult, Router } from "../../interactions/router.ts";
import { PULL_ACTION, PULL_SURFACE, type PullDeps } from "./deps.ts";
import { planPageFor, reportPageFor } from "./index.ts";

type Container = Parameters<HandlerContext["surface"]["reply"]>[0]["message"];

async function answer(ctx: HandlerContext, message: Container): Promise<HandlerResult> {
  await ctx.surface.reply({ message, ephemeral: true, update: true });
  return { kind: "reply" };
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

/** the report again, with a fresh read. */
function refreshHandler(deps: PullDeps): Handler {
  return async (ctx) => {
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

export function registerPullHandlers(router: Router, deps: PullDeps): void {
  router.register(PULL_SURFACE, PULL_ACTION.confirm, confirmHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.back, backHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.cancel, cancelHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.pause, pauseHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.refresh, refreshHandler(deps));
  router.register(PULL_SURFACE, PULL_ACTION.plan, planHandler(deps));
}
