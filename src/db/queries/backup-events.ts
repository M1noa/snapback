// queries/backup-events.ts. scheduled events. entity metadata varies by
// entity_type, so it stays json.

import { batchInsert } from "../duckdb.ts";
import { parseJson, type SqlValue, stringifyJson, toId, toNumber, toText } from "../rows.ts";
import type { BackupEventRow, Database, JsonObject, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_event_id",
  "name",
  "description",
  "scheduled_start",
  "scheduled_end",
  "privacy_level",
  "entity_type",
  "entity_metadata_json",
  "status",
  "cover_url",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toEventRow(raw: Record<string, SqlValue>): BackupEventRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_event_id: toId(raw.source_event_id) ?? "",
    name: toText(raw.name) ?? "",
    description: toText(raw.description) ?? null,
    scheduled_start: toText(raw.scheduled_start) ?? null,
    scheduled_end: toText(raw.scheduled_end) ?? null,
    privacy_level: toNumber(raw.privacy_level) ?? 0,
    entity_type: toNumber(raw.entity_type) ?? 0,
    entity_metadata_json: parseJson<JsonObject>(raw.entity_metadata_json),
    status: toNumber(raw.status) ?? 0,
    cover_url: toText(raw.cover_url) ?? null,
  };
}

function bind(row: BackupEventRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_event_id,
    row.name,
    row.description,
    row.scheduled_start,
    row.scheduled_end,
    row.privacy_level,
    row.entity_type,
    stringifyJson(row.entity_metadata_json),
    row.status,
    row.cover_url,
  ];
}

export async function insertBackupEvent(db: Database, row: BackupEventRow): Promise<void> {
  await db.run(`INSERT INTO backup_events (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupEvents(
  db: Database,
  rows: readonly BackupEventRow[],
): Promise<void> {
  await batchInsert(db, "backup_events", COLUMNS, rows.map(bind));
}

export async function listBackupEventsByBackup(
  db: Database,
  backupId: string,
): Promise<BackupEventRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_events WHERE backup_id = ? ORDER BY source_event_id`,
    [backupId],
  );
  return rows.map(toEventRow);
}

export async function countBackupEventsByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_events WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupEventsByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_events WHERE backup_id = ?", [backupId]);
}
