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

import { getAccountCounter } from "../../../db/queries/counters.ts";
import { listPendingExportsByGuild } from "../../../db/queries/exports.ts";
import { listJobsByGuild } from "../../../db/queries/jobs.ts";
import type { VerifyRecordRow } from "../../../db/types.ts";
import { utcDay } from "../../../services/pull/counter.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { AutocompleteChoice, CommandContext, CommandResult, SlashCommand } from "../types.ts";
import {
  type CounterView,
  RECORDS_LIMIT,
  refusal,
  USERS_ACTION,
  USERS_OBJECT,
  type UsersDeps,
  usersCustomId,
} from "./deps.ts";
import { exportPage, recordPage } from "./pages.ts";

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
  choices: [{ name: "the records", value: "records" }],
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

/** true when a job is a records export and not a backup export. */
function isRecordsExport(job: { payload_json: unknown }): boolean {
  if (job.payload_json === null || typeof job.payload_json !== "object") return false;
  return (job.payload_json as { scope?: unknown }).scope === "records";
}

/** how many records the written file holds, when the row says so. */
function recordCountOf(file: { scope_json: unknown } | undefined): number | null {
  if (file === undefined || file.scope_json === null || typeof file.scope_json !== "object") {
    return null;
  }
  const count = (file.scope_json as { recordCount?: unknown }).recordCount;
  return typeof count === "number" ? count : null;
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
      description: "write this server's records out as json",
      options: [SCOPE_OPTION],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        const records = await deps.records(ctx.guildId, RECORDS_LIMIT);
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

        // writing many records outlives an interaction, so it is a job (rule 7).
        const job = await deps.jobs.enqueue("export", {
          guildId: ctx.guildId,
          requestedBy: ctx.userId,
          payload: { scope: "records", guildId: ctx.guildId, fromUserId: "" },
        });
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "users.export",
          target: job.id,
          detail: { records: records.length, ipStorage: deps.ipStorage },
        });

        return {
          page: await exportPageFor(deps, ctx.guildId, ""),
          ephemeral: true,
        };
      },
    },
  ];
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

/** the export's page: the job, and the file it wrote when it has. */
export async function exportPageFor(
  deps: UsersDeps,
  guildId: string,
  fromUserId: string,
): Promise<ReturnType<typeof exportPage>> {
  // the backup export and the records export share the job kind, so the scope
  // in the payload says which one this is.
  const jobs = (await listJobsByGuild(deps.db, guildId)).filter(isRecordsExport);
  const latest = jobs[0];
  const pending = (await listPendingExportsByGuild(deps.db, guildId)).filter(
    (row) => row.kind === "records",
  );
  const file = pending[0];

  return exportPage({
    guildId,
    jobId: latest?.id ?? null,
    jobStatus: latest?.status ?? null,
    jobError: latest?.error_code ?? null,
    recordCount: recordCountOf(file),
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
