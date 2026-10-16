// db/duckdb.ts
// the default driver. duckdb owns one file on disk and allows exactly one writer
// process, so a second process opening it for writing fails at open time. that
// open is retried for 30s (D4PLAN 5) and then reported as an SB_-prefixed error
// naming the file, never as the raw driver blob. everything a driver hands back
// crosses db/rows.ts; this file only moves values and owns our error codes.

import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { sleep } from "../lib/sleep.ts";
import type { Database, SqlParam } from "./types.ts";

// our own db-layer errors. one code, one fixed message (AGENTS.md errors).
export type DbErrorCode = "SB_DB_LOCKED" | "SB_DB_OPEN_FAILED" | "SB_DB_CLOSED";

const DB_MESSAGES: Record<DbErrorCode, string> = {
  SB_DB_LOCKED: "the database file is locked by another process, duckdb allows one writer",
  SB_DB_OPEN_FAILED: "the database file could not be opened",
  SB_DB_CLOSED: "this database handle is already closed",
};

export class DbError extends Error {
  readonly code: DbErrorCode;
  constructor(code: DbErrorCode, detail?: string) {
    super(
      detail === undefined
        ? `${code}: ${DB_MESSAGES[code]}`
        : `${code}: ${DB_MESSAGES[code]}: ${detail}`,
    );
    this.name = "DbError";
    this.code = code;
  }
}

// duckdb's lock error arrives at open time, not at first write: a second process
// opening the same file fails inside DuckDBInstance.create. seen verbatim on
// milestone 0:
//   IO Error: Could not set lock on file "<path>": Conflicting lock is held in ...
// match either half so a wording change on one side still catches.
const LOCK_SIGNATURE = /could not set lock on file|conflicting lock is held/i;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 250;

async function openInstance(file: string): Promise<DuckDBInstance> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await DuckDBInstance.create(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!LOCK_SIGNATURE.test(message)) {
        throw new DbError("SB_DB_OPEN_FAILED", `${file}: ${message}`);
      }
      if (Date.now() >= deadline) {
        // named path, not a raw driver string: the operator needs to know which file
        throw new DbError("SB_DB_LOCKED", file);
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

class DuckDBDatabase implements Database {
  readonly kind = "duckdb" as const;
  #instance: DuckDBInstance;
  #conn: DuckDBConnection;
  #closed = false;

  private constructor(instance: DuckDBInstance, conn: DuckDBConnection) {
    this.#instance = instance;
    this.#conn = conn;
  }

  static async open(file: string): Promise<DuckDBDatabase> {
    const instance = await openInstance(file);
    const conn = await instance.connect();
    return new DuckDBDatabase(instance, conn);
  }

  #assertOpen(): void {
    if (this.#closed) throw new DbError("SB_DB_CLOSED");
  }

  async query<T>(sql: string, params?: SqlParam[]): Promise<T[]> {
    this.#assertOpen();
    const reader = await this.#conn.runAndReadAll(sql, params ?? []);
    // driver rows are structurally the row types in types.ts; the generic is the
    // caller's promise about the select list, so the cast is the honest shape.
    return reader.getRowObjectsJS() as unknown as T[];
  }

  async run(sql: string, params?: SqlParam[]): Promise<void> {
    this.#assertOpen();
    await this.#conn.run(sql, params ?? []);
  }

  // a whole script of statements in one call; schema.sql depends on this.
  async exec(script: string): Promise<void> {
    this.#assertOpen();
    await this.#conn.run(script);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#conn.closeSync();
    this.#instance.closeSync();
  }
}

export async function openDuckDB(file: string): Promise<DuckDBDatabase> {
  return DuckDBDatabase.open(file);
}

// one multi-row INSERT is roughly 20x the single-row path (milestone 0: 15.6 ms
// vs 350 ms per 1000). message capture writes up to 10k rows, so the write path
// goes through here. rows are chunked so no single statement carries an
// unbounded parameter list.
const BATCH_CHUNK_ROWS = 1_000;

// table and columns are identifiers, which a driver cannot bind, so they are
// interpolated. callers pass code literals, never a value that came from input;
// every value goes in as a bound parameter.
export async function batchInsert(
  db: Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly SqlParam[])[],
): Promise<void> {
  if (rows.length === 0) return;
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const head = `INSERT INTO ${table} (${columns.join(", ")})`;
  for (let start = 0; start < rows.length; start += BATCH_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + BATCH_CHUNK_ROWS);
    const values = chunk.map(() => tuple).join(", ");
    await db.run(`${head} VALUES ${values}`, chunk.flat());
  }
}
