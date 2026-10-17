// queries/backup-overwrites.ts. per-channel permission overwrites. allow and
// deny are 64-bit bitfields: a decimal string in the app, a bigint on the way
// down (D4PLAN 12.4). target_name is kept so restore can remap by name.

import { batchInsert } from "../duckdb.ts";
import { type SqlValue, toBigInt, toId, toNumber, toText } from "../rows.ts";
import type {
  BackupChannelOverwriteRow,
  Database,
  OverwriteTargetType,
  SqlParam,
} from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_channel_id",
  "target_type",
  "source_target_id",
  "target_name",
  "allow",
  "deny",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toOverwriteRow(raw: Record<string, SqlValue>): BackupChannelOverwriteRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_channel_id: toId(raw.source_channel_id) ?? "",
    target_type: toText(raw.target_type) as OverwriteTargetType,
    source_target_id: toId(raw.source_target_id) ?? "",
    target_name: toText(raw.target_name) ?? null,
    allow: toId(raw.allow) ?? "0",
    deny: toId(raw.deny) ?? "0",
  };
}

function bind(row: BackupChannelOverwriteRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_channel_id,
    row.target_type,
    row.source_target_id,
    row.target_name,
    toBigInt(row.allow) ?? null,
    toBigInt(row.deny) ?? null,
  ];
}

export async function insertBackupChannelOverwrite(
  db: Database,
  row: BackupChannelOverwriteRow,
): Promise<void> {
  await db.run(`INSERT INTO backup_channel_overwrites (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupChannelOverwrites(
  db: Database,
  rows: readonly BackupChannelOverwriteRow[],
): Promise<void> {
  await batchInsert(db, "backup_channel_overwrites", COLUMNS, rows.map(bind));
}

export async function listBackupChannelOverwritesByBackup(
  db: Database,
  backupId: string,
): Promise<BackupChannelOverwriteRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_channel_overwrites WHERE backup_id = ?
     ORDER BY source_channel_id, target_type, source_target_id`,
    [backupId],
  );
  return rows.map(toOverwriteRow);
}

export async function countBackupChannelOverwritesByBackup(
  db: Database,
  backupId: string,
): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_channel_overwrites WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupChannelOverwritesByBackup(
  db: Database,
  backupId: string,
): Promise<void> {
  await db.run("DELETE FROM backup_channel_overwrites WHERE backup_id = ?", [backupId]);
}
