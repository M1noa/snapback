// queries/backup-roles.ts. roles captured by a backup. permissions is a 64-bit
// bitfield: a decimal string in the app, a bigint on the way down (db/rows.ts).

import { batchInsert } from "../duckdb.ts";
import {
  parseJson,
  type SqlValue,
  stringifyJson,
  toBigInt,
  toBool,
  toId,
  toNumber,
  toText,
} from "../rows.ts";
import type { BackupRoleRow, Database, JsonObject, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_role_id",
  "name",
  "color",
  "hoist",
  "mentionable",
  "position",
  "permissions",
  "is_everyone",
  "is_bot_managed",
  "bot_id",
  "integration_id",
  "icon_url",
  "unicode_emoji",
  "tags_json",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toRoleRow(raw: Record<string, SqlValue>): BackupRoleRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_role_id: toId(raw.source_role_id) ?? "",
    name: toText(raw.name) ?? "",
    color: toNumber(raw.color) ?? 0,
    hoist: toBool(raw.hoist) ?? false,
    mentionable: toBool(raw.mentionable) ?? false,
    position: toNumber(raw.position) ?? 0,
    permissions: toId(raw.permissions) ?? "0",
    is_everyone: toBool(raw.is_everyone) ?? false,
    is_bot_managed: toBool(raw.is_bot_managed) ?? false,
    bot_id: toId(raw.bot_id) ?? null,
    integration_id: toId(raw.integration_id) ?? null,
    icon_url: toText(raw.icon_url) ?? null,
    unicode_emoji: toText(raw.unicode_emoji) ?? null,
    tags_json: parseJson<JsonObject>(raw.tags_json),
  };
}

function bind(row: BackupRoleRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_role_id,
    row.name,
    row.color,
    row.hoist,
    row.mentionable,
    row.position,
    toBigInt(row.permissions) ?? null,
    row.is_everyone,
    row.is_bot_managed,
    row.bot_id,
    row.integration_id,
    row.icon_url,
    row.unicode_emoji,
    stringifyJson(row.tags_json),
  ];
}

export async function insertBackupRole(db: Database, row: BackupRoleRow): Promise<void> {
  await db.run(`INSERT INTO backup_roles (${SELECT}) VALUES (${VALUES})`, bind(row));
}

// batchInsert builds one multi-row INSERT per 1000-row chunk (db/duckdb.ts): the
// Database interface has no batch call, and one round trip per row is what the
// members and messages paths must avoid (D4PLAN 11.4).
export async function insertBackupRoles(
  db: Database,
  rows: readonly BackupRoleRow[],
): Promise<void> {
  await batchInsert(db, "backup_roles", COLUMNS, rows.map(bind));
}

export async function listBackupRolesByBackup(
  db: Database,
  backupId: string,
): Promise<BackupRoleRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_roles WHERE backup_id = ? ORDER BY position, source_role_id`,
    [backupId],
  );
  return rows.map(toRoleRow);
}

export async function countBackupRolesByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_roles WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupRolesByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_roles WHERE backup_id = ?", [backupId]);
}
