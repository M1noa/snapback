// services/export/records.ts
// the records export (D4PLAN 17.3): every record of one guild, as json, and
// the flat subset of it as csv.
//
// a token never reaches this file. the serialiser reads the columns it names,
// and the token columns are not among them, so there is nothing to redact and
// no redaction header to explain. the ip is read from the column the storage
// mode names, so it comes out in the form it went in, and the bundle header
// says which form that is.

import type { IpStorage } from "../../config/parse-env.ts";
import { listRecords } from "../../db/queries/verify-records.ts";
import type { Database, JsonObject, VerifyRecordRow } from "../../db/types.ts";

/** the schema version of the records bundle. */
export const RECORDS_SCHEMA_VERSION = 1;

/** the csv columns, one per field of a record row, in the row's own order. */
export const RECORD_CSV_COLUMNS = [
  "user_id",
  "username",
  "global_name",
  "email",
  "email_verified",
  "scopes",
  "token_status",
  "granted_at",
  "last_checked_at",
  "ip",
  "country_code",
  "country_name",
  "isp",
  "as_org",
  "ip_type",
  "connections",
  "guilds",
  "fingerprint",
  "revoked_at",
] as const;

/** every record of one guild, with the mode named in the header. */
export interface RecordsBundle {
  readonly schema_version: number;
  readonly exported_at: string;
  /** the ip storage mode in force, so a reader knows what they are looking at. */
  readonly ip_storage: IpStorage;
  readonly guild_id: string;
  readonly records: readonly RecordExportRow[];
}

/**
 * one record as the export holds it. the access token, the refresh token and
 * the token's expiry are not fields of this row: the serialiser never reads
 * those columns, so they cannot end up in a file.
 */
export interface RecordExportRow {
  readonly user_id: string;
  readonly username: string | null;
  readonly global_name: string | null;
  readonly email: string | null;
  readonly email_verified: boolean | null;
  readonly scopes: readonly string[];
  readonly token_status: string;
  readonly granted_at: string | null;
  readonly last_checked_at: string | null;
  /** the address in the mode's form, or null when it was not captured. */
  readonly ip: string | null;
  readonly country_code: string | null;
  readonly country_name: string | null;
  readonly isp: string | null;
  readonly as_org: string | null;
  readonly ip_type: string | null;
  readonly connections: readonly string[];
  readonly guilds: readonly string[];
  readonly fingerprint: unknown;
  readonly revoked_at: string | null;
}

export interface RecordsExportOptions {
  /** the clock, injected so the exported_at is not clock-dependent (D4PLAN 20). */
  readonly now?: () => string;
  /**
   * the ip storage mode in force. the caller passes the configured mode
   * (env.privacy.ipStorage): the header names it, and the ip is read from the
   * column that mode fills. the default is the hash mode, which discloses the
   * least when the caller forgets.
   */
  readonly ipStorage?: IpStorage;
}

/** every record of one guild, as the export holds them. */
export async function buildRecordsExport(
  db: Database,
  guildId: string,
  options: RecordsExportOptions = {},
): Promise<RecordsBundle> {
  const now = options.now ?? (() => new Date().toISOString());
  const mode = options.ipStorage ?? "hash";
  const rows = await listAllRecords(db, guildId);
  return {
    schema_version: RECORDS_SCHEMA_VERSION,
    exported_at: now(),
    ip_storage: mode,
    guild_id: guildId,
    records: rows.map((row) => recordToExportRow(row, mode)),
  };
}

/**
 * every record of one guild. the query module takes a limit, so the limit
 * grows until the rows come back short: a guild with more records than the
 * first page still gets all of them.
 */
export async function listAllRecords(db: Database, guildId: string): Promise<VerifyRecordRow[]> {
  let limit = 500;
  for (;;) {
    const rows = await listRecords(db, guildId, limit);
    if (rows.length < limit) return rows;
    limit *= 4;
  }
}

/** the bundle as json. the key order is the interface's, so two runs over the
 *  same records produce the same text. */
export function recordsToJson(bundle: RecordsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * the flat subset, for a spreadsheet. the multi-valued fields are joined with a
 * semicolon, the header says so, and a value holding a comma or a quote is
 * quoted the csv way. the first line is a comment, so the mode and the
 * convention travel with the file.
 */
export function recordsToCsv(bundle: RecordsBundle): string {
  const lines = [
    `# snapback records export. ip_storage: ${bundle.ip_storage}. multi-valued fields (scopes, connections, guilds) are semicolon-joined. an empty cell means the value was not captured.`,
    RECORD_CSV_COLUMNS.join(","),
    ...bundle.records.map(csvRow),
  ];
  return `${lines.join("\n")}\n`;
}

// one record as a csv line. the cells are in the column order, so the header
// and the row cannot drift apart.
function csvRow(row: RecordExportRow): string {
  return [
    row.user_id,
    row.username ?? "",
    row.global_name ?? "",
    row.email ?? "",
    row.email_verified === null ? "" : String(row.email_verified),
    row.scopes.join(";"),
    row.token_status,
    row.granted_at ?? "",
    row.last_checked_at ?? "",
    row.ip ?? "",
    row.country_code ?? "",
    row.country_name ?? "",
    row.isp ?? "",
    row.as_org ?? "",
    row.ip_type ?? "",
    row.connections.join(";"),
    row.guilds.join(";"),
    fingerprintText(row.fingerprint),
    row.revoked_at ?? "",
  ]
    .map(csvCell)
    .join(",");
}

// a cell is quoted only when it has to be, and a quote inside it is doubled.
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

// the fingerprint is a json blob, so its text is json. an empty cell means it
// was never captured.
function fingerprintText(fingerprint: unknown): string {
  if (fingerprint === null || fingerprint === undefined) return "";
  return JSON.stringify(fingerprint);
}

// one record as the export holds it. the token columns are not read here, so
// they cannot reach the file.
export function recordToExportRow(row: VerifyRecordRow, mode: IpStorage): RecordExportRow {
  return {
    user_id: row.user_id,
    username: row.username,
    global_name: row.global_name,
    email: row.email,
    email_verified: row.email_verified,
    scopes: row.oauth_scopes_json ?? [],
    token_status: row.token_status,
    granted_at: row.oauth_granted_at,
    last_checked_at: row.oauth_last_checked_at,
    ip: storedIp(mode, row.last_ip_hash, row.last_ip_enc),
    country_code: row.country_code,
    country_name: row.country_name,
    isp: row.isp,
    as_org: row.as_org,
    ip_type: row.ip_type,
    connections: (row.connections_json ?? []).map(connectionText),
    guilds: (row.guilds_json ?? []).map(guildText),
    fingerprint: row.fingerprint_json,
    revoked_at: row.revoked_at,
  };
}

// the address as the storage mode produced it. the hash mode keeps the hash,
// the other two keep the encrypted column, which holds the ciphertext or the
// plain address depending on the mode (D4PLAN 14.5).
function storedIp(mode: IpStorage, hash: string | null, enc: string | null): string | null {
  return mode === "hash" ? hash : enc;
}

// a connection is one string, so the csv can join them. the provider and the
// account name are what a reader needs, so both are in it.
function connectionText(entry: JsonObject): string {
  const type = text(entry.type);
  const name = text(entry.name);
  if (type !== "" && name !== "") return `${type}:${name}`;
  return name || text(entry.id) || type;
}

// a guild is one string, and the id is what identifies it.
function guildText(entry: JsonObject): string {
  return text(entry.id) || text(entry.name);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
