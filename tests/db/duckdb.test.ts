import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchInsert, openDuckDB } from "../../src/db/duckdb.ts";
import { migrate } from "../../src/db/migrate.ts";
import { parseJson, stringifyJson, toId } from "../../src/db/rows.ts";
import type { Database, JsonObject, SqlParam } from "../../src/db/types.ts";

// the driver runs against a real temp-file duckdb, not a mock: the bigint, json,
// and multi-row-insert behaviours only show up against the engine.

const ISO = "2024-01-01T00:00:00.000Z";
const SNOWFLAKE = "1234567890123456789"; // 19 digits, above 2^53
const MAX_BITS = "9223372036854775807"; // 2^63-1, the widest a permission bitfield gets

const MESSAGE_COLUMNS = [
  "backup_id",
  "channel_source_id",
  "message_id",
  "author_id",
  "author_username",
  "author_is_bot",
  "pinned",
  "type",
  "created_at",
] as const;
const MESSAGE_SQL = `INSERT INTO backup_messages (${MESSAGE_COLUMNS.join(", ")}) VALUES (${MESSAGE_COLUMNS.map(() => "?").join(", ")})`;

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-duckdb-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("duckdb driver", () => {
  test("a snowflake comes back as a string, the rows.ts boundary", async () => {
    await db.run(MESSAGE_SQL, ["b1", "c1", SNOWFLAKE, "42", "someone", true, false, 0, ISO]);

    const rows = await db.query<{ message_id: string }>(
      "SELECT message_id FROM backup_messages WHERE backup_id = ? AND message_id = ?",
      ["b1", SNOWFLAKE],
    );

    expect(rows).toHaveLength(1);
    const id = rows[0]?.message_id;
    expect(typeof id).toBe("string");
    expect(id).toBe(SNOWFLAKE);
    // numeric ids would round silently here; text is what stops it (db/rows.ts)
    expect(String(Number(SNOWFLAKE))).not.toBe(SNOWFLAKE);
  });

  test("a 64-bit bitfield crosses rows.ts toId as a string", async () => {
    await db.run(
      "INSERT INTO backup_roles (backup_id, source_role_id, name, permissions) VALUES (?, ?, ?, ?)",
      ["b1", "r1", "admin", BigInt(MAX_BITS)],
    );

    const rows = await db.query<{ permissions: bigint }>(
      "SELECT permissions FROM backup_roles WHERE backup_id = ? AND source_role_id = ?",
      ["b1", "r1"],
    );

    const raw = rows[0]?.permissions ?? null;
    expect(typeof raw).toBe("bigint"); // duckdb hands back a js bigint for BIGINT
    expect(toId(raw)).toBe(MAX_BITS); // rows.ts widens it to a string
  });

  test("the batch helper lands the same rows as the single-row path", async () => {
    const n = 2_500; // more than one chunk, so the chunk loop is exercised
    const source = Array.from({ length: n }, (_, i): SqlParam[] => [
      "bBatch",
      `c${i}`,
      String(1_000_000_000 + i),
      "42",
      "someone",
      true,
      false,
      0,
      ISO,
    ]);

    await batchInsert(db, "backup_messages", MESSAGE_COLUMNS, source);

    for (const row of source) {
      const single = [...row];
      single[0] = "bSingle";
      await db.run(MESSAGE_SQL, single);
    }

    const select =
      "SELECT channel_source_id, message_id, author_id, author_is_bot FROM backup_messages WHERE backup_id = ? ORDER BY message_id";
    const batched = await db.query(select, ["bBatch"]);
    const single = await db.query(select, ["bSingle"]);

    expect(batched).toHaveLength(n);
    expect(batched).toEqual(single);
  });

  test("a json column round-trips through rows.ts", async () => {
    const embeds = [{ title: "hello" }, { title: "world", fields: [{ name: "n", value: "v" }] }];
    await db.run(
      "INSERT INTO backup_messages (backup_id, channel_source_id, message_id, author_id, author_username, author_is_bot, pinned, type, created_at, embeds_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["bJson", "c", "1", "42", "someone", false, false, 0, ISO, stringifyJson(embeds)],
    );

    const rows = await db.query<{ embeds_json: string }>(
      "SELECT embeds_json FROM backup_messages WHERE backup_id = ?",
      ["bJson"],
    );

    expect(parseJson<JsonObject[]>(rows[0]?.embeds_json ?? null)).toEqual(embeds);
  });
});
