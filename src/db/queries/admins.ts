// queries/admins.ts. per-flag admin grants. the security model is that
// verify.read does not imply restore.execute, so the flags stay separate
// columns rather than one admin boolean (D4PLAN 5.1).

import { type SqlValue, toBool, toId, toText } from "../rows.ts";
import type { Database, GuildAdminRow } from "../types.ts";

/** the five per-flag grants on a guild_admins row. */
export interface AdminFlags {
  can_backup: boolean;
  can_restore: boolean;
  can_manage_admins: boolean;
  can_view_records: boolean;
  can_delete_records: boolean;
}

function toAdminRow(raw: Record<string, SqlValue>): GuildAdminRow {
  return {
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    added_by: toId(raw.added_by) ?? null,
    added_at: toText(raw.added_at) ?? null,
    can_backup: toBool(raw.can_backup) ?? false,
    can_restore: toBool(raw.can_restore) ?? false,
    can_manage_admins: toBool(raw.can_manage_admins) ?? false,
    can_view_records: toBool(raw.can_view_records) ?? false,
    can_delete_records: toBool(raw.can_delete_records) ?? false,
  };
}

const COLUMNS =
  "guild_id, user_id, added_by, added_at, can_backup, can_restore, can_manage_admins, can_view_records, can_delete_records";

function bind(row: GuildAdminRow): (string | boolean | null)[] {
  return [
    row.guild_id,
    row.user_id,
    row.added_by,
    row.added_at,
    row.can_backup,
    row.can_restore,
    row.can_manage_admins,
    row.can_view_records,
    row.can_delete_records,
  ];
}

export async function insertAdmin(db: Database, row: GuildAdminRow): Promise<void> {
  await db.run(
    `INSERT INTO guild_admins (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind(row),
  );
}

export async function upsertAdmin(db: Database, row: GuildAdminRow): Promise<void> {
  await db.run(
    `INSERT INTO guild_admins (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       added_by = excluded.added_by,
       added_at = excluded.added_at,
       can_backup = excluded.can_backup,
       can_restore = excluded.can_restore,
       can_manage_admins = excluded.can_manage_admins,
       can_view_records = excluded.can_view_records,
       can_delete_records = excluded.can_delete_records`,
    bind(row),
  );
}

export async function getAdmin(
  db: Database,
  guildId: string,
  userId: string,
): Promise<GuildAdminRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guild_admins WHERE guild_id = ? AND user_id = ?`,
    [guildId, userId],
  );
  const first = rows[0];
  return first === undefined ? null : toAdminRow(first);
}

export async function updateAdmin(db: Database, row: GuildAdminRow): Promise<void> {
  await db.run(
    `UPDATE guild_admins SET
       added_by = ?, added_at = ?, can_backup = ?, can_restore = ?,
       can_manage_admins = ?, can_view_records = ?, can_delete_records = ?
     WHERE guild_id = ? AND user_id = ?`,
    [
      row.added_by,
      row.added_at,
      row.can_backup,
      row.can_restore,
      row.can_manage_admins,
      row.can_view_records,
      row.can_delete_records,
      row.guild_id,
      row.user_id,
    ],
  );
}

export async function setAdminFlags(
  db: Database,
  guildId: string,
  userId: string,
  flags: AdminFlags,
): Promise<void> {
  await db.run(
    `UPDATE guild_admins SET
       can_backup = ?, can_restore = ?, can_manage_admins = ?,
       can_view_records = ?, can_delete_records = ?
     WHERE guild_id = ? AND user_id = ?`,
    [
      flags.can_backup,
      flags.can_restore,
      flags.can_manage_admins,
      flags.can_view_records,
      flags.can_delete_records,
      guildId,
      userId,
    ],
  );
}

export async function removeAdmin(db: Database, guildId: string, userId: string): Promise<void> {
  await db.run("DELETE FROM guild_admins WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
}

export async function listAdminsForGuild(db: Database, guildId: string): Promise<GuildAdminRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guild_admins WHERE guild_id = ? ORDER BY added_at`,
    [guildId],
  );
  return rows.map(toAdminRow);
}

export async function listGuildsForUser(db: Database, userId: string): Promise<GuildAdminRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM guild_admins WHERE user_id = ?`,
    [userId],
  );
  return rows.map(toAdminRow);
}
