// queries/oauth-states.ts. the OAuth CSRF nonce (D4PLAN 13.3): single use,
// bound to a guild, an expiry, and the client ip. the table exists so a restart
// mid-authorization does not invalidate a pending link. swept by expires_at.

import { type SqlValue, toId, toText } from "../rows.ts";
import type { Database, OauthStateRow } from "../types.ts";

const COLUMNS = "state, guild_id, created_at, expires_at, consumed_at, client_ip";

function toOauthRow(raw: Record<string, SqlValue>): OauthStateRow {
  return {
    state: toText(raw.state) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    created_at: toText(raw.created_at) ?? "",
    expires_at: toText(raw.expires_at) ?? "",
    consumed_at: toText(raw.consumed_at) ?? null,
    client_ip: toText(raw.client_ip) ?? null,
  };
}

export async function insertOauthState(db: Database, row: OauthStateRow): Promise<void> {
  await db.run(`INSERT INTO oauth_states (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [
    row.state,
    row.guild_id,
    row.created_at,
    row.expires_at,
    row.consumed_at,
    row.client_ip,
  ]);
}

export async function getOauthState(db: Database, state: string): Promise<OauthStateRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM oauth_states WHERE state = ?`,
    [state],
  );
  const first = rows[0];
  return first === undefined ? null : toOauthRow(first);
}

export async function updateOauthState(db: Database, row: OauthStateRow): Promise<void> {
  await db.run(
    `UPDATE oauth_states SET
       guild_id = ?, created_at = ?, expires_at = ?, consumed_at = ?, client_ip = ?
     WHERE state = ?`,
    [row.guild_id, row.created_at, row.expires_at, row.consumed_at, row.client_ip, row.state],
  );
}

// single-use: marking the row consumed is how /callback rejects a replay.
export async function markOauthStateConsumed(
  db: Database,
  state: string,
  consumedAt: string,
): Promise<void> {
  await db.run("UPDATE oauth_states SET consumed_at = ? WHERE state = ?", [consumedAt, state]);
}

export async function deleteOauthState(db: Database, state: string): Promise<void> {
  await db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
}

// now is an ISO-8601 string; expires_at is text, so string order is time order.
export async function deleteExpiredOauthStates(db: Database, now: string): Promise<void> {
  await db.run("DELETE FROM oauth_states WHERE expires_at < ?", [now]);
}

export async function listOauthStatesForGuild(
  db: Database,
  guildId: string,
): Promise<OauthStateRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM oauth_states WHERE guild_id = ? ORDER BY created_at`,
    [guildId],
  );
  return rows.map(toOauthRow);
}
