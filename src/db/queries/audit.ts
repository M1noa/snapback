// queries/audit.ts. append-only record of who changed what, for /admin review.
// there is no update or delete here on purpose: audit rows are written once and
// never mutated (D4PLAN 16 owns the "who deleted this record" guarantee).

import { parseJson, type SqlValue, stringifyJson, toId, toText } from "../rows.ts";
import type { AuditLogRow, Database, JsonObject } from "../types.ts";

const COLUMNS = "id, guild_id, actor_user_id, action, target, detail_json, created_at";
const DEFAULT_LIMIT = 50;

function toAuditRow(raw: Record<string, SqlValue>): AuditLogRow {
  return {
    id: toId(raw.id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    actor_user_id: toId(raw.actor_user_id) ?? "",
    action: toText(raw.action) ?? "",
    target: toText(raw.target) ?? null,
    detail_json:
      raw.detail_json === null || raw.detail_json === undefined
        ? null
        : parseJson<JsonObject>(raw.detail_json),
    created_at: toText(raw.created_at) ?? "",
  };
}

export async function insertAudit(db: Database, row: AuditLogRow): Promise<void> {
  await db.run(`INSERT INTO audit_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    row.id,
    row.guild_id,
    row.actor_user_id,
    row.action,
    row.target,
    stringifyJson(row.detail_json),
    row.created_at,
  ]);
}

export async function getAudit(db: Database, id: string): Promise<AuditLogRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM audit_log WHERE id = ?`,
    [id],
  );
  const first = rows[0];
  return first === undefined ? null : toAuditRow(first);
}

export interface AuditQuery {
  /** page size. default 50. */
  limit?: number;
  /** exclusive cursor on created_at, for paging back through history. */
  before?: string;
}

// newest first, matching idx_audit_log_guild_created (guild_id, created_at).
export async function listAuditByGuild(
  db: Database,
  guildId: string,
  query: AuditQuery = {},
): Promise<AuditLogRow[]> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const rows =
    query.before === undefined
      ? await db.query<Record<string, SqlValue>>(
          `SELECT ${COLUMNS} FROM audit_log WHERE guild_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [guildId, limit],
        )
      : await db.query<Record<string, SqlValue>>(
          `SELECT ${COLUMNS} FROM audit_log WHERE guild_id = ? AND created_at < ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [guildId, query.before, limit],
        );
  return rows.map(toAuditRow);
}

export async function listAuditByActor(
  db: Database,
  guildId: string,
  actorUserId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<AuditLogRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM audit_log WHERE guild_id = ? AND actor_user_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [guildId, actorUserId, limit],
  );
  return rows.map(toAuditRow);
}
