// queries/verify-records.ts. the records a verification produced (D4PLAN 5.1).
// one row per (guild, user): revoking in one server must not erase another
// server's record, and the owner's list of who removed the app is per guild.
//
// the token columns live here too, but this module only ever moves them as a
// whole row: the token store owns what is in them.

import { oneOf } from "../../lib/validate.ts";
import {
  parseJson,
  type SqlValue,
  stringifyJson,
  toBool,
  toId,
  toNumber,
  toText,
} from "../rows.ts";
import type {
  Database,
  JsonObject,
  TokenStatus,
  VerifyRecordEventRow,
  VerifyRecordRow,
} from "../types.ts";

const COLUMNS =
  "record_id, guild_id, user_id, username, global_name, discriminator, avatar_url, email, email_verified, locale, mfa_enabled, premium_type, flags, connections_json, guilds_json, relationships_json, oauth_scopes_json, oauth_granted_at, oauth_last_checked_at, access_token_enc, refresh_token_enc, token_expires_at, token_status, first_ip_hash, first_ip_enc, last_ip_hash, last_ip_enc, ip_history_json, country_code, country_name, city, region, isp, asn, as_org, ip_type, is_vpn, is_proxy, is_tor, intel_checked_at, fingerprint_json, referrer, user_agent, revoked_at, notes, created_at, updated_at";

// one placeholder per column, in the same order.
const PLACEHOLDERS = COLUMNS.split(", ")
  .map(() => "?")
  .join(", ");

// what a re-verification refreshes. absent on purpose: record_id and created_at
// never change, the first ip is the earliest one seen, and the token columns
// belong to the token store. the intel, fingerprint and note columns are set by
// their own modules and a re-verification must not wipe them.
const REFRESHED = [
  "username",
  "global_name",
  "discriminator",
  "avatar_url",
  "email",
  "email_verified",
  "locale",
  "mfa_enabled",
  "premium_type",
  "flags",
  "connections_json",
  "guilds_json",
  "relationships_json",
  "oauth_scopes_json",
  "oauth_granted_at",
  "oauth_last_checked_at",
  "last_ip_hash",
  "last_ip_enc",
  "ip_history_json",
  "updated_at",
] as const;

const TOKEN_STATUSES = ["valid", "unauthorized", "revoked", "missing"] as const;
const IP_TYPES = ["residential", "hosting", "mobile", "unknown"] as const;
const EVENT_KINDS = [
  "oauth",
  "refresh",
  "revoked",
  "refreshed_ok",
  "refreshed_fail",
  "note",
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// a json array column. a hand-edited cell may hold anything, so only the plain
// objects survive; a broken cell reads as null rather than as a wrong shape.
function toJsonArray(value: SqlValue): JsonObject[] | null {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isJsonObject);
}

function toStringArray(value: SqlValue): string[] | null {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is string => typeof item === "string");
}

function toJsonObject(value: SqlValue): JsonObject | null {
  const parsed = parseJson<unknown>(value);
  return isJsonObject(parsed) ? parsed : null;
}

