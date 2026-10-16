// db/postgres.ts
// the postgres driver, on Bun.sql (present in bun 1.3.14, so no extra
// dependency). it satisfies the same Database interface as duckdb.ts. this repo
// has no postgres server to run against, so the file is deliberately thin and its
// behaviour is unverified here; the query shapes it must accept are the ones the
// duckdb tests already exercise.
//
// app sql uses ? for parameters, the duckdb-native form. postgres wants $1..$n,
// so toPositional rewrites the placeholders before the call.

import { SQL } from "bun";
import { DbError } from "./duckdb.ts";
import type { Database, SqlParam } from "./types.ts";

// a literal ? inside a string in app sql would be miscounted; no query does that.
function toPositional(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class PostgresDatabase implements Database {
  readonly kind = "postgres" as const;
  #sql: SQL;
  #closed = false;

  private constructor(sql: SQL) {
    this.#sql = sql;
  }

  static async open(url: string): Promise<PostgresDatabase> {
    const sql = new SQL(url);
    try {
      await sql.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DbError("SB_DB_OPEN_FAILED", message);
    }
    return new PostgresDatabase(sql);
  }

  #assertOpen(): void {
    if (this.#closed) throw new DbError("SB_DB_CLOSED");
  }

  async query<T>(sql: string, params?: SqlParam[]): Promise<T[]> {
    this.#assertOpen();
    return await this.#sql.unsafe<T[]>(toPositional(sql), params ?? []);
  }

  async run(sql: string, params?: SqlParam[]): Promise<void> {
    this.#assertOpen();
    await this.#sql.unsafe(toPositional(sql), params ?? []);
  }

  // a whole script in one call, matching duckdb's exec. multi-statement support
  // under Bun.sql is unverified here (no server).
  async exec(script: string): Promise<void> {
    this.#assertOpen();
    await this.#sql.unsafe(script);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.close();
  }
}

export async function openPostgres(url: string): Promise<Database> {
  return PostgresDatabase.open(url);
}
