// queries/retention.ts. how many backups a guild keeps (D4PLAN 17.2).
//
// the policy is stored, not derived: a default that changes under an operator is
// how a retention sweep deletes something nobody agreed to.

import { parseJson, type SqlValue, stringifyJson, toBool, toNumber, toText } from "../rows.ts";
import type { BackupKind, Database, RetentionRow, SqlParam } from "../types.ts";

const COLUMNS = ["guild_id", "keep_days", "keep_count", "keep_kind_json", "enabled"] as const;
const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");
const SET = COLUMNS.slice(1)
  .map((column) => `${column} = ?`)
  .join(", ");

const KINDS: readonly BackupKind[] = ["manual", "auto", "pre_restore"];

function toKindList(value: SqlValue): BackupKind[] | null {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((kind): kind is BackupKind => KINDS.includes(kind as BackupKind));
}

function toRow(raw: Record<string, SqlValue>): RetentionRow {
  return {
    guild_id: toText(raw.guild_id) ?? "",
    keep_days: toNumber(raw.keep_days) ?? null,
    keep_count: toNumber(raw.keep_count) ?? null,
    keep_kind_json: toKindList(raw.keep_kind_json),
    enabled: toBool(raw.enabled) ?? false,
  };
}

function bind(row: RetentionRow): SqlParam[] {
  return [
    row.guild_id,
    row.keep_days,
    row.keep_count,
    stringifyJson(row.keep_kind_json),
    row.enabled,
  ];
}

export async function getRetentionPolicy(
  db: Database,
  guildId: string,
): Promise<RetentionRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM retention_policies WHERE guild_id = ?`,
    [guildId],
  );
  const first = rows[0];
  return first === undefined ? null : toRow(first);
}

// the primary key is the guild, so one row per guild: an upsert is the only write
// this table needs.
export async function upsertRetentionPolicy(db: Database, row: RetentionRow): Promise<void> {
  await db.run(
    `INSERT INTO retention_policies (${SELECT}) VALUES (${VALUES})
     ON CONFLICT (guild_id) DO UPDATE SET ${SET}`,
    [...bind(row), ...bind(row).slice(1)],
  );
}

export async function deleteRetentionPolicy(db: Database, guildId: string): Promise<void> {
  await db.run("DELETE FROM retention_policies WHERE guild_id = ?", [guildId]);
}
