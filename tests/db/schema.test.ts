import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

// the schema is the contract every query is written against, so it gets loaded
// for real rather than eyeballed. a syntax error or a duplicate index name only
// shows up when an engine parses the whole file.

const SCHEMA = new URL("../../src/db/schema.sql", import.meta.url);

// the tables the schema holds. D4PLAN 5.1 lists every one of them, the two
// blacklist tables included. a table added to one and not the other is the
// failure this list exists to catch.
const EXPECTED_TABLES = [
  // core
  "meta",
  "guilds",
  "guild_admins",
  "guild_blacklist",
  "blacklist_attempts",
  "jobs",
  "job_progress",
  "audit_log",
  "interaction_state",
  "oauth_states",
  // backups
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
  // verification
  "verify_panels",
  "verify_records",
  "verify_record_events",
  "verify_signals",
  "pull_attempts",
  "account_counters",
  // retention and export
  "retention_policies",
  "pending_exports",
  "tracked_events",
] as const;

let dir: string;
let instance: DuckDBInstance;
let conn: DuckDBConnection;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-schema-"));
  instance = await DuckDBInstance.create(join(dir, "schema.duckdb"));
  conn = await instance.connect();
});

afterAll(() => {
  conn?.closeSync();
  instance?.closeSync();
  rmSync(dir, { recursive: true, force: true });
});

async function loadSchema(): Promise<void> {
  await conn.run(await Bun.file(SCHEMA).text());
}

describe("schema.sql", () => {
  test("loads in one call, with every table present", async () => {
    await loadSchema();

    const reader = await conn.runAndReadAll(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
    );
    const found = reader.getRowObjectsJS().map((row) => String(row.table_name));

    expect(found.sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  test("is idempotent, so migrate can run it every boot", async () => {
    await expect(loadSchema()).resolves.toBeUndefined();
  });

  test("stores ids as text, never as a number type", async () => {
    const reader = await conn.runAndReadAll(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'backups'",
    );
    const types = new Map(
      reader.getRowObjectsJS().map((row) => [String(row.column_name), String(row.data_type)]),
    );

    // a snowflake or uuid in a numeric column is the bug the string boundary exists to stop
    expect(types.get("backup_id")).toBe("VARCHAR");
    expect(types.get("guild_id")).toBe("VARCHAR");
    expect(types.get("created_by")).toBe("VARCHAR");
    // a permission bitfield stays text: 64 bits does not survive a double
    expect(types.get("member_count")).not.toBe("DOUBLE");
  });

  test("keeps a bitfield as a 64-bit integer, which rows.ts hands over as a string", async () => {
    // D4PLAN 5.1 writes these as "(BIGINT string)": BIGINT in the column, a
    // decimal string in the app, converted in exactly one place (rows.ts).
    // A DISCORD permission bitfield uses no more than 64 bits, so BIGINT holds
    // it; DOUBLE would silently round above 2^53.
    for (const table of ["backup_roles", "backup_channel_overwrites"]) {
      const reader = await conn.runAndReadAll(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table}'`,
      );
      const types = new Map(
        reader.getRowObjectsJS().map((row) => [String(row.column_name), String(row.data_type)]),
      );
      for (const column of ["permissions", "allow", "deny"]) {
        if (types.has(column)) expect(types.get(column)).toBe("BIGINT");
      }
    }
  });
});
