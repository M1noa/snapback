// queries/backup-threads.ts. threads captured by a backup, archived and locked
// state included. thread types (10, 11, 12) live here, never in backup_channels
// (D4PLAN 11.3).

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
import type { BackupThreadRow, Database, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_thread_id",
  "source_parent_id",
  "type",
  "name",
  "archived",
  "locked",
  "auto_archive_duration",
  "rate_limit_per_user",
  "applied_tags_json",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toThreadRow(raw: Record<string, SqlValue>): BackupThreadRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_thread_id: toId(raw.source_thread_id) ?? "",
    source_parent_id: toId(raw.source_parent_id) ?? "",
    type: toNumber(raw.type) ?? 0,
    name: toText(raw.name) ?? "",
    archived: toBool(raw.archived) ?? false,
    locked: toBool(raw.locked) ?? false,
    auto_archive_duration: toNumber(raw.auto_archive_duration) ?? null,
    rate_limit_per_user: toNumber(raw.rate_limit_per_user) ?? null,
    applied_tags_json: parseJson<string[]>(raw.applied_tags_json),
  };
}

function bind(row: BackupThreadRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_thread_id,
    row.source_parent_id,
    row.type,
    row.name,
    row.archived,
    row.locked,
    row.auto_archive_duration,
    row.rate_limit_per_user,
    stringifyJson(row.applied_tags_json),
  ];
}

export async function insertBackupThread(db: Database, row: BackupThreadRow): Promise<void> {
  await db.run(`INSERT INTO backup_threads (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupThreads(
  db: Database,
  rows: readonly BackupThreadRow[],
): Promise<void> {
  await batchInsert(db, "backup_threads", COLUMNS, rows.map(bind));
}

export async function listBackupThreadsByBackup(
  db: Database,
  backupId: string,
): Promise<BackupThreadRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_threads WHERE backup_id = ? ORDER BY source_parent_id, source_thread_id`,
    [backupId],
  );
  return rows.map(toThreadRow);
}

export async function countBackupThreadsByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_threads WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupThreadsByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_threads WHERE backup_id = ?", [backupId]);
}