function toRecordRow(raw: Record<string, SqlValue>): VerifyRecordRow {
  return {
    record_id: toId(raw.record_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    username: toText(raw.username) ?? null,
    global_name: toText(raw.global_name) ?? null,
    discriminator: toText(raw.discriminator) ?? null,
    avatar_url: toText(raw.avatar_url) ?? null,
    email: toText(raw.email) ?? null,
    email_verified: toBool(raw.email_verified) ?? null,
    locale: toText(raw.locale) ?? null,
    mfa_enabled: toBool(raw.mfa_enabled) ?? null,
    premium_type: toNumber(raw.premium_type) ?? null,
    flags: toNumber(raw.flags) ?? null,
    connections_json: toJsonArray(raw.connections_json),
    guilds_json: toJsonArray(raw.guilds_json),
    relationships_json: toJsonArray(raw.relationships_json),
    oauth_scopes_json: toStringArray(raw.oauth_scopes_json),
    oauth_granted_at: toText(raw.oauth_granted_at) ?? null,
    oauth_last_checked_at: toText(raw.oauth_last_checked_at) ?? null,
    access_token_enc: toText(raw.access_token_enc) ?? null,
    refresh_token_enc: toText(raw.refresh_token_enc) ?? null,
    token_expires_at: toText(raw.token_expires_at) ?? null,
    token_status: oneOf(raw.token_status, TOKEN_STATUSES) ?? "missing",
    first_ip_hash: toText(raw.first_ip_hash) ?? null,
    first_ip_enc: toText(raw.first_ip_enc) ?? null,
    last_ip_hash: toText(raw.last_ip_hash) ?? null,
    last_ip_enc: toText(raw.last_ip_enc) ?? null,
    ip_history_json: toJsonArray(raw.ip_history_json),
    country_code: toText(raw.country_code) ?? null,
    country_name: toText(raw.country_name) ?? null,
    city: toText(raw.city) ?? null,
    region: toText(raw.region) ?? null,
    isp: toText(raw.isp) ?? null,
    asn: toText(raw.asn) ?? null,
    as_org: toText(raw.as_org) ?? null,
    ip_type: oneOf(raw.ip_type, IP_TYPES),
    is_vpn: toBool(raw.is_vpn) ?? null,
    is_proxy: toBool(raw.is_proxy) ?? null,
    is_tor: toBool(raw.is_tor) ?? null,
    intel_checked_at: toText(raw.intel_checked_at) ?? null,
    fingerprint_json: toJsonObject(raw.fingerprint_json),
    referrer: toText(raw.referrer) ?? null,
    user_agent: toText(raw.user_agent) ?? null,
    revoked_at: toText(raw.revoked_at) ?? null,
    notes: toText(raw.notes) ?? null,
    created_at: toText(raw.created_at) ?? "",
    updated_at: toText(raw.updated_at) ?? "",
  };
}

function bind(row: VerifyRecordRow): (string | number | boolean | null)[] {
  return [
    row.record_id,
    row.guild_id,
    row.user_id,
    row.username,
    row.global_name,
    row.discriminator,
    row.avatar_url,
    row.email,
    row.email_verified,
    row.locale,
    row.mfa_enabled,
    row.premium_type,
    row.flags,
    stringifyJson(row.connections_json),
    stringifyJson(row.guilds_json),
    stringifyJson(row.relationships_json),
    stringifyJson(row.oauth_scopes_json),
    row.oauth_granted_at,
    row.oauth_last_checked_at,
    row.access_token_enc,
    row.refresh_token_enc,
    row.token_expires_at,
    row.token_status,
    row.first_ip_hash,
    row.first_ip_enc,
    row.last_ip_hash,
    row.last_ip_enc,
    stringifyJson(row.ip_history_json),
    row.country_code,
    row.country_name,
    row.city,
    row.region,
    row.isp,
    row.asn,
    row.as_org,
    row.ip_type,
    row.is_vpn,
    row.is_proxy,
    row.is_tor,
    row.intel_checked_at,
    stringifyJson(row.fingerprint_json),
    row.referrer,
    row.user_agent,
    row.revoked_at,
    row.notes,
    row.created_at,
    row.updated_at,
  ];
}

// the conflict target is (guild_id, user_id), the unique index from the schema.
// a second verification in another guild is a second row, not an overwrite.
export async function upsertRecord(db: Database, row: VerifyRecordRow): Promise<void> {
  const set = REFRESHED.map((column) => `${column} = excluded.${column}`).join(", ");
  await db.run(
    `INSERT INTO verify_records (${COLUMNS}) VALUES (${PLACEHOLDERS})
     ON CONFLICT (guild_id, user_id) DO UPDATE SET ${set}`,
    bind(row),
  );
}

export async function getRecord(
  db: Database,
  guildId: string,
  userId: string,
): Promise<VerifyRecordRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_records WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId],
  );
  const first = rows[0];
  return first === undefined ? null : toRecordRow(first);
}

export async function getRecordById(
  db: Database,
  recordId: string,
): Promise<VerifyRecordRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_records WHERE record_id = ?`,
    [recordId],
  );
  const first = rows[0];
  return first === undefined ? null : toRecordRow(first);
}

// the records of one guild, newest first. the record id breaks a tie, so a
// paged list does not shuffle between two pages.
export async function listRecords(
  db: Database,
  guildId: string,
  limit: number,
): Promise<VerifyRecordRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_records WHERE guild_id = ?
     ORDER BY created_at DESC, record_id DESC LIMIT ?`,
    [guildId, limit],
  );
  return rows.map(toRecordRow);
}

