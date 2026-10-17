// queries/backup-emojis.ts. custom emojis. url is the source cdn url; the
// downloaded blob lives under backups/<id>/assets/ on disk (D4PLAN 11).

import { batchInsert } from "../duckdb.ts";
import {
  parseJson,
  type SqlValue,
  stringifyJson,
  toBool,
  toId,
  toNumber,
  toText,
} from "../rows.ts";
import type { BackupEmojiRow, Database, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_emoji_id",
  "name",
  "animated",
  "managed",
  "available",
  "roles_json",
  "url",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toEmojiRow(raw: Record<string, SqlValue>): BackupEmojiRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_emoji_id: toId(raw.source_emoji_id) ?? "",
    name: toText(raw.name) ?? "",
    animated: toBool(raw.animated) ?? false,
    managed: toBool(raw.managed) ?? false,
    available: toBool(raw.available) ?? null,
    roles_json: parseJson<string[]>(raw.roles_json) ?? [],
    url: toText(raw.url) ?? null,
  };
}

function bind(row: BackupEmojiRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_emoji_id,
    row.name,
    row.animated,
    row.managed,
    row.available,
    stringifyJson(row.roles_json),
    row.url,
  ];
}

export async function insertBackupEmoji(db: Database, row: BackupEmojiRow): Promise<void> {
  await db.run(`INSERT INTO backup_emojis (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupEmojis(
  db: Database,
  rows: readonly BackupEmojiRow[],
): Promise<void> {
  await batchInsert(db, "backup_emojis", COLUMNS, rows.map(bind));
}

export async function listBackupEmojisByBackup(
  db: Database,
  backupId: string,
): Promise<BackupEmojiRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_emojis WHERE backup_id = ? ORDER BY source_emoji_id`,
    [backupId],
  );
  return rows.map(toEmojiRow);
}

export async function countBackupEmojisByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_emojis WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupEmojisByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_emojis WHERE backup_id = ?", [backupId]);
}
