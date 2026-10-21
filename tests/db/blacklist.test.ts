// tests/db/blacklist.test.ts
//
// the blacklist table (D4PLAN 8): the migration that brings an old database
// forward, the round trip through the query module, and the key that keeps one
// entry per (guild, kind, value).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../src/db/duckdb.ts";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/db/migrate.ts";
import {
  addBlacklistEntry,
  findBlacklistEntries,
  getBlacklistEntry,
  listBlacklistEntries,
  removeBlacklistEntry,
} from "../../src/db/queries/blacklist.ts";
import type { Database, GuildBlacklistRow, MetaRow } from "../../src/db/types.ts";

const SCHEMA = new URL("../../src/db/schema.sql", import.meta.url);

const GUILD = "123456789012345678";
const OTHER_GUILD = "222222222222222222";
const USER = "987654321098765432";
const OWNER = "111111111111111111";
const AT = "2024-06-01T12:00:00.000Z";

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-blacklist-db-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function tableExists(name: string): Promise<boolean> {
  const rows = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ?",
    [name],
  );
  return rows.length > 0;
}

async function recordedVersion(): Promise<number> {
  const rows = await db.query<MetaRow>("SELECT value FROM meta WHERE key = 'schema_version'");
  return Number(rows[0]?.value);
}

function entry(overrides: Partial<GuildBlacklistRow> = {}): GuildBlacklistRow {
  return {
    guild_id: GUILD,
    kind: "user_id",
    value: USER,
    added_by: OWNER,
    added_at: AT,
    reason: null,
    ...overrides,
  };
}

describe("the blacklist table", () => {
  test("an old database is brought forward and the table is created", async () => {
    // an old database: the baseline, recorded at version 2, without the table.
    await db.exec(await Bun.file(SCHEMA).text());
    await db.run("DROP TABLE guild_blacklist");
    await db.run(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '2') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    expect(await tableExists("guild_blacklist")).toBe(false);
    expect(await recordedVersion()).toBe(2);

    await migrate(db);

    expect(await tableExists("guild_blacklist")).toBe(true);
    expect(await recordedVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
  });

  test("the migration itself creates the table", async () => {
    const migration = MIGRATIONS.find((item) => item.version === 3);
    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("guild_blacklist");

    await db.run("DROP TABLE IF EXISTS guild_blacklist");
    await db.exec(migration?.sql ?? "");

    expect(await tableExists("guild_blacklist")).toBe(true);
  });
});

describe("the blacklist query module", () => {
  test("round-trips a row", async () => {
    const added = await addBlacklistEntry(
      db,
      entry({ kind: "asn", value: "AS15169", reason: "a hosting network" }),
    );
    expect(added).toBe(true);

    const read = await getBlacklistEntry(db, GUILD, "asn", "AS15169");
    expect(read?.guild_id).toBe(GUILD);
    expect(read?.kind).toBe("asn");
    expect(read?.value).toBe("AS15169");
    expect(read?.added_by).toBe(OWNER);
    expect(read?.added_at).toBe(AT);
    expect(read?.reason).toBe("a hosting network");
  });

  test("an entry is unique per guild, kind and value", async () => {
    const added = await addBlacklistEntry(db, entry({ value: "555000111222333444" }));
    expect(added).toBe(true);

    // the same entry again is not a second row.
    const again = await addBlacklistEntry(db, entry({ value: "555000111222333444" }));
    expect(again).toBe(false);

    const rows = await listBlacklistEntries(db, GUILD);
    const same = rows.filter((row) => row.value === "555000111222333444");
    expect(same).toHaveLength(1);
    // the one that was there first is the one that stayed.
    expect(same[0]?.added_by).toBe(OWNER);

    // the same value under another kind is another entry.
    expect(
      await addBlacklistEntry(db, entry({ kind: "ip_hash", value: "555000111222333444" })),
    ).toBe(true);
    // and another guild keeps its own list.
    expect(
      await addBlacklistEntry(db, entry({ guild_id: OTHER_GUILD, value: "555000111222333444" })),
    ).toBe(true);
  });

  test("finds the entries that name a value, and removes one", async () => {
    await addBlacklistEntry(db, entry({ kind: "ip_hash", value: "sha256-of-an-address" }));

    const found = await findBlacklistEntries(db, GUILD, "ip_hash", [
      "sha256-of-an-address",
      "another-hash",
    ]);
    expect(found.map((row) => row.value)).toEqual(["sha256-of-an-address"]);
    // another guild's list is not this one's.
    expect(
      await findBlacklistEntries(db, OTHER_GUILD, "ip_hash", ["sha256-of-an-address"]),
    ).toEqual([]);
    // no values, no query.
    expect(await findBlacklistEntries(db, GUILD, "ip_hash", [])).toEqual([]);

    expect(await removeBlacklistEntry(db, GUILD, "ip_hash", "sha256-of-an-address")).toBe(true);
    expect(await removeBlacklistEntry(db, GUILD, "ip_hash", "sha256-of-an-address")).toBe(false);
    expect(await getBlacklistEntry(db, GUILD, "ip_hash", "sha256-of-an-address")).toBeNull();
  });
});
