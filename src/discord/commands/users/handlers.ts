// the /users controls.
//
// two things happen here: a record is opened, and the records are written out.
// writing many records is a job, so the page that starts it says the file is
// coming rather than pretending it is already there (AGENTS.md rule 7).

import { listJobsByGuild } from "../../../db/queries/jobs.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { Handler, HandlerContext, HandlerResult, Router } from "../../interactions/router.ts";
import {
  RECORDS_LIMIT,
  USERS_ACTION,
  USERS_OBJECT,
  USERS_SURFACE,
  type UsersDeps,
} from "./deps.ts";
import {
  ATTEMPTS_CURSOR,
  attemptsPageFor,
  blacklistPageFor,
  exportPageFor,
  recordPageFor,
} from "./index.ts";

type Container = Parameters<HandlerContext["surface"]["reply"]>[0]["message"];

async function answer(ctx: HandlerContext, message: Container): Promise<HandlerResult> {
  await ctx.surface.reply({ message, ephemeral: true, update: true });
  return { kind: "reply" };
}

/** open a record, or the list of them when the cursor is empty. */
function openHandler(deps: UsersDeps): Handler {
  return async (ctx) => {
    if (ctx.id.object !== USERS_OBJECT.record) {
      return await answer(
        ctx,
        failurePage("that control is not here", "this page has nothing to open."),
      );
    }
    const records = await deps.records(ctx.id.guild, RECORDS_LIMIT);
    // the picker submits the record it names, and the export's back button
    // carries the id in the cursor. the submitted value wins.
    const submitted = ctx.surface.values[ctx.id.raw];
    const picked = Array.isArray(submitted) ? submitted[0] : submitted;
    const userId = typeof picked === "string" && picked !== "" ? picked : ctx.id.cursor;
    // the lookup is scoped to the guild, so a record from another server is
    // not reachable from here (AGENTS.md rule 8).
    const record =
      userId === ""
        ? null
        : (records.find((row) => row.user_id === userId) ??
          (await deps.record(ctx.id.guild, userId)));
    return await answer(ctx, await recordPageFor(deps, ctx.id.guild, records, record));
  };
}

/** the export button. the file is written by the job, so the page says so. */
function exportHandler(deps: UsersDeps): Handler {
  return async (ctx) => {
    const records = await deps.records(ctx.id.guild, RECORDS_LIMIT);
    if (records.length === 0) {
      return await answer(
        ctx,
        failurePage(
          "there is nothing to export",
          "nobody has verified in this server, so there are no records to write.",
          undefined,
          "post the verification panel, and press the button again once someone has.",
        ),
      );
    }

    const job = await deps.jobs.enqueue("export", {
      guildId: ctx.id.guild,
      requestedBy: ctx.identity.userId,
      payload: { scope: "records", guildId: ctx.id.guild, fromUserId: ctx.id.cursor },
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "users.export",
      target: job.id,
      detail: { records: records.length, ipStorage: deps.ipStorage },
    });
    return await answer(ctx, await exportPageFor(deps, ctx.id.guild, ctx.id.cursor));
  };
}

/** the export's refresh: the job may have written the file by now. */
function refreshHandler(deps: UsersDeps): Handler {
  return async (ctx) => {
    // the backup export and the records export share the job kind, so the scope
    // in the payload says which one this is.
    const jobs = (await listJobsByGuild(deps.db, ctx.id.guild)).filter((job) => {
      const payload = job.payload_json;
      if (payload === null || typeof payload !== "object") return false;
      return (payload as { scope?: unknown }).scope === "records";
    });
    const latest = jobs[0];
    const payload = (latest?.payload_json ?? {}) as { fromUserId?: string };
    return await answer(ctx, await exportPageFor(deps, ctx.id.guild, payload.fromUserId ?? ""));
  };
}

/** the blacklist list, asked for again. nothing here acts on an entry. */
function blacklistHandler(deps: UsersDeps): Handler {
  return async (ctx) => {
    if (ctx.id.object !== USERS_OBJECT.blacklist) {
      return await answer(
        ctx,
        failurePage("that control is not here", "this page has nothing to open."),
      );
    }
    if (ctx.id.cursor === ATTEMPTS_CURSOR) {
      return await answer(ctx, await attemptsPageFor(deps, ctx.id.guild));
    }
    return await answer(ctx, await blacklistPageFor(deps, ctx.id.guild));
  };
}

export function registerUsersHandlers(router: Router, deps: UsersDeps): void {
  router.register(USERS_SURFACE, USERS_ACTION.open, openHandler(deps));
  router.register(USERS_SURFACE, USERS_ACTION.export, exportHandler(deps));
  router.register(USERS_SURFACE, USERS_ACTION.refresh, refreshHandler(deps));
  router.register(USERS_SURFACE, USERS_ACTION.blacklist, blacklistHandler(deps));
}
