// db/migrate.ts
// numbered, idempotent migrations, safe to run on every boot. schema.sql is the
// baseline shape (version 1); each entry in MIGRATIONS is one upgrade past the
// baseline. a migration that has shipped is never edited (AGENTS.md): add a new
// numbered entry instead. the current version lives in meta as 'schema_version'
// (D4PLAN 5.1).

import type { Database, MetaRow } from "./types.ts";

// bump only when a migration is added; schema.sql's shape is version 1.
export const SCHEMA_VERSION = 3;

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

// each entry is numbered above the baseline, lowest first, and runs only if the
// recorded version is below it.
export const MIGRATIONS: readonly Migration[] = [
  // 2: D4PLAN 11.6 keeps a failed self-check on the row. schema.sql shipped as the
  // version 1 baseline without it, so the column is added here, never by editing
  // that file. both duckdb and postgres accept add column if not exists, so this
  // is idempotent like the baseline.
  {
    version: 2,
    sql: "ALTER TABLE backups ADD COLUMN IF NOT EXISTS self_check_json TEXT",
  },
  // 3: the per-guild blacklist (D4PLAN 8). schema.sql carries the same table
  // for a fresh install; this migration is what brings a database that predates
  // it forward. it is a table and not a blob in guilds.settings_json: the list
  // grows, and the pull engine reads it on every join. an entry is a signal
  // for an operator, never a ban (19.4), so nothing here refuses anything.
  {
    version: 3,
    sql: `CREATE TABLE IF NOT EXISTS guild_blacklist (
      guild_id VARCHAR,
      kind VARCHAR,
      value VARCHAR,
      added_by VARCHAR,
      added_at VARCHAR,
      reason TEXT,
      PRIMARY KEY (guild_id, kind, value)
    )`,
  },
];

const SCHEMA_KEY = "schema_version";
const SCHEMA_FILE = new URL("./schema.sql", import.meta.url);

async function readVersion(db: Database): Promise<number> {
  const rows = await db.query<MetaRow>("SELECT value FROM meta WHERE key = ?", [SCHEMA_KEY]);
  const value = rows[0]?.value;
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}

async function writeVersion(db: Database, version: number): Promise<void> {
  // on-conflict-do-update is accepted by both duckdb and postgres.
  await db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [SCHEMA_KEY, String(version)],
  );
}

export async function migrate(db: Database): Promise<void> {
  // schema.sql is one idempotent script; it is the baseline, applied first.
  await db.exec(await Bun.file(SCHEMA_FILE).text());

  let current = await readVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await db.exec(migration.sql);
    current = migration.version;
    await writeVersion(db, current);
  }

  if (current < SCHEMA_VERSION) {
    await writeVersion(db, SCHEMA_VERSION);
  }
}
