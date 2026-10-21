// queries/guilds.ts. every guild the bot is or was in, plus its editable
// settings. settings_json round-trips through readGuildSettings so a stored row
// always comes back as a complete GuildSettings (config/defaults.ts).

import { type GuildSettings, readGuildSettings } from "../../config/defaults.ts";
import { parseJson, type SqlValue, stringifyJson, toId, toText } from "../rows.ts";
import type { Database, GuildRow } from "../types.ts";

function toGuildRow(raw: Record<string, SqlValue>): GuildRow {
  return {
    guild_id: toId(raw.guild_id) ?? "",
    name: toText(raw.name) ?? null,
    icon_url: toText(raw.icon_url) ?? null,
    owner_user_id: toId(raw.owner_user_id) ?? null,
    added_at: toText(raw.added_at) ?? null,
    removed_at: toText(raw.removed_at) ?? null,
    settings_json:
      raw.settings_json === null || raw.settings_json === undefined
        ? null
        : readGuildSettings(parseJson<unknown>(raw.settings_json)),
  };
}

const COLUMNS = "guild_id, name, icon_url, owner_user_id, added_at, removed_at, settings_json";

function bind(row: GuildRow): (string | null)[] {
  return [
    row.guild_id,
    row.name,
    row.icon_url,
    row.owner_user_id,
    row.added_at,
    row.removed_at,
    stringifyJson(row.settings_json),
  ];
}

export async function insertGuild(db: Database, row: GuildRow): Promise<void> {
  await db.run(`INSERT INTO guilds (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, bind(row));
}

export async function upsertGuild(db: Database, row: GuildRow): Promise<void> {
  await db.run(
    `INSERT INTO guilds (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       name = excluded.name,
       icon_url = excluded.icon_url,
       owner_user_id = excluded.owner_user_id,
       added_at = excluded.added_at,
       removed_at = excluded.removed_at,
       settings_json = excluded.settings_json`,
    bind(row),
  );
}

export async function getGuild(db: Database, guildId: string): Promise<GuildRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guilds WHERE guild_id = ?`,
    [guildId],
  );
  const first = rows[0];
  return first === undefined ? null : toGuildRow(first);
}

export async function listActiveGuilds(db: Database): Promise<GuildRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guilds WHERE removed_at IS NULL ORDER BY added_at`,
  );
  return rows.map(toGuildRow);
}

export async function updateGuild(db: Database, row: GuildRow): Promise<void> {
  await db.run(
    `UPDATE guilds SET
       name = ?, icon_url = ?, owner_user_id = ?,
       added_at = ?, removed_at = ?, settings_json = ?
     WHERE guild_id = ?`,
    [
      row.name,
      row.icon_url,
      row.owner_user_id,
      row.added_at,
      row.removed_at,
      stringifyJson(row.settings_json),
      row.guild_id,
    ],
  );
}

export async function markGuildRemoved(
  db: Database,
  guildId: string,
  removedAt: string,
): Promise<void> {
  await db.run("UPDATE guilds SET removed_at = ? WHERE guild_id = ?", [removedAt, guildId]);
}

/** what discord says the guild is, written from the gateway so the default
 *  name on the web pages stays the live one. settings and added_at survive a
 *  conflict untouched: this path is about who discord says the guild is, not
 *  about anything the operator configured. */
export async function syncGuildIdentity(
  db: Database,
  identity: {
    guildId: string;
    name: string;
    iconUrl: string | null;
    ownerUserId: string | null;
    at: string;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO guilds (guild_id, name, icon_url, owner_user_id, added_at, removed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (guild_id) DO UPDATE SET
       name = excluded.name,
       icon_url = excluded.icon_url,
       owner_user_id = excluded.owner_user_id,
       removed_at = NULL`,
    [identity.guildId, identity.name, identity.iconUrl, identity.ownerUserId, identity.at],
  );
}

export async function setGuildSettings(
  db: Database,
  guildId: string,
  settings: GuildSettings,
): Promise<void> {
  await db.run("UPDATE guilds SET settings_json = ? WHERE guild_id = ?", [
    stringifyJson(settings),
    guildId,
  ]);
}

export async function getGuildSettings(
  db: Database,
  guildId: string,
): Promise<GuildSettings | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT settings_json FROM guilds WHERE guild_id = ?",
    [guildId],
  );
  const first = rows[0];
  if (first === undefined) return null;
  const stored = first.settings_json;
  if (stored === null || stored === undefined) return null;
  return readGuildSettings(parseJson<unknown>(stored));
}
