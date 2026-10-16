// phase 0 spike: prove @duckdb/node-api works under bun before any db code exists.
// prints findings, exits non-zero on a hard failure. throwaway, not app code.
import { mkdirSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const DB_PATH = "data/spike.duckdb";
const SNOWFLAKE = "1234567890123456789";

function say(line = ""): void {
  console.log(line);
}
function section(n: string): void {
  say(`\n== ${n} ==`);
}

// run a construct, return the error message verbatim or null on success.
async function attempt(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  }
}

mkdirSync("data", { recursive: true });

section("versions");
say(`bun: ${Bun.version}`);
say(`Bun.sql present: ${typeof (Bun as { sql?: unknown }).sql}`);

// --- 1. open a file database ---
section("open");
const t0 = performance.now();
const instance = await DuckDBInstance.create(DB_PATH);
const tCreate = performance.now();
const conn = await instance.connect();
const tConnect = performance.now();
say(`create: ${(tCreate - t0).toFixed(2)} ms`);
say(`connect: ${(tConnect - tCreate).toFixed(2)} ms`);

// --- 2. multi-statement DDL, the way db/schema.sql will run ---
section("multi-statement DDL");
const ddl = `
CREATE TABLE spike_messages (
  message_id VARCHAR PRIMARY KEY,
  guild_id BIGINT,
  created_at VARCHAR,
  payload JSON,
  pinned BOOLEAN
);
CREATE INDEX idx_spike_messages_guild ON spike_messages (guild_id);
CREATE TABLE spike_meta (key VARCHAR PRIMARY KEY, value VARCHAR);
`;
const multiErr = await attempt(() => conn.run(ddl));
if (multiErr === null) {
  say("one call, several statements: ACCEPTED");
} else {
  say(`one call: REJECTED -> ${multiErr}`);
  say("workaround: split on ';' and run each");
  for (const stmt of ddl.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed.length === 0) continue;
    await conn.run(trimmed);
  }
  say("split statements: ran clean");
}

// --- 3. varchar pk + bigint snowflake, report the exact JS type ---
section("bigint snowflake");
const createdAt = new Date().toISOString(); // iso-8601 stored as varchar
const insertSql =
  "INSERT INTO spike_messages (message_id, guild_id, created_at, payload, pinned) VALUES (?, ?, ?, CAST(? AS JSON), ?)";
const insertErr = await attempt(() =>
  conn.run(insertSql, [
    "0191f1cf-0000-7000-8000-000000000000", // uuidv7-shaped string
    BigInt(SNOWFLAKE),
    createdAt,
    '{"content":"hi","attachments":[]}',
    true,
  ]),
);
say(`insert with CAST(? AS JSON): ${insertErr === null ? "ok" : `FAILED -> ${insertErr}`}`);

const reader = await conn.runAndReadAll(
  "SELECT message_id, guild_id, created_at, pinned FROM spike_messages LIMIT 1",
);
await reader.readAll();
const rows = reader.getRowObjects();
const row = rows[0];
const gid = row?.guild_id;
say(`bigint value: ${String(gid)}`);
say(`typeof: ${typeof gid}`);
say(`constructor.name: ${gid === null || gid === undefined ? "n/a" : gid.constructor.name}`);
say(`round-trips exactly: ${String(gid) === SNOWFLAKE}`);
// note: DuckDBType.toString() lies for JSON (prints VARCHAR); .alias is the real type when set.
say(
  `schema column type: ${reader.columnType(1)?.alias ?? reader.columnType(1)?.toString() ?? "n/a"}`,
);
say(`boolean value: ${String(row?.pinned)} (typeof ${typeof row?.pinned})`);
say(`varchar timestamp: ${String(row?.created_at)}`);

// --- 4. portable constructs ---
section("portable constructs");

const orIgnoreErr = await attempt(() =>
  conn.run(
    "INSERT OR IGNORE INTO spike_messages (message_id, guild_id, created_at, payload, pinned) VALUES (?, ?, ?, CAST(? AS JSON), ?)",
    ["0191f1cf-0000-7000-8000-000000000000", BigInt(SNOWFLAKE), createdAt, "{}", false],
  ),
);
say(
  `INSERT OR IGNORE: ${orIgnoreErr === null ? "ok (duplicate pk ignored)" : `FAILED -> ${orIgnoreErr}`}`,
);

