// queries/backup-automod.ts. automod rules. trigger metadata and actions stay
// json so their shape can change without a migration.

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
import type { BackupAutomodRow, Database, JsonObject, SqlParam } from "../types.ts";

const COLUMNS = [
  "backup_id",
  "source_rule_id",
  "name",
  "event_type",
  "trigger_type",
  "trigger_metadata_json",
  "actions_json",
  "enabled",
  "exempt_roles_json",
  "exempt_channels_json",
] as const;

const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toAutomodRow(raw: Record<string, SqlValue>): BackupAutomodRow {
  return {
    backup_id: toId(raw.backup_id) ?? "",
    source_rule_id: toId(raw.source_rule_id) ?? "",
    name: toText(raw.name) ?? "",
    event_type: toNumber(raw.event_type) ?? 0,
    trigger_type: toNumber(raw.trigger_type) ?? 0,
    trigger_metadata_json: parseJson<JsonObject>(raw.trigger_metadata_json),
    actions_json: parseJson<JsonObject[]>(raw.actions_json) ?? [],
    enabled: toBool(raw.enabled) ?? false,
    exempt_roles_json: parseJson<string[]>(raw.exempt_roles_json) ?? [],
    exempt_channels_json: parseJson<string[]>(raw.exempt_channels_json) ?? [],
  };
}

function bind(row: BackupAutomodRow): SqlParam[] {
  return [
    row.backup_id,
    row.source_rule_id,
    row.name,
    row.event_type,
    row.trigger_type,
    stringifyJson(row.trigger_metadata_json),
    stringifyJson(row.actions_json),
    row.enabled,
    stringifyJson(row.exempt_roles_json),
    stringifyJson(row.exempt_channels_json),
  ];
}

export async function insertBackupAutomod(db: Database, row: BackupAutomodRow): Promise<void> {
  await db.run(`INSERT INTO backup_automod (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function insertBackupAutomods(
  db: Database,
  rows: readonly BackupAutomodRow[],
): Promise<void> {
  await batchInsert(db, "backup_automod", COLUMNS, rows.map(bind));
}

export async function listBackupAutomodsByBackup(
  db: Database,
  backupId: string,
): Promise<BackupAutomodRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM backup_automod WHERE backup_id = ? ORDER BY source_rule_id`,
    [backupId],
  );
  return rows.map(toAutomodRow);
}

export async function countBackupAutomodsByBackup(db: Database, backupId: string): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM backup_automod WHERE backup_id = ?",
    [backupId],
  );
  return toNumber(rows[0]?.n ?? null) ?? 0;
}

export async function deleteBackupAutomodsByBackup(db: Database, backupId: string): Promise<void> {
  await db.run("DELETE FROM backup_automod WHERE backup_id = ?", [backupId]);
}
