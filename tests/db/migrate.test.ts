import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../src/db/duckdb.ts";
import { migrate, SCHEMA_VERSION } from "../../src/db/migrate.ts";
import type { Database, MetaRow } from "../../src/db/types.ts";

// the tables the schema holds. D4PLAN 5.1 lists 29; guild_blacklist is the one
// the blacklist research item added, and the plan needs a row for it. a table
// added to the schema and not to the plan, or vice versa, is the drift this
// list exists to catch.
const EXPECTED_TABLES = [
  "meta",
  "guilds",
  "guild_admins",
  "guild_blacklist",
  "jobs",
  "job_progress",
  "audit_log",
  "interaction_state",
  "oauth_states",
  "backups",
  "backup_roles",
  "backup_channels",
  "backup_channel_overwrites",
  "backup_threads",
  "backup_members",
  "backup_messages",
  "backup_bans",
  "backup_emojis",
  "backup_stickers",
  "backup_sounds",
  "backup_automod",
  "backup_events",
  "backup_tags",
  "verify_panels",
  "verify_records",
  "verify_record_events",
  "verify_signals",
  "pull_attempts",
  "account_counters",
  "retention_policies",
  "pending_exports",
  "tracked_events",
] as const;

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-migrate-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function tableNames(): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
  );
  return rows.map((row) => row.table_name);
}

async function recordedVersion(): Promise<number> {
  const rows = await db.query<MetaRow>("SELECT value FROM meta WHERE key = 'schema_version'");
  return Number(rows[0]?.value);
}

describe("migrate", () => {
  test("a fresh database migrates to the current version", async () => {
    await migrate(db);
    expect(await recordedVersion()).toBe(SCHEMA_VERSION);
  });

  test("every table from D4PLAN 5.1 exists after migrating", async () => {
    const found = await tableNames();
    expect(found.sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  test("running it again is a no-op", async () => {
    const before = await tableNames();
    const versionBefore = await recordedVersion();

    await migrate(db);

    expect(await tableNames()).toEqual(before);
    expect(await recordedVersion()).toBe(versionBefore);
    expect(versionBefore).toBe(SCHEMA_VERSION);
  });
});
