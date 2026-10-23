// /users (D4PLAN 8, 17.3): lookup and export.
//
// lookup shows what this server holds about a person. export writes those
// records out as json, and it is a job: writing many records outlives an
// interaction (AGENTS.md rule 7).
//
// the export never contains a token. the access and refresh tokens live in the
// token store and the export does not read them, so there is nothing to redact
// (D4PLAN 17.3). the address appears in the form the storage mode produced,
// and the header names the mode so a reader can tell a hash from an address.

import {
  countBlacklistAttempts,
  listBlacklistAttempts,
} from "../../../db/queries/blacklist-attempts.ts";
import { getAccountCounter } from "../../../db/queries/counters.ts";
import { listPendingExportsByGuild } from "../../../db/queries/exports.ts";
import { listJobsByGuild } from "../../../db/queries/jobs.ts";
import type { VerifyRecordRow } from "../../../db/types.ts";
import { boundedText, oneOf } from "../../../lib/validate.ts";
import { utcDay } from "../../../services/pull/counter.ts";
import { mirror } from "../../../services/tracking/mirror.ts";
import {
  addEntry,
  BLACKLIST_KINDS,
  isValidEntryValue,
  listEntries,
  removeEntry,
} from "../../../services/verify/blacklist.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { AutocompleteChoice, CommandContext, CommandResult, SlashCommand } from "../types.ts";
import {
  type CounterView,
  type ExportScope,
  hasEvents,
  isExportScope,
  RECORDS_LIMIT,
  refusal,
  USERS_ACTION,
  USERS_OBJECT,
  type UsersDeps,
  usersCustomId,
} from "./deps.ts";
import { ATTEMPT_LIST_SIZE, attemptsPage, blacklistPage, exportPage, recordPage } from "./pages.ts";

const GROUP = "users";

const USER_OPTION: CommandOption = {
  name: "user",
  description: "the person to look up, by id or by name",
  type: OPTION_TYPE.string,
  required: true,
  autocomplete: true,
};

const SCOPE_OPTION: CommandOption = {
  name: "scope",
  description: "what to write out",
  type: OPTION_TYPE.string,
  required: false,
  choices: [
    { name: "the records", value: "records" },
    { name: "this server's timeline", value: "tracking_server" },
    { name: "one person's timeline", value: "tracking_user" },
    { name: "every server's timeline (owner only)", value: "tracking_all" },
  ],
};

/** only read when the scope is one person's timeline. */
const EXPORT_USER_OPTION: CommandOption = {
  name: "user",
  description: "the person whose timeline to write, by id or by name",
  type: OPTION_TYPE.string,
  required: false,
  autocomplete: true,
};

const BLACKLIST_ACTION_OPTION: CommandOption = {
  name: "action",
  description: "what to do with the list",
  type: OPTION_TYPE.string,
  required: true,
  choices: [
    { name: "list the entries", value: "list" },
    { name: "the attempts that hit the list", value: "attempts" },
    { name: "add an entry", value: "add" },
    { name: "remove an entry", value: "remove" },
  ],
};

const BLACKLIST_KIND_OPTION: CommandOption = {
  name: "kind",
  description: "what the value is",
  type: OPTION_TYPE.string,
  required: false,
  choices: [
    { name: "a user id", value: "user_id" },
    { name: "an address hash", value: "ip_hash" },
    { name: "an asn", value: "asn" },
  ],
};

const BLACKLIST_VALUE_OPTION: CommandOption = {
  name: "value",
  description: "the value itself",
  type: OPTION_TYPE.string,
  required: false,
};

/** the choices for the "user" option: this guild's records, matched on the id
 *  and on the name. an id is never typed by hand (AGENTS.md quality of life). */
