// queries/blacklist-attempts.ts. the verifications that matched a blacklist
// entry (D4PLAN 19.5). insert and read only: an attempt is a record of something
// that happened, so there is no update path.

import { parseJson, type SqlValue, stringifyJson, toBool, toId, toText } from "../rows.ts";
import type { BlacklistAttemptRow, Database, JsonObject } from "../types.ts";

const COLUMNS =
  'attempt_id, guild_id, user_id, username, global_name, status, refusal_reason, ip_mode, ip_hash, asn, as_org, isp, country_code, country_name, ip_type, is_vpn, is_proxy, is_tor, is_hosting, matches_json, signals_json, fingerprint_json, device, "at", recorded_at';

const PLACEHOLDERS = COLUMNS.split(", ")
  .map(() => "?")
  .join(", ");

const DEFAULT_LIMIT = 25;

function json<T>(value: SqlValue): T | null {
  return value === null || value === undefined ? null : parseJson<T>(value);
}

function toAttemptRow(raw: Record<string, SqlValue>): BlacklistAttemptRow {
  return {
    attempt_id: toId(raw.attempt_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    username: toText(raw.username) ?? null,
    global_name: toText(raw.global_name) ?? null,
    status: toText(raw.status) ?? "",
    refusal_reason: toText(raw.refusal_reason) ?? null,
    ip_mode: toText(raw.ip_mode) ?? "hash",
    ip_hash: toText(raw.ip_hash) ?? null,
    asn: toText(raw.asn) ?? null,
    as_org: toText(raw.as_org) ?? null,
    isp: toText(raw.isp) ?? null,
    country_code: toText(raw.country_code) ?? null,
    country_name: toText(raw.country_name) ?? null,
    ip_type: toText(raw.ip_type) ?? null,
    is_vpn: toBool(raw.is_vpn) ?? null,
    is_proxy: toBool(raw.is_proxy) ?? null,
    is_tor: toBool(raw.is_tor) ?? null,
    is_hosting: toBool(raw.is_hosting) ?? null,
    matches_json: json<JsonObject[]>(raw.matches_json),
    signals_json: json<JsonObject>(raw.signals_json),
    fingerprint_json: json<JsonObject>(raw.fingerprint_json),
    device: toText(raw.device) ?? null,
    at: toText(raw.at) ?? "",
    recorded_at: toText(raw.recorded_at) ?? "",
  };
}

export async function insertBlacklistAttempt(
  db: Database,
  row: BlacklistAttemptRow,
): Promise<void> {
  await db.run(`INSERT INTO blacklist_attempts (${COLUMNS}) VALUES (${PLACEHOLDERS})`, [
    row.attempt_id,
    row.guild_id,
    row.user_id,
    row.username,
    row.global_name,
    row.status,
    row.refusal_reason,
    row.ip_mode,
    row.ip_hash,
    row.asn,
    row.as_org,
    row.isp,
    row.country_code,
    row.country_name,
    row.ip_type,
    row.is_vpn,
    row.is_proxy,
    row.is_tor,
    row.is_hosting,
    stringifyJson(row.matches_json),
    stringifyJson(row.signals_json),
    stringifyJson(row.fingerprint_json),
    row.device,
    row.at,
    row.recorded_at,
  ]);
}

/** newest first. one guild's attempts, because the list it matched is that
 *  guild's list. */
export async function listBlacklistAttempts(
  db: Database,
  guildId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<BlacklistAttemptRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM blacklist_attempts WHERE guild_id = ? ORDER BY "at" DESC, attempt_id DESC LIMIT ?`,
    [guildId, limit],
  );
  return rows.map(toAttemptRow);
}

export async function countBlacklistAttempts(db: Database, guildId: string): Promise<number> {
  const rows = await db.query<{ n: bigint }>(
    "SELECT COUNT(*) AS n FROM blacklist_attempts WHERE guild_id = ?",
    [guildId],
  );
  return Number(rows[0]?.n ?? 0);
}
