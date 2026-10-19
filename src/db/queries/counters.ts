// queries/counters.ts. one row per (user, guild, utc day).
//
// the row carries the cooldown and the restricted flag, so the decision "may this
// account be tried again" is one read and not a walk over the attempt history.

import { type SqlValue, toBool, toId, toNumber, toText } from "../rows.ts";
import type { AccountCounterRow, Database, SqlParam } from "../types.ts";

const COLUMNS = [
  "user_id",
  "guild_id",
  "day",
  "attempts",
  "successes",
  "failures",
  "cooldown_until",
  "restricted",
  "restricted_reason",
  "restricted_at",
  "updated_at",
] as const;
const SELECT = COLUMNS.join(", ");
const VALUES = COLUMNS.map(() => "?").join(", ");
const SET = COLUMNS.slice(3)
  .map((column) => `${column} = ?`)
  .join(", ");

function toRow(raw: Record<string, SqlValue>): AccountCounterRow {
  return {
    user_id: toId(raw.user_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    day: toText(raw.day) ?? "",
    attempts: toNumber(raw.attempts) ?? 0,
    successes: toNumber(raw.successes) ?? 0,
    failures: toNumber(raw.failures) ?? 0,
    cooldown_until: toText(raw.cooldown_until) ?? null,
    restricted: toBool(raw.restricted) ?? false,
    restricted_reason: toText(raw.restricted_reason) ?? null,
    restricted_at: toText(raw.restricted_at) ?? null,
    updated_at: toText(raw.updated_at) ?? "",
  };
}

function bind(row: AccountCounterRow): SqlParam[] {
  return [
    row.user_id,
    row.guild_id,
    row.day,
    row.attempts,
    row.successes,
    row.failures,
    row.cooldown_until,
    row.restricted,
    row.restricted_reason,
    row.restricted_at,
    row.updated_at,
  ];
}

export async function getAccountCounter(
  db: Database,
  userId: string,
  guildId: string,
  day: string,
): Promise<AccountCounterRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM account_counters WHERE user_id = ? AND guild_id = ? AND day = ?`,
    [userId, guildId, day],
  );
  const first = rows[0];
  return first === undefined ? null : toRow(first);
}

/** the counter for every day of this account, newest first. */
export async function listAccountCounters(
  db: Database,
  userId: string,
  guildId: string,
): Promise<AccountCounterRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${SELECT} FROM account_counters WHERE user_id = ? AND guild_id = ? ORDER BY day DESC`,
    [userId, guildId],
  );
  return rows.map(toRow);
}

export async function upsertAccountCounter(db: Database, row: AccountCounterRow): Promise<void> {
  // the primary key is the triple, so an insert that collides is an update.
  await db.run(
    `INSERT INTO account_counters (${SELECT}) VALUES (${VALUES})
     ON CONFLICT (user_id, guild_id, day) DO UPDATE SET ${SET}`,
    [...bind(row), ...bind(row).slice(3)],
  );
}