async function recordChoices(
  deps: UsersDeps,
  guildId: string,
  value: string,
): Promise<AutocompleteChoice[]> {
  const records = await deps.records(guildId, RECORDS_LIMIT);
  const needle = value.trim().toLowerCase();
  return records
    .filter((row) => {
      if (needle === "") return true;
      const name = (row.username ?? "").toLowerCase();
      const global = (row.global_name ?? "").toLowerCase();
      return row.user_id.startsWith(needle) || name.includes(needle) || global.includes(needle);
    })
    .slice(0, 25)
    .map((row) => ({
      name: `${row.username ?? "unknown"} ${row.user_id}`.slice(0, 100),
      value: row.user_id,
    }));
}

/** the record the operator named: by id when it is one, by name otherwise. */
async function resolveRecord(
  deps: UsersDeps,
  guildId: string,
  wanted: string,
  records: readonly VerifyRecordRow[],
): Promise<VerifyRecordRow | null> {
  if (/^\d+$/.test(wanted)) {
    // an id is only ever looked up inside this guild.
    return await deps.record(guildId, wanted);
  }
  const needle = wanted.toLowerCase();
  return (
    records.find(
      (row) =>
        (row.username ?? "").toLowerCase() === needle ||
        (row.global_name ?? "").toLowerCase() === needle,
    ) ??
    records.find(
      (row) =>
        (row.username ?? "").toLowerCase().includes(needle) ||
        (row.global_name ?? "").toLowerCase().includes(needle),
    ) ??
    null
  );
}

/** today's pull counters for one account in this guild. */
async function countersFor(
  deps: UsersDeps,
  guildId: string,
  userId: string,
): Promise<CounterView | null> {
  const day = utcDay(new Date(deps.now()));
  const counter = await getAccountCounter(deps.db, userId, guildId, day);
  if (counter === null) return null;
  return {
    attempts: counter.attempts,
    successes: counter.successes,
    failures: counter.failures,
    restricted: counter.restricted,
    restrictedReason: counter.restricted_reason,
    cooldownUntil: counter.cooldown_until,
  };
}

/** the scope a job was enqueued under, when it is one of this surface's. a
 *  backup export has no scope, so it reads as null and is skipped. */
function scopeOf(payload: unknown): ExportScope | null {
  if (payload === null || typeof payload !== "object") return null;
  const scope = (payload as { scope?: unknown }).scope;
  return isExportScope(scope) ? scope : null;
}

/** what the written file says about itself, when it says anything. */
interface FileFacts {
  readonly count: number | null;
  readonly truncated: boolean;
  readonly subjectId: string | null;
}

function fileFacts(file: { scope_json: unknown } | undefined): FileFacts {
  if (file === undefined || file.scope_json === null || typeof file.scope_json !== "object") {
    return { count: null, truncated: false, subjectId: null };
  }
  const row = file.scope_json as {
    recordCount?: unknown;
    eventCount?: unknown;
    truncated?: unknown;
    subjectId?: unknown;
  };
  const count =
    typeof row.recordCount === "number"
      ? row.recordCount
      : typeof row.eventCount === "number"
        ? row.eventCount
        : null;
  return {
    count,
    truncated: row.truncated === true,
    subjectId: typeof row.subjectId === "string" && row.subjectId !== "" ? row.subjectId : null,
  };
}

