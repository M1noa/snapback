// queries/backup-tags.ts. tags a backup row was filed under, so restore can
// filter without reading json (D4PLAN 5.1). "table" is reserved in both engines,
// so it stays quoted in the column list; the js field is table.

import { batchInsert } from "../duckdb.ts";
import { type SqlValue, toId, toNumber, toText } from "../rows.ts";
import type { BackupTagRow, Database, SqlParam } from "../types.ts";

const COLUMNS = ["backup_id", '"table"', "row_id", "tag"] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toTagRow(raw: Record<string, SqlValue>): BackupTagRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    table: toText(raw.table) ?? "",
    row_id: toId(raw.row_id) ?? "",
    tag: toText(raw.tag) ?? "",
  };
}

function bind(row: BackupTagRow): SqlParam[] {
  return [row.backup_id, row.table, row.row_id, row.tag];
}

export async function insertBackupTag(db: Database, row: BackupTagRow): Promise<void> {
  await db.run(`INSERT INTO backup_tags (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupTags(db: Database, rows: readonly BackupTagRow[]): Promise<void> {
  await batchInsert(db, "backup_tags", COLUMNS, rows.map(bind));
}

export async function listBackupTagsByBackup(
  db: Database,
  backupId: string,
): Promise<BackupTagRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_tags WHERE backup_id = ? ORDER BY "table", row_id, tag`,
    [backupId],
  );
  return rows.map(toTagRow);
}

export async function countBackupTagsByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_tags WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupTagsByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_tags WHERE backup_id = ?", [backupId]);
}
