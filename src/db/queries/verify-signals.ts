// queries/verify-signals.ts. the signals one verification left behind, so a
// new one can be compared against the accounts already in this server
// (D4PLAN 14.4).
//
// the value is a digest in every case: the device digest, the stored address
// (which is a hash unless the operator chose otherwise), the email digest, the
// avatar hash and the name. nothing here holds a plain address.

import { type SqlValue, toId, toText } from "../rows.ts";
import type { Database, SqlParam, VerifySignalKind, VerifySignalRow } from "../types.ts";

const KINDS = ["device", "ip", "email", "avatar", "name"] as const;

const COLUMNS = "signal_id, guild_id, user_id, kind, value, created_at";

function toRow(raw: Record<string, SqlValue>): VerifySignalRow {
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  return {
    signal_id: toId(raw.signal_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as VerifySignalKind) : "name",
    value: toText(raw.value) ?? "",
    created_at: toText(raw.created_at) ?? "",
  };
}

/** writes the signals of one verification. */
export async function insertSignals(db: Database, rows: readonly VerifySignalRow[]): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const params: SqlParam[] = [];
  for (const row of rows) {
    params.push(row.signal_id, row.guild_id, row.user_id, row.kind, row.value, row.created_at);
  }
  await db.run(`INSERT INTO verify_signals (${COLUMNS}) VALUES ${placeholders}`, params);
}

/**
 * the other accounts in this guild that hold one of these values.
 *
 * the guild is part of the lookup on purpose: a signal is compared inside the
 * server that asked for it and nowhere else.
 */
export async function findSignalMatches(
  db: Database,
  guildId: string,
  kind: VerifySignalKind,
  values: readonly string[],
): Promise<VerifySignalRow[]> {
  const unique = [...new Set(values.filter((value) => value !== ""))];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_signals
     WHERE guild_id = ? AND kind = ? AND value IN (${placeholders})`,
    [guildId, kind, ...unique],
  );
  return rows.map(toRow);
}

/** every signal one account left in this guild. */
export async function listSignalsForUser(
  db: Database,
  guildId: string,
  userId: string,
): Promise<VerifySignalRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_signals WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId],
  );
  return rows.map(toRow);
}