/** every /users subcommand, one group. */
export function usersCommands(deps: UsersDeps): SlashCommand[] {
  return [
    {
      group: GROUP,
      subcommand: "lookup",
      description: "what this server holds about a person",
      options: [USER_OPTION],
      async autocomplete(ctx) {
        return await recordChoices(deps, ctx.guildId, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        const wanted = String(ctx.options.user ?? "").trim();
        const records = await deps.records(ctx.guildId, RECORDS_LIMIT);
        const record = await resolveRecord(deps, ctx.guildId, wanted, records);
        if (record === null) {
          return {
            page: failurePage(
              "no such record",
              "that person has not verified in this server, so there is nothing here about them.",
              undefined,
              "pick a name from the list, or run `/users lookup` again.",
            ),
            ephemeral: true,
          };
        }

        return {
          page: await recordPageFor(deps, ctx.guildId, records, record),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "export",
      description: "write the records or the timeline out as json",
      options: [SCOPE_OPTION, EXPORT_USER_OPTION],
      async autocomplete(ctx) {
        // the person is the only free field here. the scope is a fixed list.
        if (ctx.option !== "user") return [];
        return await recordChoices(deps, ctx.guildId, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        const scope: ExportScope = isExportScope(ctx.options.scope) ? ctx.options.scope : "records";

        // the whole-instance file carries every guild's rows at once, so it is the
        // owner's alone. a guild admin asking for it fails here, before a job exists.
        if (scope === "tracking_all" && ctx.userId !== deps.ownerId) {
          return {
            page: failurePage(
              "every server is not yours to read",
              "this file holds every server's timeline at once, and only the instance owner may write it.",
              undefined,
              "export this server's timeline instead.",
            ),
            ephemeral: true,
          };
        }

        const records = await deps.records(ctx.guildId, RECORDS_LIMIT);
        const wanted = String(ctx.options.user ?? "").trim();
        let subjectId: string | null = null;

        if (scope === "records") {
          if (records.length === 0) {
            return {
              page: failurePage(
                "there is nothing to export",
                "nobody has verified in this server, so there are no records to write.",
                undefined,
                "post the verification panel, and run this again once someone has.",
              ),
              ephemeral: true,
            };
          }
        } else if (scope === "tracking_user") {
          // one person's timeline names a person, so it needs one.
          if (wanted === "") {
            return {
              page: failurePage(
                "no one to write",
                "a person's timeline is written for one person, and this run named nobody.",
                undefined,
                "run this again and pick a name from the `user` list.",
              ),
              ephemeral: true,
            };
          }
          const record = await resolveRecord(deps, ctx.guildId, wanted, records);
          if (record === null) {
            return {
              page: failurePage(
                "no such record",
                "that person has not verified in this server, so there is no timeline about them here.",
                undefined,
                "pick a name from the `user` list, or export this server's timeline instead.",
              ),
              ephemeral: true,
            };
          }
          if (!(await hasEvents(deps.db, ctx.guildId, record.user_id))) {
            return {
              page: failurePage(
                "there is nothing to export",
                "this server has seen no change for that person yet, so their timeline is empty.",
                undefined,
                "export this server's timeline instead, or run this again after a change.",
              ),
              ephemeral: true,
            };
          }
          subjectId = record.user_id;
        } else if (scope === "tracking_all") {
          // no guild filter: the owner's file reads the whole table.
          if (!(await hasEvents(deps.db, null, null))) {
            return {
              page: failurePage(
                "there is nothing to export",
                "no server has recorded a change yet, so the instance timeline is empty.",
                undefined,
                "leave tracking on somewhere and run this again after a change or two.",
              ),
              ephemeral: true,
            };
          }
        } else if (!(await hasEvents(deps.db, ctx.guildId, null))) {
          return {
            page: failurePage(
              "there is nothing to export",
              "this server has not changed anything worth recording yet, so its timeline is empty.",
              undefined,
              "leave tracking on and run this again after a change or two.",
            ),
            ephemeral: true,
          };
        }

        // writing the whole file outlives an interaction, so it is a job (rule 7).
        const job = await deps.jobs.enqueue("export", {
          guildId: ctx.guildId,
          requestedBy: ctx.userId,
          payload: { scope, guildId: ctx.guildId, subjectId: subjectId ?? "", fromUserId: "" },
        });
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "users.export",
          target: job.id,
          detail: {
            scope,
            subjectId,
            records: records.length,
            ipStorage: deps.ipStorage,
          },
        });

        return {
          page: await exportPageFor(deps, ctx.guildId, ""),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "blacklist",
      description: "the entries you want to look at, for this server",
      options: [BLACKLIST_ACTION_OPTION, BLACKLIST_KIND_OPTION, BLACKLIST_VALUE_OPTION],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        const action = String(ctx.options.action ?? "list");
        if (action === "list") {
          return { page: await blacklistPageFor(deps, ctx.guildId), ephemeral: true };
        }
        // the attempts need neither a kind nor a value, so this comes before the
        // validation that would demand them.
        if (action === "attempts") {
          return { page: await attemptsPageFor(deps, ctx.guildId), ephemeral: true };
        }

        const kind = oneOf(ctx.options.kind, BLACKLIST_KINDS);
        const value = boundedText(ctx.options.value, 256);
        if (kind === null || value === null) {
          return {
            page: failurePage(
              "an entry needs a kind and a value",
              "the kind says what the value is: a user id, an address hash, or an asn.",
              undefined,
              "run `/users blacklist action:add kind:user_id value:123456789012345678`.",
            ),
            ephemeral: true,
          };
        }
        if (!isValidEntryValue(kind, value)) {
          return {
            page: failurePage(
              "that value does not fit the kind",
              `a ${kind} entry does not hold that value.`,
              undefined,
              kind === "user_id"
                ? "a user id is the digits of a discord id, with no @ and no name."
                : "check the value against the kind and run it again.",
            ),
            ephemeral: true,
          };
        }

        if (action === "add") {
          const result = await addEntry(
            { db: deps.db, now: deps.now },
            {
              guildId: ctx.guildId,
              kind,
              value,
              addedBy: ctx.userId,
              reason: null,
            },
          );
          await deps.audit({
            guildId: ctx.guildId,
            actorUserId: ctx.userId,
            action: "users.blacklist.added",
            target: `${kind}:${value}`,
            detail: { kind, value, added: result.added },
          });
          if (result.added) {
            await mirror(deps.tracking, deps.log, {
              guildId: ctx.guildId,
              subjectKind: kind === "user_id" ? "user" : "guild",
              subjectId: kind === "user_id" ? value : ctx.guildId,
              kind: "blacklist_add",
              actorId: ctx.userId,
              source: "admin",
              detail: { kind, value },
            });
          }
          return {
            page: await blacklistPageFor(
              deps,
              ctx.guildId,
              result.added ? `added the ${kind} entry.` : `that ${kind} was already on the list.`,
            ),
            ephemeral: true,
          };
        }

        const removed = await removeEntry(
          { db: deps.db, now: deps.now },
          { guildId: ctx.guildId, kind, value },
        );
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "users.blacklist.removed",
          target: `${kind}:${value}`,
          detail: { kind, value, removed },
        });
        if (removed) {
          await mirror(deps.tracking, deps.log, {
            guildId: ctx.guildId,
            subjectKind: kind === "user_id" ? "user" : "guild",
            subjectId: kind === "user_id" ? value : ctx.guildId,
            kind: "blacklist_remove",
            actorId: ctx.userId,
            source: "admin",
            detail: { kind, value },
          });
        }
        return {
          page: await blacklistPageFor(
            deps,
            ctx.guildId,
            removed ? `removed the ${kind} entry.` : `there was no ${kind} entry with that value.`,
          ),
          ephemeral: true,
        };
      },
    },
  ];
}

/** the cursor that tells the blacklist control to show the attempts, not the entries. */
export const ATTEMPTS_CURSOR = "attempts";

/** the blacklist page for this server. the note says what just happened. */
export async function blacklistPageFor(
  deps: UsersDeps,
  guildId: string,
  note: string | null = null,
): Promise<ReturnType<typeof blacklistPage>> {
  const entries = await listEntries({ db: deps.db, now: deps.now }, guildId);
  return blacklistPage({
    guildId,
    entries,
    note,
    refreshId: usersCustomId({
      guildId,
      object: USERS_OBJECT.blacklist,
      action: USERS_ACTION.blacklist,
    }),
    openAttemptsId: usersCustomId({
      guildId,
      object: USERS_OBJECT.blacklist,
      action: USERS_ACTION.blacklist,
      cursor: ATTEMPTS_CURSOR,
    }),
  });
}

/** what the list matched, newest first. one page, with the total above it. */
export async function attemptsPageFor(
  deps: UsersDeps,
  guildId: string,
): Promise<ReturnType<typeof attemptsPage>> {
  const [attempts, total] = await Promise.all([
    listBlacklistAttempts(deps.db, guildId, ATTEMPT_LIST_SIZE),
    countBlacklistAttempts(deps.db, guildId),
  ]);
  return attemptsPage({
    guildId,
    attempts,
    total,
    backId: usersCustomId({
      guildId,
      object: USERS_OBJECT.blacklist,
      action: USERS_ACTION.blacklist,
    }),
    refreshId: usersCustomId({
      guildId,
      object: USERS_OBJECT.blacklist,
      action: USERS_ACTION.blacklist,
      cursor: ATTEMPTS_CURSOR,
    }),
  });
}

/** the record page, for one record or for the list of them. the handlers and
 *  the command both come through here, so the page is the same everywhere. */
export async function recordPageFor(
  deps: UsersDeps,
  guildId: string,
  records: readonly VerifyRecordRow[],
  record: VerifyRecordRow | null,
): Promise<ReturnType<typeof recordPage>> {
  const membership = record === null ? null : await deps.member(guildId, record.user_id);
  const counters = record === null ? null : await countersFor(deps, guildId, record.user_id);
  return recordPage({
    guildId,
    record,
    records,
    membership,
    counters,
    ipStorage: deps.ipStorage,
    selectId: usersCustomId({
      guildId,
      object: USERS_OBJECT.record,
      action: USERS_ACTION.open,
    }),
    exportId: usersCustomId({
      guildId,
      object: USERS_OBJECT.record,
      action: USERS_ACTION.export,
      cursor: record?.user_id ?? "",
    }),
  });
}

/** which export this page is about. the newest job that names one of this
 *  surface's scopes wins; with no such job, the newest pending file's kind; and
 *  with neither, the records. a backup export names no scope, so it never wins. */
async function scopeFor(deps: UsersDeps, guildId: string): Promise<ExportScope> {
  for (const job of await listJobsByGuild(deps.db, guildId)) {
    const scope = scopeOf(job.payload_json);
    if (scope !== null) return scope;
  }
  for (const row of await listPendingExportsByGuild(deps.db, guildId)) {
    if (isExportScope(row.kind)) return row.kind;
  }
  return "records";
}

/** the export's page: the job, and the file it wrote when it has. */
export async function exportPageFor(
  deps: UsersDeps,
  guildId: string,
  fromUserId: string,
): Promise<ReturnType<typeof exportPage>> {
  // the three exports share the job kind, so the scope comes from whichever of
  // them ran last rather than from the kind (D4PLAN 17.3).
  const scope = await scopeFor(deps, guildId);
  const jobs = (await listJobsByGuild(deps.db, guildId)).filter(
    (job) => scopeOf(job.payload_json) === scope,
  );
  const latest = jobs[0];
  const pending = (await listPendingExportsByGuild(deps.db, guildId)).filter(
    (row) => row.kind === scope,
  );
  const file = pending[0];
  const facts = fileFacts(file);

  return exportPage({
    guildId,
    scope,
    subjectId: facts.subjectId,
    count: facts.count,
    truncated: facts.truncated,
    jobId: latest?.id ?? null,
    jobStatus: latest?.status ?? null,
    jobError: latest?.error_code ?? null,
    filePath: file?.file_path ?? null,
    fileBytes: file?.size_bytes ?? null,
    ipStorage: deps.ipStorage,
    backId: usersCustomId({
      guildId,
      object: USERS_OBJECT.record,
      action: USERS_ACTION.open,
      cursor: fromUserId,
    }),
    refreshId: usersCustomId({
      guildId,
      object: USERS_OBJECT.export,
      action: USERS_ACTION.refresh,
    }),
  });
}