const jsonCastErr = await attempt(() =>
  conn.run("INSERT INTO spike_messages VALUES (?, ?, ?, CAST(? AS JSON), ?)", [
    "0191f1cf-0000-7000-8000-000000000002",
    BigInt(SNOWFLAKE),
    createdAt,
    '{"nested":{"a":1}}',
    true,
  ]),
);
say(`CAST(? AS JSON): ${jsonCastErr === null ? "ok" : `FAILED -> ${jsonCastErr}`}`);

const jsonRead = await conn.runAndReadAll(
  "SELECT payload FROM spike_messages WHERE message_id = ?",
  ["0191f1cf-0000-7000-8000-000000000002"],
);
await jsonRead.readAll();
const jsonVal = jsonRead.getRowObjects()[0]?.payload;
say(
  `json read back: ${String(jsonVal)} (typeof ${typeof jsonVal}, ctor ${jsonVal === null || jsonVal === undefined ? "n/a" : jsonVal.constructor.name})`,
);
say(
  `json column type: ${jsonRead.columnType(0)?.alias ?? "n/a"} (typeId ${jsonRead.columnTypeId(0)})`,
);

const boolErr = await attempt(() =>
  conn.run("INSERT INTO spike_messages VALUES (?, ?, ?, CAST(? AS JSON), ?)", [
    "0191f1cf-0000-7000-8000-000000000003",
    BigInt(SNOWFLAKE),
    createdAt,
    "{}",
    false,
  ]),
);
say(`BOOLEAN insert: ${boolErr === null ? "ok" : `FAILED -> ${boolErr}`}`);

const trueColErr = await attempt(() =>
  conn.run("ALTER TABLE spike_meta ADD COLUMN enabled BOOLEAN"),
);
say(`ALTER ADD BOOLEAN: ${trueColErr === null ? "ok" : `FAILED -> ${trueColErr}`}`);

// --- 5. timing: open + 1000 inserts ---
section("timing");
await conn.run(
  "CREATE TABLE spike_bench (id VARCHAR PRIMARY KEY, guild_id BIGINT, created_at VARCHAR)",
);
const ins = await conn.prepare(
  "INSERT OR IGNORE INTO spike_bench (id, guild_id, created_at) VALUES (?, ?, ?)",
);
const N = 1000;
const tStart = performance.now();
await conn.run("BEGIN TRANSACTION");
for (let i = 0; i < N; i++) {
  const id = `0191f1cf-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;
  ins.bindVarchar(1, id);
  ins.bindBigInt(2, BigInt(SNOWFLAKE));
  ins.bindVarchar(3, createdAt);
  await ins.run();
}
await conn.run("COMMIT");
const tInserts = performance.now();
const total = tInserts - tStart;
say(`open + connect: ${(tConnect - t0).toFixed(2)} ms`);
say(`${N} inserts (one transaction, prepared): ${total.toFixed(2)} ms`);
say(`per insert: ${(total / N).toFixed(3)} ms`);
say(`extrapolated 10k: ${((total / N) * 10000).toFixed(0)} ms`);
const count = await conn.runAndReadAll("SELECT count(*) AS c FROM spike_bench");
await count.readAll();
say(`rows landed: ${String(count.getRowObjects()[0]?.c)}`);

// bulk variant: one multi-row INSERT, the shape a real backup writer would use.
await conn.run(
  "CREATE TABLE spike_bench_bulk (id VARCHAR PRIMARY KEY, guild_id BIGINT, created_at VARCHAR)",
);
const tuples: string[] = [];
const bulkParams: (string | bigint)[] = [];
for (let i = 0; i < N; i++) {
  tuples.push("(?, ?, ?)");
  bulkParams.push(
    `0191f1d0-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
    BigInt(SNOWFLAKE),
    createdAt,
  );
}
const tBulk = performance.now();
await conn.run(
  `INSERT INTO spike_bench_bulk (id, guild_id, created_at) VALUES ${tuples.join(",")}`,
  bulkParams,
);
const bulkMs = performance.now() - tBulk;
say(`${N} inserts (one multi-row statement): ${bulkMs.toFixed(2)} ms`);
say(`extrapolated 10k bulk: ${((bulkMs / N) * 10000).toFixed(0)} ms`);

// --- 6. close cleanly ---
section("close");
conn.closeSync();
instance.closeSync();
const closedErr = await attempt(() => conn.run("SELECT 1"));
say(
  `after close, query returns: ${closedErr === null ? "ran (unexpected)" : `error as expected -> ${closedErr}`}`,
);
say("\nspike done");
