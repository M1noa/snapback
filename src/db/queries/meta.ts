// queries/meta.ts. one row per key. holds schema_version for migrations.
//
// every function takes the Database interface first, so it runs against duckdb
// or postgres unchanged. parameters are bound, never interpolated.

import { type SqlValue, toText } from "../rows.ts";
import type { Database, MetaRow } from "../types.ts";

function toMetaRow(raw: Record<string, SqlValue>): MetaRow {
  return {
    key: toText(raw.key) ?? "",
    value: toText(raw.value) ?? null,
  };
}

export async function getMeta(db: Database, key: string): Promise<MetaRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT key, value FROM meta WHERE key = ?",
    [key],
  );
  const first = rows[0];
  return first === undefined ? null : toMetaRow(first);
}

export async function listMeta(db: Database): Promise<MetaRow[]> {
  const rows = await db.query<Record<string, SqlValue>>("SELECT key, value FROM meta ORDER BY key");
  return rows.map(toMetaRow);
}

export async function setMeta(db: Database, key: string, value: string | null): Promise<void> {
  await db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export async function deleteMeta(db: Database, key: string): Promise<void> {
  await db.run("DELETE FROM meta WHERE key = ?", [key]);
}
