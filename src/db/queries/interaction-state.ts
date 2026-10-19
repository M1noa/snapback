// queries/interaction-state.ts. short-lived state too large for a customID
// (D4PLAN 9.3), keyed by a short random id embedded in the customID. swept by
// expires_at on a 15-minute TTL (the scheduler owns the tick, D4PLAN 17.1).

import { parseJson, type SqlValue, stringifyJson, toId, toText } from "../rows.ts";
import type { Database, InteractionStateRow, JsonValue } from "../types.ts";

const COLUMNS = "state_id, guild_id, user_id, surface, payload_json, created_at, expires_at";

function toStateRow(raw: Record<string, SqlValue>): InteractionStateRow {
  return {
    state_id: toId(raw.state_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    surface: toText(raw.surface) ?? "",
    payload_json: parseJson<JsonValue>(raw.payload_json) as JsonValue,
    created_at: toText(raw.created_at) ?? "",
    expires_at: toText(raw.expires_at) ?? "",
  };
}

export async function insertInteractionState(
  db: Database,
  row: InteractionStateRow,
): Promise<void> {
  await db.run(`INSERT INTO interaction_state (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    row.state_id,
    row.guild_id,
    row.user_id,
    row.surface,
    stringifyJson(row.payload_json),
    row.created_at,
    row.expires_at,
  ]);
}

export async function getInteractionState(
  db: Database,
  stateId: string,
): Promise<InteractionStateRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM interaction_state WHERE state_id = ?`,
    [stateId],
  );
  const first = rows[0];
  return first === undefined ? null : toStateRow(first);
}

export async function updateInteractionState(
  db: Database,
  row: InteractionStateRow,
): Promise<void> {
  await db.run(
    `UPDATE interaction_state SET
       guild_id = ?, user_id = ?, surface = ?, payload_json = ?, created_at = ?, expires_at = ?
     WHERE state_id = ?`,
    [
      row.guild_id,
      row.user_id,
      row.surface,
      stringifyJson(row.payload_json),
      row.created_at,
      row.expires_at,
      row.state_id,
    ],
  );
}

export async function deleteInteractionState(db: Database, stateId: string): Promise<void> {
  await db.run("DELETE FROM interaction_state WHERE state_id = ?", [stateId]);
}

// the TTL sweep. now is an ISO-8601 string; expires_at is text, so string order
// is time order (schema.sql).
export async function deleteExpiredInteractionState(db: Database, now: string): Promise<number> {
  // the count is read first, so the sweep can report what it did. the driver's
  // run does not hand back the number of rows it changed.
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM interaction_state WHERE expires_at < ?",
    [now],
  );
  const count = Number(rows[0]?.n ?? 0);
  await db.run("DELETE FROM interaction_state WHERE expires_at < ?", [now]);
  return count;
}

export async function listInteractionStateForGuild(
  db: Database,
  guildId: string,
): Promise<InteractionStateRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM interaction_state WHERE guild_id = ? ORDER BY created_at`,
    [guildId],
  );
  return rows.map(toStateRow);
}
