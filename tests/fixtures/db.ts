// a real temp-file duckdb, migrated for real, so a capture test exercises the
// boundary rather than a mock: an id that crosses as a string, a bitfield that
// survives above 2^53, and migration 2's self_check_json column present.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../src/db/duckdb.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertBackup } from "../../src/db/queries/backups.ts";
import type { BackupRow, Database } from "../../src/db/types.ts";
import { BACKUP_SCHEMA_VERSION } from "../../src/services/backup/types.ts";
import { FIXTURE_BACKUP_ID, FIXTURE_GUILD_ID } from "./guild.ts";

const ISO = "2024-01-01T00:00:00.000Z";
const dirs: string[] = [];

export async function openFixtureDb(): Promise<Database> {
  const dir = mkdtempSync(join(tmpdir(), "snapback-fixture-"));
  dirs.push(dir);
  const db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
  return db;
}

export async function closeFixtureDb(db: Database): Promise<void> {
  await db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeBackup(overrides: Partial<BackupRow> = {}): BackupRow {
  return {
    backup_id: FIXTURE_BACKUP_ID,
    guild_id: FIXTURE_GUILD_ID,
    label: "fixture",
    kind: "manual",
    guild_name: "fixture guild",
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: null,
    member_count: 0,
    message_count: 0,
    channel_count: 0,
    role_count: 0,
    size_bytes: 0,
    schema_version: BACKUP_SCHEMA_VERSION,
    guild_settings_json: null,
    onboarding_json: null,
    welcome_screen_json: null,
    widget_json: null,
    afk_json: null,
    self_check_json: null,
    created_at: ISO,
    created_by: FIXTURE_GUILD_ID,
    ...overrides,
  };
}

/**
 * a fresh backup_id per insert: a suite that seeds several backups in one database
 * must not collide on the primary key. makeBackup's fixed id stays available for a
 * caller that wants a predictable one.
 */
export async function insertFixtureBackup(
  db: Database,
  overrides: Partial<BackupRow> = {},
): Promise<BackupRow> {
  const row = makeBackup({ backup_id: Bun.randomUUIDv7(), ...overrides });
  await insertBackup(db, row);
  return row;
}
