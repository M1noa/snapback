// queries/backup-channels.ts. channels captured by a backup, categories (type 4)
// included. parent_source_id is a source id, resolved on restore (D4PLAN 11.3).

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
import type { BackupChannelRow, Database, JsonObject, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_channel_id",
  "parent_source_id",
  "type",
  "name",
  "position",
  "topic",
  "nsfw",
  "rate_limit_per_user",
  "bitrate",
  "user_limit",
  "rtc_region",
  "video_quality_mode",
  "default_auto_archive_duration",
  "default_thread_rate_limit_per_user",
  "default_sort_order",
  "default_forum_layout",
  "available_tags_json",
  "flags",
  "is_news",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toChannelRow(raw: Record<string, SqlValue>): BackupChannelRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_channel_id: toId(raw.source_channel_id) ?? "",
    parent_source_id: toId(raw.parent_source_id) ?? null,
    type: toNumber(raw.type) ?? 0,
    name: toText(raw.name) ?? null,
    position: toNumber(raw.position) ?? 0,
    topic: toText(raw.topic) ?? null,
    nsfw: toBool(raw.nsfw) ?? false,
    rate_limit_per_user: toNumber(raw.rate_limit_per_user) ?? null,
    bitrate: toNumber(raw.bitrate) ?? null,
    user_limit: toNumber(raw.user_limit) ?? null,
    rtc_region: toText(raw.rtc_region) ?? null,
    video_quality_mode: toNumber(raw.video_quality_mode) ?? null,
    default_auto_archive_duration: toNumber(raw.default_auto_archive_duration) ?? null,
    default_thread_rate_limit_per_user: toNumber(raw.default_thread_rate_limit_per_user) ?? null,
    default_sort_order: toNumber(raw.default_sort_order) ?? null,
    default_forum_layout: toNumber(raw.default_forum_layout) ?? null,
    available_tags_json: parseJson<JsonObject[]>(raw.available_tags_json),
    flags: toNumber(raw.flags) ?? null,
    is_news: toBool(raw.is_news) ?? null,
  };
}

function bind(row: BackupChannelRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_channel_id,
    row.parent_source_id,
    row.type,
    row.name,
    row.position,
    row.topic,
    row.nsfw,
    row.rate_limit_per_user,
    row.bitrate,
    row.user_limit,
    row.rtc_region,
    row.video_quality_mode,
    row.default_auto_archive_duration,
    row.default_thread_rate_limit_per_user,
    row.default_sort_order,
    row.default_forum_layout,
    stringifyJson(row.available_tags_json),
    row.flags,
    row.is_news,
  ];
}

export async function insertBackupChannel(db: Database, row: BackupChannelRow): Promise<void> {
  await db.run(`INSERT INTO backup_channels (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupChannels(
  db: Database,
  rows: readonly BackupChannelRow[],
): Promise<void> {
  await batchInsert(db, "backup_channels", COLUMNS, rows.map(bind));
}

export async function listBackupChannelsByBackup(
  db: Database,
  backupId: string,
): Promise<BackupChannelRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_channels WHERE backup_id = ? ORDER BY position, source_channel_id`,
    [backupId],
  );
  return rows.map(toChannelRow);
}

export async function countBackupChannelsByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_channels WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupChannelsByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_channels WHERE backup_id = ?", [backupId]);
}