// every record a user has, across guilds. the user id is not a guild id, so a
// user verified in two servers has two rows.
export async function listRecordsForUser(db: Database, userId: string): Promise<VerifyRecordRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_records WHERE user_id = ? ORDER BY created_at`,
    [userId],
  );
  return rows.map(toRecordRow);
}

// the records whose access token has expired and can still be refreshed. a
// record with no refresh token, or one the token store already gave up on, is
// not due: there is nothing to refresh and nothing to learn.
//
// a guild id narrows the sweep to one server, which is what /verify refresh
// does. without one the sweep covers every guild.
export async function listDueRecords(
  db: Database,
  now: string,
  limit: number,
  guildId?: string,
): Promise<VerifyRecordRow[]> {
  const rows =
    guildId === undefined
      ? await db.query<Record<string, SqlValue>>(
          `SELECT ${COLUMNS} FROM verify_records
           WHERE token_expires_at IS NOT NULL AND token_expires_at <= ?
             AND token_status = ? AND refresh_token_enc IS NOT NULL
           ORDER BY token_expires_at LIMIT ?`,
          [now, "valid", limit],
        )
      : await db.query<Record<string, SqlValue>>(
          `SELECT ${COLUMNS} FROM verify_records
           WHERE token_expires_at IS NOT NULL AND token_expires_at <= ?
             AND token_status = ? AND refresh_token_enc IS NOT NULL AND guild_id = ?
           ORDER BY token_expires_at LIMIT ?`,
          [now, "valid", guildId, limit],
        );
  return rows.map(toRecordRow);
}

// the token columns, in one place. the token store owns them; the record write
// in services/verify/records.ts never touches them.
export async function setRecordTokens(
  db: Database,
  recordId: string,
  tokens: {
    readonly accessTokenEnc: string | null;
    readonly refreshTokenEnc: string | null;
    readonly expiresAt: string | null;
    readonly status: TokenStatus;
  },
): Promise<void> {
  await db.run(
    `UPDATE verify_records SET
       access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, token_status = ?
     WHERE record_id = ?`,
    [tokens.accessTokenEnc, tokens.refreshTokenEnc, tokens.expiresAt, tokens.status, recordId],
  );
}

// the last time the token was checked. the refresh sweep owns this one.
export async function setRecordLastChecked(
  db: Database,
  recordId: string,
  at: string,
): Promise<void> {
  await db.run("UPDATE verify_records SET oauth_last_checked_at = ? WHERE record_id = ?", [
    at,
    recordId,
  ]);
}

function toEventRow(raw: Record<string, SqlValue>): VerifyRecordEventRow {
  return {
    record_id: toId(raw.record_id) ?? "",
    at: toText(raw.at) ?? "",
    kind: oneOf(raw.kind, EVENT_KINDS) ?? "note",
    detail_json: toJsonObject(raw.detail_json),
  };
}

// the primary key is (record_id, at, kind), so two events of one kind in the
// same millisecond would collide. the timeline moves forward by a millisecond
// until the slot is free, which also keeps the events in order.
export async function insertRecordEvent(db: Database, row: VerifyRecordEventRow): Promise<void> {
  const at = await freeTimestamp(db, row.record_id, row.at);
  await db.run(
    `INSERT INTO verify_record_events (record_id, "at", kind, detail_json) VALUES (?, ?, ?, ?)`,
    [row.record_id, at, row.kind, stringifyJson(row.detail_json)],
  );
}

async function freeTimestamp(db: Database, recordId: string, at: string): Promise<string> {
  const rows = await db.query<{ at: string | null }>(
    `SELECT MAX("at") AS at FROM verify_record_events WHERE record_id = ?`,
    [recordId],
  );
  const latest = rows[0]?.at ?? null;
  // iso-8601 strings sort as times, so this is a time comparison.
  if (latest === null || latest < at) return at;
  const parsed = Date.parse(latest);
  if (Number.isNaN(parsed)) return at;
  return new Date(parsed + 1).toISOString();
}

export async function listRecordEvents(
  db: Database,
  recordId: string,
): Promise<VerifyRecordEventRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT record_id, "at", kind, detail_json FROM verify_record_events
     WHERE record_id = ? ORDER BY "at"`,
    [recordId],
  );
  return rows.map(toEventRow);
}

// ---- erasing what was captured ------------------------------------------------
//
// the delete path is the only one that removes captured data, and it can remove
// part of a record: the tokens, the address, or the whole row (D4PLAN 8's
// /verify delete scopes).

/** the tokens go, and the record keeps everything else. */
export async function clearRecordTokens(
  db: Database,
  guildId: string,
  userId: string,
): Promise<void> {
  await db.run(
    `UPDATE verify_records SET access_token_enc = NULL, refresh_token_enc = NULL,
       token_status = 'revoked', revoked_at = ?
     WHERE guild_id = ? AND user_id = ?`,
    [new Date().toISOString(), guildId, userId],
  );
}

/** the address goes, in every form it was stored in. */
export async function clearRecordIp(db: Database, guildId: string, userId: string): Promise<void> {
  await db.run(
    `UPDATE verify_records SET first_ip_hash = NULL, first_ip_enc = NULL,
       last_ip_hash = NULL, last_ip_enc = NULL, ip_history_json = NULL
     WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId],
  );
}

/** the whole row, and its events with it. */
export async function deleteRecord(db: Database, guildId: string, userId: string): Promise<void> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT record_id FROM verify_records WHERE guild_id = ? AND user_id = ?",
    [guildId, userId],
  );
  const recordId = toText(rows[0]?.record_id) ?? null;
  if (recordId !== null) {
    await db.run("DELETE FROM verify_record_events WHERE record_id = ?", [recordId]);
  }
  await db.run("DELETE FROM verify_records WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
}
