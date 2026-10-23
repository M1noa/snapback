// what the /users surface needs, the ids it mints, and the export it writes.
//
// the surface shows what this server holds about a person, and it writes those
// records out as json. the tokens never leave the token store: they are not on
// a page and they are not in the export (AGENTS.md rule 10).

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IpStorage } from "../../../config/parse-env.ts";
import { insertPendingExport } from "../../../db/queries/exports.ts";
import { listEventsByGuild, listEventsBySubject } from "../../../db/queries/tracked-events.ts";
import type {
  Database,
  EventSource,
  JsonObject,
  TrackedEventKind,
  TrackedEventRow,
  TrackedSubjectKind,
  VerifyRecordRow,
} from "../../../db/types.ts";
import type { CustomIdSpec } from "../../../discord/interactions/router.ts";
import type { Logger } from "../../../lib/log.ts";
import { EXPORT_TTL_MS } from "../../../services/export/job.ts";
import type { JobHandler, JobRunner } from "../../../services/jobs/runner.ts";
import type { Tracker } from "../../../services/tracking/mirror.ts";
import { customID } from "../../components/row.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { CommandContext, CommandResult } from "../types.ts";

export const USERS_SURFACE = "users";

/** how many records the export writes and the picker offers. */
export const RECORDS_LIMIT = 500;

/** how many events one timeline file holds. the query's own default is a page
 *  size, so the file's cap is stated here instead. */
export const EVENTS_LIMIT = 5000;

/** the scopes this surface writes out. tracking_all is left out on purpose: a
 *  bot-wide file would carry one guild's rows into another guild's folder, and
 *  nothing here is scoped to the instance owner. */
export const EXPORT_SCOPES = ["records", "tracking_user", "tracking_server"] as const;

export type ExportScope = (typeof EXPORT_SCOPES)[number];

/** the two timeline scopes, as the file header names them. */
export type TrackingScope = Exclude<ExportScope, "records">;

export function isExportScope(value: unknown): value is ExportScope {
  return typeof value === "string" && (EXPORT_SCOPES as readonly string[]).includes(value);
}

/** the object slot, one per surface a control lives on. */
export const USERS_OBJECT = {
  record: "record",
  export: "export",
  blacklist: "blacklist",
} as const;

/** the action slot, per object. a stray verb here is a boot failure, not a 404. */
export const USERS_ACTION = {
  /** open a record, or the list of them when the cursor is empty. */
  open: "open",
  /** write the records out. */
  export: "export",
  /** look at the export job again. */
  refresh: "refresh",
  /** the blacklist list, on its own page. */
  blacklist: "blacklist",
} as const;

export interface UsersCustomIdInput {
  readonly guildId: string;
  readonly object: (typeof USERS_OBJECT)[keyof typeof USERS_OBJECT];
  readonly action: string;
  readonly cursor?: string;
}

/** the only builder for this surface. the cursor slot is always written, so every
 *  id is six segments and the router can read every one of them (D4PLAN 9.3). */
export function usersCustomId(input: UsersCustomIdInput): string {
  return customID({
    surface: USERS_SURFACE,
    guild: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.cursor ?? "",
  });
}

/** whether the person is in this server. */
export type MembershipState = "member" | "not_member" | "unknown";

export interface MembershipView {
  readonly state: MembershipState;
  readonly nickname: string | null;
  readonly joinedAt: string | null;
}

/** today's pull counters for one account, in this guild. */
export interface CounterView {
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly restricted: boolean;
  readonly restrictedReason: string | null;
  readonly cooldownUntil: string | null;
}

