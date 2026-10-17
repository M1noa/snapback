// queries/backup-members.ts. guild members with their role ids and source role
// names. a 100k-member guild must not be held whole, so members flush in batches
// of 1000 (D4PLAN 11.4) through insertBackupMembers.

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
import type { BackupMemberRow, Database, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "user_id",
  "username",
  "global_name",
  "discriminator",
  "nickname",
  "avatar_url",
  "joined_at",
  "is_bot",
  "role_ids_json",
  "pending",
  "timed_out_until",
  "premium_since",
  "flags",
  "source_role_names_json",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toMemberRow(raw: Record<string, SqlValue>): BackupMemberRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    username: toText(raw.username) ?? "",
    global_name: toText(raw.global_name) ?? null,
    discriminator: toText(raw.discriminator) ?? null,
    nickname: toText(raw.nickname) ?? null,
    avatar_url: toText(raw.avatar_url) ?? null,
    joined_at: toText(raw.joined_at) ?? null,
    is_bot: toBool(raw.is_bot) ?? false,
    role_ids_json: parseJson<string[]>(raw.role_ids_json) ?? [],
    pending: toBool(raw.pending) ?? false,
    timed_out_until: toText(raw.timed_out_until) ?? null,
    premium_since: toText(raw.premium_since) ?? null,
    flags: toNumber(raw.flags) ?? null,
    source_role_names_json: parseJson<string[]>(raw.source_role_names_json) ?? [],
  };
}

function bind(row: BackupMemberRow): SqlParam[] {
  return [
    row.backup_id,
    row.user_id,
    row.username,
    row.global_name,
    row.discriminator,
    row.nickname,
    row.avatar_url,
    row.joined_at,
    row.is_bot,
    stringifyJson(row.role_ids_json),
    row.pending,
    row.timed_out_until,
    row.premium_since,
    row.flags,
    stringifyJson(row.source_role_names_json),
  ];
}

export async function insertBackupMember(db: Database, row: BackupMemberRow): Promise<void> {
  await db.run(`INSERT INTO backup_members (${SELECT}) VALUES (${VALUES})`, bind(row));
}

// the actual flush path for capture: many rows in one multi-row INSERT, chunked
// by batchInsert so no statement carries an unbounded parameter list.
export async function insertBackupMembers(
  db: Database,
  rows: readonly BackupMemberRow[],
): Promise<void> {
  await batchInsert(db, "backup_members", COLUMNS, rows.map(bind));
}

export async function listBackupMembersByBackup(
  db: Database,
  backupId: string,
): Promise<BackupMemberRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_members WHERE backup_id = ? ORDER BY user_id`,
    [backupId],
  );
  return rows.map(toMemberRow);
}

export async function countBackupMembersByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_members WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupMembersByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_members WHERE backup_id = ?", [backupId]);
}
