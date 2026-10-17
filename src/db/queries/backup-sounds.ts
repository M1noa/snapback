// queries/backup-sounds.ts. soundboard sounds. volume is 0..1 (DOUBLE PRECISION),
// so it stays a number across the boundary.

import { batchInsert } from "../duckdb.ts";
import { type SqlValue, toId, toNumber, toText } from "../rows.ts";
import type { BackupSoundRow, Database, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_sound_id",
  "name",
  "volume",
  "emoji_name",
  "emoji_id",
  "url",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toSoundRow(raw: Record<string, SqlValue>): BackupSoundRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_sound_id: toId(raw.source_sound_id) ?? "",
    name: toText(raw.name) ?? "",
    volume: toNumber(raw.volume) ?? null,
    emoji_name: toText(raw.emoji_name) ?? null,
    emoji_id: toId(raw.emoji_id) ?? null,
    url: toText(raw.url) ?? null,
  };
}

function bind(row: BackupSoundRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_sound_id,
    row.name,
    row.volume,
    row.emoji_name,
    row.emoji_id,
    row.url,
  ];
}

export async function insertBackupSound(db: Database, row: BackupSoundRow): Promise<void> {
  await db.run(`INSERT INTO backup_sounds (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupSounds(
  db: Database,
  rows: readonly BackupSoundRow[],
): Promise<void> {
  await batchInsert(db, "backup_sounds", COLUMNS, rows.map(bind));
}

export async function listBackupSoundsByBackup(
  db: Database,
  backupId: string,
): Promise<BackupSoundRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_sounds WHERE backup_id = ? ORDER BY source_sound_id`,
    [backupId],
  );
  return rows.map(toSoundRow);
}

export async function countBackupSoundsByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_sounds WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupSoundsByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_sounds WHERE backup_id = ?", [backupId]);
}
