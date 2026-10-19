// queries/pull-attempts.ts. one row per attempt to add a member to a guild.
//
// an attempt is recorded whatever its outcome, so the history of an account is
// visible to the operator and not only the last thing that happened.

import { type SqlValue, toId, toText } from "../rows.ts";
import type { Database, PullAttemptRow, PullOutcome, SqlParam } from "../types.ts";

const COLUMNS = [
  "id",
  "guild_id",
  "user_id",
  "attempted_at",
  "outcome",
  "error_code",
  "error_body",
] as const;
const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");

function toRow(raw: Record<string, SqlValue>): PullAttemptRow {
  return {
    id: toId(raw.id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    attempted_at: toText(raw.attempted_at) ?? "",
    outcome: (toText(raw.outcome) ?? "failed") as PullOutcome,
    error_code: toText(raw.error_code) ?? null,
    error_body: toText(raw.error_body) ?? null,
  };
}

export async function insertPullAttempt(db: Database, row: PullAttemptRow): Promise<void> {
  const values: SqlParam[] = [
    row.id,
    row.guild_id,
    row.user_id,
    row.attempted_at,
    row.outcome,
    row.error_code,
    row.error_body,
  ];
  await db.run(`INSERT INTO pull_attempts (${SELECT}) VALUES (${VALUES})`, values);
}

export async function listPullAttemptsByUser(
  db: Database,
  userId: string,
  limit: number,
): Promise<PullAttemptRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM pull_attempts WHERE user_id = ? ORDER BY attempted_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map(toRow);
}

export async function countPullAttempts(
  db: Database,
  userId: string,
  guildId: string,
): Promise<number> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM pull_attempts WHERE user_id = ? AND guild_id = ?",
    [userId, guildId],
  );
  return Number(rows[0]?.n ?? 0);
}