export interface UsersDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly jobs: JobRunner;
  /** epoch ms. injected so a page's relative timestamps are testable. */
  readonly now: () => number;
  /** the ip storage mode in force. it picks the column and names the export. */
  readonly ipStorage: IpStorage;
  /** where the export files are written. */
  readonly exportDir: string;
  /** re-checked on every interaction: a control rendered for an admin last week
   *  must fail closed today (AGENTS.md rule 8). */
  readonly authorize: (userId: string, guildId: string) => Promise<boolean>;
  /** record the action, so it is traceable (D4PLAN 5.1). */
  readonly audit: (input: {
    guildId: string;
    actorUserId: string;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  /** the records of this guild. scoped to the guild, so another server's record
   *  is not reachable from here. */
  readonly records: (guildId: string, limit: number) => Promise<VerifyRecordRow[]>;
  /** one record, scoped to the guild that owns it. */
  readonly record: (guildId: string, userId: string) => Promise<VerifyRecordRow | null>;
  /** whether the person is in this server. null when it cannot be told. */
  readonly member: (guildId: string, userId: string) => Promise<MembershipView | null>;
  /** the timeline. null when the switch is off, and the mirror skips. */
  readonly tracking: Tracker | null;
}

/** null when the person may act, and the refusal page when they may not. */
export async function refusal(deps: UsersDeps, ctx: CommandContext): Promise<CommandResult | null> {
  if (await deps.authorize(ctx.userId, ctx.guildId)) return null;
  return {
    page: failurePage(
      "not your server's records",
      "only this server's snapback admins can read its records.",
      undefined,
      "ask one of this server's snapback admins, or the instance owner, for access.",
    ),
    ephemeral: true,
  };
}

/** every (surface, action) pair this build produces from a users control. */
export const USERS_SPECS: readonly CustomIdSpec[] = [
  { surface: USERS_SURFACE, action: USERS_ACTION.open },
  { surface: USERS_SURFACE, action: USERS_ACTION.export },
  { surface: USERS_SURFACE, action: USERS_ACTION.refresh },
  { surface: USERS_SURFACE, action: USERS_ACTION.blacklist },
];

/** the address as the storage mode produced it. the hash mode keeps the hash,
 *  the other two keep the encrypted column, which holds the ciphertext or the
 *  plaintext depending on the mode (D4PLAN 14.5). */
export function storedIp(mode: IpStorage, hash: string | null, enc: string | null): string | null {
  return mode === "hash" ? hash : enc;
}

/** what the mode means, in the reader's words. it tells a hash from an address. */
export const IP_MODE_NOTE: Readonly<Record<IpStorage, string>> = {
  hash: "the address is kept as a hash, so it cannot be turned back into an address",
  encrypted: "the address is kept encrypted, so it cannot be read without the key",
  plaintext: "the address is kept as it was written",
};

/** one record, as the export holds it. the token columns are not here at all. */
export interface ExportedRecord {
  readonly record_id: string;
  readonly guild_id: string;
  readonly user_id: string;
  readonly username: string | null;
  readonly global_name: string | null;
  readonly discriminator: string | null;
  readonly avatar_url: string | null;
  readonly email: string | null;
  readonly email_verified: boolean | null;
  readonly locale: string | null;
  readonly mfa_enabled: boolean | null;
  readonly premium_type: number | null;
  readonly flags: number | null;
  readonly connections: readonly unknown[];
  readonly guilds: readonly unknown[];
  readonly relationships: readonly unknown[];
  readonly oauth_scopes: readonly string[];
  readonly oauth_granted_at: string | null;
  readonly oauth_last_checked_at: string | null;
  /** the state of the token, never the token. */
  readonly token_status: string;
  /** the address, in the form the storage mode produced. */
  readonly first_ip: string | null;
  readonly last_ip: string | null;
  readonly ip_history: readonly {
    readonly at: string;
    readonly event: string;
    readonly value: string;
  }[];
  readonly country_code: string | null;
  readonly country_name: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly isp: string | null;
  readonly asn: string | null;
  readonly as_org: string | null;
  readonly ip_type: string | null;
  readonly is_vpn: boolean | null;
  readonly is_proxy: boolean | null;
  readonly is_tor: boolean | null;
  readonly intel_checked_at: string | null;
  readonly fingerprint: unknown;
  readonly referrer: string | null;
  readonly user_agent: string | null;
  readonly revoked_at: string | null;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** the export bundle. the header names the mode, so the reader knows what the
 *  address column holds before they read a row (D4PLAN 17.3). */
export interface RecordsExport {
  readonly schema_version: number;
  readonly kind: "records";
  readonly exported_at: string;
  readonly guild_id: string;
  readonly ip_storage: IpStorage;
  readonly ip_storage_note: string;
  readonly record_count: number;
  readonly records: readonly ExportedRecord[];
}

/** the export bundle for a set of records. the token columns are dropped here,
 *  so no later step can put one back. */
export function buildRecordsExport(
  records: readonly VerifyRecordRow[],
  mode: IpStorage,
  guildId: string,
  exportedAt: string,
): RecordsExport {
  return {
    schema_version: 1,
    kind: "records",
    exported_at: exportedAt,
    guild_id: guildId,
    ip_storage: mode,
    ip_storage_note: IP_MODE_NOTE[mode],
    record_count: records.length,
    records: records.map((row) => exportedRecord(row, mode)),
  };
}

/** one record as the export holds it. the access and refresh tokens, and the
 *  token's expiry, are left out entirely. */
function exportedRecord(row: VerifyRecordRow, mode: IpStorage): ExportedRecord {
  const history = (row.ip_history_json ?? []).flatMap((entry) => {
    const value = entry.hash;
    if (typeof value !== "string") return [];
    return [
      {
        at: typeof entry.at === "string" ? entry.at : "",
        event: typeof entry.event === "string" ? entry.event : "verify",
        value,
      },
    ];
  });

  return {
    record_id: row.record_id,
    guild_id: row.guild_id,
    user_id: row.user_id,
    username: row.username,
    global_name: row.global_name,
    discriminator: row.discriminator,
    avatar_url: row.avatar_url,
    email: row.email,
    email_verified: row.email_verified,
    locale: row.locale,
    mfa_enabled: row.mfa_enabled,
    premium_type: row.premium_type,
    flags: row.flags,
    connections: row.connections_json ?? [],
    guilds: row.guilds_json ?? [],
    relationships: row.relationships_json ?? [],
    oauth_scopes: row.oauth_scopes_json ?? [],
    oauth_granted_at: row.oauth_granted_at,
    oauth_last_checked_at: row.oauth_last_checked_at,
    token_status: row.token_status,
    first_ip: storedIp(mode, row.first_ip_hash, row.first_ip_enc),
    last_ip: storedIp(mode, row.last_ip_hash, row.last_ip_enc),
    ip_history: history,
    country_code: row.country_code,
    country_name: row.country_name,
    city: row.city,
    region: row.region,
    isp: row.isp,
    asn: row.asn,
    as_org: row.as_org,
    ip_type: row.ip_type,
    is_vpn: row.is_vpn,
    is_proxy: row.is_proxy,
    is_tor: row.is_tor,
    intel_checked_at: row.intel_checked_at,
    fingerprint: row.fingerprint_json,
    referrer: row.referrer,
    user_agent: row.user_agent,
    revoked_at: row.revoked_at,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** the file's bytes. the keys keep the order the bundle declares, so two runs
 *  over the same records produce the same text (D4PLAN 17.3). */
export function recordsExportToJson(bundle: RecordsExport): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** just the parts the export job reads, so boot can build it before the whole
 *  surface exists. */
export type UsersExportDeps = Pick<UsersDeps, "db" | "records" | "ipStorage" | "exportDir" | "now">;

/** the job that writes the records out. it records the file with the expiry the
 *  sweeper uses, exactly as the backup export does (D4PLAN 17.4). */
export function createUsersExportJobHandler(deps: UsersExportDeps): JobHandler {
  return async (ctx) => {
    const guildId = ctx.job.guild_id;
    const records = await deps.records(guildId, RECORDS_LIMIT);
    const at = new Date(deps.now());
    const bundle = buildRecordsExport(records, deps.ipStorage, guildId, at.toISOString());
    const json = recordsExportToJson(bundle);

    const dir = join(deps.exportDir, guildId);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, "records.json");
    await writeFile(path, json, "utf8");

    await insertPendingExport(deps.db, {
      export_id: Bun.randomUUIDv7(),
      guild_id: guildId,
      kind: "records",
      scope_json: { recordCount: records.length },
      file_path: path,
      size_bytes: Buffer.byteLength(json, "utf8"),
      created_at: at.toISOString(),
      expires_at: new Date(at.getTime() + EXPORT_TTL_MS).toISOString(),
    });

    ctx.log.info("records export written", { path, records: records.length, guildId });
  };
}

/** whether this guild, or one person in it, has any timeline rows at all. it
 *  reads one row, so the check costs a page of one. */
export async function hasEvents(
  db: Database,
  guildId: string,
  subjectId: string | null,
): Promise<boolean> {
  const rows =
    subjectId === null
      ? await listEventsByGuild(db, guildId, { limit: 1 })
      : await listEventsBySubject(db, guildId, subjectId, { limit: 1 });
  return rows.length > 0;
}

/** one event as the export holds it. the guild is in the header, not on every
 *  row, and there is no message text or attachment here to leave out. */
export interface ExportedEvent {
  readonly event_id: string;
  readonly subject_kind: TrackedSubjectKind;
  readonly subject_id: string;
  readonly kind: TrackedEventKind;
  readonly actor_id: string | null;
  readonly source: EventSource;
  readonly channel_id: string | null;
  readonly at: string;
  readonly recorded_at: string;
  readonly before: JsonObject | null;
  readonly after: JsonObject | null;
  readonly detail: JsonObject | null;
}

/** the timeline file. the header says which scope it holds and whether the cap
 *  cut anything, so a truncated file does not read as a whole one. */
export interface TrackingExport {
  readonly schema_version: number;
  readonly kind: "timeline";
  readonly exported_at: string;
  readonly guild_id: string;
  readonly scope: TrackingScope;
  readonly subject_id: string | null;
  readonly event_count: number;
  readonly truncated: boolean;
  readonly note: string;
  readonly events: readonly ExportedEvent[];
}

export interface TrackingExportInput {
  readonly scope: TrackingScope;
  readonly subjectId: string | null;
  readonly guildId: string;
  /** newest first, as the query returns them. */
  readonly events: readonly TrackedEventRow[];
  readonly truncated: boolean;
  readonly exportedAt: string;
}

export function buildTrackingExport(input: TrackingExportInput): TrackingExport {
  return {
    schema_version: 1,
    kind: "timeline",
    exported_at: input.exportedAt,
    guild_id: input.guildId,
    scope: input.scope,
    subject_id: input.subjectId,
    event_count: input.events.length,
    truncated: input.truncated,
    note: input.truncated
      ? `the newest ${input.events.length} events, oldest first. older events were left out.`
      : "every event this server still holds, oldest first.",
    // the query reads newest first so the page builders can show the latest
    // change. a file is read down the page, so it is written the other way up.
    events: [...input.events].reverse().map((row) => ({
      event_id: row.event_id,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      kind: row.kind,
      actor_id: row.actor_id,
      source: row.source,
      channel_id: row.channel_id,
      at: row.at,
      recorded_at: row.recorded_at,
      before: row.before_json,
      after: row.after_json,
      detail: row.detail_json,
    })),
  };
}

/** the file's bytes, keys in the order the bundle declares. */
export function trackingExportToJson(bundle: TrackingExport): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** just the parts the timeline export job reads. */
export type TrackingExportDeps = Pick<UsersDeps, "db" | "exportDir" | "now">;

/** the job that writes a timeline out. the file name is fixed per scope, so
 *  nothing a command was handed ends up in a path (D4PLAN 17.4). */
export function createTrackingExportJobHandler(deps: TrackingExportDeps): JobHandler {
  return async (ctx) => {
    const guildId = ctx.job.guild_id;
    const payload = (ctx.job.payload_json ?? {}) as { scope?: unknown; subjectId?: unknown };
    const scope: TrackingScope =
      payload.scope === "tracking_user" ? "tracking_user" : "tracking_server";
    const subjectId = scope === "tracking_user" ? String(payload.subjectId ?? "") : null;
    if (scope === "tracking_user" && subjectId === "") {
      throw new Error("SB_EXPORT_NO_SUBJECT: a timeline export names no person to write");
    }

    // one row past the cap says whether the file is complete, without a second
    // count query.
    const rows =
      subjectId === null
        ? await listEventsByGuild(deps.db, guildId, { limit: EVENTS_LIMIT + 1 })
        : await listEventsBySubject(deps.db, guildId, subjectId, { limit: EVENTS_LIMIT + 1 });
    const truncated = rows.length > EVENTS_LIMIT;
    const at = new Date(deps.now());
    const bundle = buildTrackingExport({
      scope,
      subjectId,
      guildId,
      events: truncated ? rows.slice(0, EVENTS_LIMIT) : rows,
      truncated,
      exportedAt: at.toISOString(),
    });
    const json = trackingExportToJson(bundle);

    const dir = join(deps.exportDir, guildId);
    await mkdir(dir, { recursive: true });
    const path = resolve(
      dir,
      scope === "tracking_user" ? "timeline-user.json" : "timeline-server.json",
    );
    await writeFile(path, json, "utf8");

    await insertPendingExport(deps.db, {
      export_id: Bun.randomUUIDv7(),
      guild_id: guildId,
      kind: scope,
      scope_json: {
        subjectId,
        eventCount: bundle.event_count,
        truncated: bundle.truncated,
      },
      file_path: path,
      size_bytes: Buffer.byteLength(json, "utf8"),
      created_at: at.toISOString(),
      expires_at: new Date(at.getTime() + EXPORT_TTL_MS).toISOString(),
    });

    ctx.log.info("timeline export written", {
      path,
      events: bundle.event_count,
      scope,
      truncated,
      guildId,
    });
  };
}

/** the runner holds one handler per job kind, and the three exports share the
 *  "export" kind. this dispatches on the scope. */
export function createExportDispatcher(deps: {
  readonly backup: JobHandler;
  readonly records: JobHandler;
  readonly tracking: JobHandler;
}): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload_json ?? {}) as { scope?: string };
    if (payload.scope === "records") {
      await deps.records(ctx);
      return;
    }
    if (payload.scope === "tracking_user" || payload.scope === "tracking_server") {
      await deps.tracking(ctx);
      return;
    }
    await deps.backup(ctx);
  };
}
