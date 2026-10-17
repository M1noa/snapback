// queries/backup-stickers.ts. stickers. format_type decides whether restore can
// re-upload the bytes as a png or must fall back to the url.

import { batchInsert } from "../duckdb.ts";
import { type SqlValue, toId, toNumber, toText } from "../rows.ts";
import type { BackupStickerRow, Database, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_sticker_id",
  "name",
  "description",
  "tags",
  "format_type",
  "url",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toStickerRow(raw: Record<string, SqlValue>): BackupStickerRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_sticker_id: toId(raw.source_sticker_id) ?? "",
    name: toText(raw.name) ?? "",
    description: toText(raw.description) ?? null,
    tags: toText(raw.tags) ?? null,
    format_type: toNumber(raw.format_type) ?? 0,
    url: toText(raw.url) ?? null,
  };
}

function bind(row: BackupStickerRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_sticker_id,
    row.name,
    row.description,
    row.tags,
    row.format_type,
    row.url,
  ];
}

export async function insertBackupSticker(db: Database, row: BackupStickerRow): Promise<void> {
  await db.run(`INSERT INTO backup_stickers (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupStickers(
  db: Database,
  rows: readonly BackupStickerRow[],
): Promise<void> {
  await batchInsert(db, "backup_stickers", COLUMNS, rows.map(bind));
}

export async function listBackupStickersByBackup(
  db: Database,
  backupId: string,
): Promise<BackupStickerRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_stickers WHERE backup_id = ? ORDER BY source_sticker_id`,
    [backupId],
  );
  return rows.map(toStickerRow);
}

export async function countBackupStickersByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_stickers WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupStickersByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_stickers WHERE backup_id = ?", [backupId]);
}
