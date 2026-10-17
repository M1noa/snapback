// queries/backup-messages.ts. captured messages, newest to oldest. up to 10k rows
// per backup (D4PLAN 11.5), so messages also flush in batches of 1000 through
// insertBackupMessages rather than being held whole.

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
import type { BackupMessageRow, Database, JsonObject, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "channel_source_id",
  "message_id",
  "author_id",
  "author_username",
  "author_global_name",
  "author_nickname",
  "author_avatar_url",
  "author_is_bot",
  "author_webhook_id",
  "content",
  "embeds_json",
  "attachments_json",
  "stickers_json",
  "components_json",
  "reactions_json",
  "reference_json",
  "thread_source_id",
  "flags",
  "pinned",
  "type",
  "created_at",
  "edited_at",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toMessageRow(raw: Record<string, SqlValue>): BackupMessageRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    channel_source_id: toId(raw.channel_source_id) ?? "",
    message_id: toId(raw.message_id) ?? "",
    author_id: toId(raw.author_id) ?? "",
    author_username: toText(raw.author_username) ?? "",
    author_global_name: toText(raw.author_global_name) ?? null,
    author_nickname: toText(raw.author_nickname) ?? null,
    author_avatar_url: toText(raw.author_avatar_url) ?? null,
    author_is_bot: toBool(raw.author_is_bot) ?? false,
    author_webhook_id: toId(raw.author_webhook_id) ?? null,
    content: toText(raw.content) ?? null,
    embeds_json: parseJson<JsonObject[]>(raw.embeds_json),
    attachments_json: parseJson<JsonObject[]>(raw.attachments_json),
    stickers_json: parseJson<JsonObject[]>(raw.stickers_json),
    components_json: parseJson<JsonObject[]>(raw.components_json),
    reactions_json: parseJson<JsonObject[]>(raw.reactions_json),
    reference_json: parseJson<JsonObject>(raw.reference_json),
    thread_source_id: toId(raw.thread_source_id) ?? null,
    flags: toNumber(raw.flags) ?? null,
    pinned: toBool(raw.pinned) ?? false,
    type: toNumber(raw.type) ?? 0,
    created_at: toText(raw.created_at) ?? "",
    edited_at: toText(raw.edited_at) ?? null,
  };
}

function bind(row: BackupMessageRow): SqlParam[] {
  return [
    row.backup_id,
    row.channel_source_id,
    row.message_id,
    row.author_id,
    row.author_username,
    row.author_global_name,
    row.author_nickname,
    row.author_avatar_url,
    row.author_is_bot,
    row.author_webhook_id,
    row.content,
    stringifyJson(row.embeds_json),
    stringifyJson(row.attachments_json),
    stringifyJson(row.stickers_json),
    stringifyJson(row.components_json),
    stringifyJson(row.reactions_json),
    stringifyJson(row.reference_json),
    row.thread_source_id,
    row.flags,
    row.pinned,
    row.type,
    row.created_at,
    row.edited_at,
  ];
}

export async function insertBackupMessage(db: Database, row: BackupMessageRow): Promise<void> {
  await db.run(`INSERT INTO backup_messages (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupMessages(
  db: Database,
  rows: readonly BackupMessageRow[],
): Promise<void> {
  await batchInsert(db, "backup_messages", COLUMNS, rows.map(bind));
}

export async function listBackupMessagesByBackup(
  db: Database,
  backupId: string,
): Promise<BackupMessageRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_messages WHERE backup_id = ? ORDER BY created_at, message_id`,
    [backupId],
  );
  return rows.map(toMessageRow);
}

export async function countBackupMessagesByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_messages WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupMessagesByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_messages WHERE backup_id = ?", [backupId]);
}
