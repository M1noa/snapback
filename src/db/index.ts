// db/index.ts
// the process's single database handle, and the only module that imports
// config/env.ts. env.ts parses and can exit at import time, so no driver module
// may import it. the handle is created lazily, so a test that imports this file
// but never touches the database does not open one.

import { env } from "../config/env.ts";
import { openDuckDB } from "./duckdb.ts";
import { openPostgres } from "./postgres.ts";
import type { Database } from "./types.ts";

export { batchInsert, DbError } from "./duckdb.ts";
export { migrate, SCHEMA_VERSION } from "./migrate.ts";

let opening: Promise<Database> | undefined;

function open(): Promise<Database> {
  // isPostgres is set iff DATABASE_URL is present (config/parse-env.ts).
  if (env.db.isPostgres && env.db.url !== undefined) {
    return openPostgres(env.db.url);
  }
  return openDuckDB(env.db.file);
}

export function getDatabase(): Promise<Database> {
  opening ??= open().catch((error: unknown) => {
    opening = undefined; // a failed open must not be cached
    throw error;
  });
  return opening;
}

export async function close(): Promise<void> {
  const pending = opening;
  opening = undefined;
  if (pending === undefined) return;
  const db = await pending.catch(() => undefined);
  await db?.close();
}
