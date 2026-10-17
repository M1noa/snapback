// queries/backup-bans.ts. bans captured for restore. reason is whatever the
// moderator typed, kept verbatim.

import { batchInsert } from "../duckdb.ts";
import { type SqlValue, toId, toNumber, toText } from "../rows.ts";
import type { BackupBanRow, Database, SqlParam } from "../types.ts";

const COLUMNS = ["backup_id", "user_id", "username", "global_name", "reason"] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toBanRow(raw: Record<string, SqlValue>): BackupBanRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    username: toText(raw.username) ?? "",
    global_name: toText(raw.global_name) ?? null,
    reason: toText(raw.reason) ?? null,
  };
}

function bind(row: BackupBanRow): SqlParam[] {
  return [row.backup_id, row.user_id, row.username, row.global_name, row.reason];
}

export async function insertBackupBan(db: Database, row: BackupBanRow): Promise<void> {
  await db.run(`INSERT INTO backup_bans (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupBans(db: Database, rows: readonly BackupBanRow[]): Promise<void> {
  await batchInsert(db, "backup_bans", COLUMNS, rows.map(bind));
}

export async function listBackupBansByBackup(
  db: Database,
  backupId: string,
): Promise<BackupBanRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_bans WHERE backup_id = ? ORDER BY user_id`,
    [backupId],
  );
  return rows.map(toBanRow);
}

export async function countBackupBansByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_bans WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupBansByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_bans WHERE backup_id = ?", [backupId]);
}
