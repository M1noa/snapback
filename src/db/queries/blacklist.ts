// queries/blacklist.ts. the per-guild blacklist (D4PLAN 8).
//
// an entry is a signal shown to an operator. nothing here refuses anything and
// nothing here decides: the module only reads and writes the list. the ban
// question is not this table's business (D4PLAN 19.4).
//
// a table and not a blob in guilds.settings_json: the list grows past a few
// dozen entries, and the pull engine reads it on every join.
//
// one entry per (guild, kind, value), so the same value added twice is one row.

import { oneOf } from "../../lib/validate.ts";
import { type SqlValue, toId, toText } from "../rows.ts";
import type { BlacklistKind, Database, GuildBlacklistRow } from "../types.ts";

const KINDS = ["user_id", "ip_hash", "asn"] as const;

const COLUMNS = "guild_id, kind, value, added_by, added_at, reason";

function toRow(raw: Record<string, SqlValue>): GuildBlacklistRow {
  return {
    guild_id: toId(raw.guild_id) ?? "",
    kind: oneOf(raw.kind, KINDS) ?? "user_id",
    value: toText(raw.value) ?? "",
    added_by: toId(raw.added_by) ?? null,
    added_at: toText(raw.added_at) ?? "",
    reason: toText(raw.reason) ?? null,
  };
}

/** one entry, by the three things that name it. */
export async function getBlacklistEntry(
  db: Database,
  guildId: string,
  kind: BlacklistKind,
  value: string,
): Promise<GuildBlacklistRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guild_blacklist
     WHERE guild_id = ? AND kind = ? AND value = ?`,
    [guildId, kind, value],
  );
  const first = rows[0];
  return first === undefined ? null : toRow(first);
}

/** the whole list of one guild, newest first. */
export async function listBlacklistEntries(
  db: Database,
  guildId: string,
): Promise<GuildBlacklistRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guild_blacklist WHERE guild_id = ? ORDER BY added_at DESC, kind, value`,
    [guildId],
  );
  return rows.map(toRow);
}

/**
 * add an entry. false when it was already there: the key is the triple, so a
 * second add is not a second row.
 */
export async function addBlacklistEntry(db: Database, row: GuildBlacklistRow): Promise<boolean> {
  const existing = await getBlacklistEntry(db, row.guild_id, row.kind, row.value);
  if (existing !== null) return false;
  // on conflict do nothing is the one form both engines accept without a
  // conflict target, so a concurrent add cannot make a duplicate.
  await db.run(
    `INSERT INTO guild_blacklist (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [row.guild_id, row.kind, row.value, row.added_by, row.added_at, row.reason],
  );
  return true;
}

/** remove an entry. false when there was nothing to remove. */
export async function removeBlacklistEntry(
  db: Database,
  guildId: string,
  kind: BlacklistKind,
  value: string,
): Promise<boolean> {
  const existing = await getBlacklistEntry(db, guildId, kind, value);
  if (existing === null) return false;
  await db.run("DELETE FROM guild_blacklist WHERE guild_id = ? AND kind = ? AND value = ?", [
    guildId,
    kind,
    value,
  ]);
  return true;
}

/**
 * the entries that name one of these values. this is the read the pull engine
 * does on every join: one query per kind, and it returns rows to show an
 * operator, never a verdict to act on.
 */
export async function findBlacklistEntries(
  db: Database,
  guildId: string,
  kind: BlacklistKind,
  values: readonly string[],
): Promise<GuildBlacklistRow[]> {
  if (values.length === 0) return [];
  const placeholders = values.map(() => "?").join(", ");
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guild_blacklist
     WHERE guild_id = ? AND kind = ? AND value IN (${placeholders})`,
    [guildId, kind, ...values],
  );
  return rows.map(toRow);
}
