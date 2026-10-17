// queries/backups.ts. one sealed snapshot of a guild per row, plus the asset
// urls and the settings blobs. self_check_json stays null until the backup is
// sealed (D4PLAN 11.6), so a null there is also how "still open" is read.

import { type GuildSettings, readGuildSettings } from "../../config/defaults.ts";
import {
  parseJson,
  type SqlValue,
  stringifyJson,
  toId,
  toNumber,
  toSelfCheck,
  toText,
} from "../rows.ts";
import type { BackupKind, BackupRow, Database, JsonObject, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "guild_id",
  "label",
  "kind",
  "guild_name",
  "icon_url",
  "banner_url",
  "splash_url",
  "discovery_splash_url",
  "owner_user_id",
  "member_count",
  "message_count",
  "channel_count",
  "role_count",
  "size_bytes",
  "schema_version",
  "guild_settings_json",
  "onboarding_json",
  "welcome_screen_json",
  "widget_json",
  "afk_json",
  "self_check_json",
  "created_at",
  "created_by",
] as const;

// column names are code literals; every value below is bound.
const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");
const SET = COLUMNS.slice(1)
  .map((column) => `${column} = ?`)
  .join(", ");

function toSettings(value: SqlValue): GuildSettings | null {
  return value === null || value === undefined
    ? null
    : readGuildSettings(parseJson<unknown>(value));
}

function toBackupRow(raw: Record<string, SqlValue>): BackupRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    label: toText(raw.label) ?? null,
    kind: toText(raw.kind) as BackupKind,
    guild_name: toText(raw.guild_name) ?? null,
    icon_url: toText(raw.icon_url) ?? null,
    banner_url: toText(raw.banner_url) ?? null,
    splash_url: toText(raw.splash_url) ?? null,
    discovery_splash_url: toText(raw.discovery_splash_url) ?? null,
    owner_user_id: toId(raw.owner_user_id) ?? null,
    member_count: toNumber(raw.member_count) ?? 0,
    message_count: toNumber(raw.message_count) ?? 0,
    channel_count: toNumber(raw.channel_count) ?? 0,
    role_count: toNumber(raw.role_count) ?? 0,
    size_bytes: toNumber(raw.size_bytes) ?? 0,
    schema_version: toNumber(raw.schema_version) ?? 0,
    guild_settings_json: toSettings(raw.guild_settings_json),
    onboarding_json: parseJson<JsonObject>(raw.onboarding_json),
    welcome_screen_json: parseJson<JsonObject>(raw.welcome_screen_json),
    widget_json: parseJson<JsonObject>(raw.widget_json),
    afk_json: parseJson<JsonObject>(raw.afk_json),
    self_check_json: toSelfCheck(raw.self_check_json) ?? null,
    created_at: toText(raw.created_at) ?? "",
    created_by: toId(raw.created_by) ?? "",
  };
}

function bind(row: BackupRow): SqlParam[] {
  return [
    row.backup_id,
    row.guild_id,
    row.label,
    row.kind,
    row.guild_name,
    row.icon_url,
    row.banner_url,
    row.splash_url,
    row.discovery_splash_url,
    row.owner_user_id,
    row.member_count,
    row.message_count,
    row.channel_count,
    row.role_count,
    row.size_bytes,
    row.schema_version,
    stringifyJson(row.guild_settings_json),
    stringifyJson(row.onboarding_json),
    stringifyJson(row.welcome_screen_json),
    stringifyJson(row.widget_json),
    stringifyJson(row.afk_json),
    stringifyJson(row.self_check_json),
    row.created_at,
    row.created_by,
  ];
}

export async function insertBackup(db: Database, row: BackupRow): Promise<void> {
  await db.run(`INSERT INTO backups (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function getBackup(db: Database, backupId: string): Promise<BackupRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backups WHERE backup_id = ?`,
    [backupId],
  );
  const first = rows[0];
  return first === undefined ? null : toBackupRow(first);
}

// newest first, matching idx_backups_guild_created (guild_id, created_at).
export async function listBackupsByGuild(db: Database, guildId: string): Promise<BackupRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backups WHERE guild_id = ? ORDER BY created_at DESC, backup_id DESC`,
    [guildId],
  );
  return rows.map(toBackupRow);
}

// the seal path. bind(row) carries every column, so the set clause drops the
// primary key and reuses the rest of the bound values in order.
export async function updateBackup(db: Database, row: BackupRow): Promise<void> {
  await db.run(`UPDATE backups SET ${SET} WHERE backup_id = ?`, [
    ...bind(row).slice(1),
    row.backup_id,
  ]);
}

export async function deleteBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backups WHERE backup_id = ?", [backupId]);
}

export async function countBackupsByGuild(db: Database, guildId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backups WHERE guild_id = ?",
    [guildId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

// a backup with no self-check written is still open. the cheapest way to answer
// "is a backup open here" without a second column.
export async function listOpenBackups(db: Database, guildId: string): Promise<BackupRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backups WHERE guild_id = ? AND self_check_json IS NULL
     ORDER BY created_at`,
    [guildId],
  );
  return rows.map(toBackupRow);
}
