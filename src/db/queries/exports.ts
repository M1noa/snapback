// queries/exports.ts. a written export file, with the expiry the sweep uses
// (D4PLAN 17.4). the row is what makes an export visible to the operator and
// findable by the sweeper; the bytes live on disk.

import { parseJson, type SqlValue, stringifyJson, toId, toNumber, toText } from "../rows.ts";
import type { Database, ExportKind, JsonObject, PendingExportRow, SqlParam } from "../types.ts";

const COLUMNS = [
  "export_id",
  "guild_id",
  "kind",
  "scope_json",
  "file_path",
  "size_bytes",
  "created_at",
  "expires_at",
] as const;
const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toRow(raw: Record<string, SqlValue>): PendingExportRow {
  return {
    export_id: toId(raw.export_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    kind: (toText(raw.kind) ?? "backup") as ExportKind,
    scope_json: parseJson<JsonObject>(raw.scope_json),
    file_path: toText(raw.file_path) ?? "",
    size_bytes: toNumber(raw.size_bytes) ?? 0,
    created_at: toText(raw.created_at) ?? "",
    expires_at: toText(raw.expires_at) ?? "",
  };
}

function bind(row: PendingExportRow): SqlParam[] {
  return [
    row.export_id,
    row.guild_id,
    row.kind,
    stringifyJson(row.scope_json),
    row.file_path,
    row.size_bytes,
    row.created_at,
    row.expires_at,
  ];
}

export async function insertPendingExport(db: Database, row: PendingExportRow): Promise<void> {
  await db.run(`INSERT INTO pending_exports (${SELECT}) VALUES (${VALUES})`, bind(row));
}

export async function getPendingExport(
  db: Database,
  exportId: string,
): Promise<PendingExportRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM pending_exports WHERE export_id = ?`,
    [exportId],
  );
  const first = rows[0];
  return first === undefined ? null : toRow(first);
}

// newest first, which is the order the operator wants them in.
export async function listPendingExportsByGuild(
  db: Database,
  guildId: string,
): Promise<PendingExportRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM pending_exports WHERE guild_id = ? ORDER BY created_at DESC, export_id DESC`,
    [guildId],
  );
  return rows.map(toRow);
}

// expired means expires_at is at or before now, both iso 8601 utc, so string
// comparison is chronological (the same reasoning as every other timestamp here).
export async function listExpiredExports(db: Database, now: string): Promise<PendingExportRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM pending_exports WHERE expires_at <= ? ORDER BY expires_at`,
    [now],
  );
  return rows.map(toRow);
}

export async function deletePendingExport(db: Database, exportId: string): Promise<void> {
  await db.run("DELETE FROM pending_exports WHERE export_id = ?", [exportId]);
}
