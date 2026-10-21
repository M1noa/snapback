# Self-hosting

Postgres or DuckDB, the files on disk, backing up the database itself, retention, the scheduler switch, and an honest list of what a restore does not bring back.

## Database

The database driver is chosen from `DATABASE_URL`. There is no ORM; one thin helper layer sits over two drivers that both implement the same `Database` interface (`query`, `execute`, `transaction`, `close`).

| `DATABASE_URL` | Driver | Notes |
|---|---|---|
| unset | DuckDB | a file at `./data/snapback.duckdb` |
| `postgres://user:pass@host:5432/dbname` | Postgres via Bun's SQL | use when you want concurrency |

The schema is one portable `schema.sql` plus numbered migrations. Snowflakes are `BIGINT` in the database and strings everywhere else; the conversion happens only in the database layer.

### DuckDB is single-writer

DuckDB allows one writer process. The bot owns the file, and the web server runs in the same process, so it shares the connection pool. If you point two processes at the same file, the second one gets a lock error. `db/duckdb.ts` opens with a busy timeout, retries the lock for 30 seconds, and then exits with a message naming the file it could not lock. If you want the bot and a separate site process, use Postgres.

## Files on disk

| Path | Holds |
|---|---|
| `data/snapback.duckdb` | the DuckDB file when `DATABASE_URL` is unset |
| `backups/<backup_id>/assets/` | downloaded icons, emojis, stickers, soundboard sounds, role icons, and attachments for one backup |
| `data/exports/` | exported files, each with an `expires_at` and swept when it passes |
| `data/dbip-country-lite.mmdb` | db-ip lite data file, path from `DBIP_COUNTRY_MMDB`; not fetched, db-ip gates its downloads |
| `data/ip2asn.tsv` | address to ASN table, path from `IP2ASN_TSV` |
| `data/as-metadata.json` | ipverse `as-metadata`, path from `AS_METADATA_JSON` |
| `data/tor-exit-addresses.txt` | Tor exit nodes, path from `TOR_EXIT_LIST` |

Assets are downloaded rather than referenced, because Discord CDN URLs for emojis, stickers, and avatars are signed and expire. A backup that stores bare URLs restores blank icons six months later.

Whether the `backups/` directory sits inside `data/` is not pinned down in `D4PLAN.md`. The plan writes the asset path as `backups/<backup_id>/assets/` and the export path as `data/exports/`, and `.gitignore` covers `data/`. Confirm the real path on your install before you build a backup rotation around it.

## Backing up the database itself

`/setup data` reports the database status and size, backs up the database, and exports everything to JSON. The export is the migration path: every backup row, every record, and every job as a zip.

Tokens are encrypted with a key held outside the database, so restoring the database alone does not expose them. Exports never contain tokens, by construction in the serialiser. The key in `ENCRYPTION_KEY` is the thing to keep safe, and losing it means existing tokens cannot be decrypted. Whether the database copy from `/setup data` is a consistent snapshot of a live DuckDB file or a checkpointed copy is not stated in `D4PLAN.md`; for a Postgres deployment use `pg_dump` at the storage layer, and for DuckDB stop the bot before copying the file if you want a guaranteed-consistent copy.

## Intel data files

Geolocation runs locally from four files. No API keys, no per-request cost, no third party seeing your users' addresses.

| Purpose | Source | Format | Licence | Refresh |
|---|---|---|---|---|
| country, city, region, ASN | db-ip lite (Country and City/ASN editions) | MMDB | CC-BY | monthly; the filename carries `YYYY-MM` |
| address to ASN | the RIR delegation files | TSV | public | weekly |
| ASN to org name and type | ipverse `as-metadata` | JSON | CC0-1.0 | weekly |
| tor exit nodes | the Tor Project's exit list | text | public | daily |

`INTEL_UPDATE=true` (the default) lets the bot fetch the three files it does not need an account for, at boot when one is missing and every six hours when one is stale. A failed download keeps the file already on disk.

The MMDB reader is `maxmind` (the `node-maxmind` package), which is MIT. The reader licence is the permissive part; the **data** is the licensed part.

**db-ip attribution.** The db-ip lite data is licensed CC-BY, which requires attribution. The copyright line that ships with the db-ip download must be reproduced verbatim in `docs/privacy.md` and kept in this file. `D4PLAN.md` does not reproduce that exact string, so copy it from the db-ip lite download page when you install the data file; do not paraphrase it.

**ipverse** `as-metadata` is published under CC0-1.0 and needs no attribution.

If the data files are absent, Snapback skips geolocation with a warning in `/snapback status` and keeps running. It never crashes on a missing file.

## Retention

Retention lives in the `retention_policies` table per guild: `keep_days`, `keep_count`, `keep_kind` (which kinds are eligible: `manual`, `auto`, `pre_restore`), and `enabled`. The scheduler sweeps hourly.

Pruning is deterministic:

1. The newest backup is never deleted, whatever the policy says. A policy that would leave zero backups keeps one.
2. A backup referenced by a queued or running job is never deleted.
3. `pre_restore` backups go first, then `auto`, then `manual`, oldest first.
4. `keep_days` removes anything older than the window; `keep_count` removes anything past the newest N. Both rules apply together, so a backup is removed if either rule removes it.
5. Rows and asset files are deleted together. Asset files with no row are swept as orphans.

`/backup prune` runs it with `dry_run` on by default and reports what would go, with reasons. The numbers are set from that page: **set the policy** opens a modal with the day limit and the count limit, both optional. Blank means no rule, and clearing both disables pruning. `keep_kind` has no control yet and stays `null`, which means every kind is eligible.

Retention applies to verification records too, not only backups. A guild that sets `keep_days: 90` has records older than 90 days deleted by the same sweep, with the count reported.

## The scheduler switch

`AUTOMATION_ENABLED=false` disables the scheduler entirely, so every job is manual. With it on, one ticker reads due work from the database every 15 seconds and owns: due auto-backups, due auto-restores, the token refresh sweep, the retention sweep, the daily counter reset at 00:05 UTC, the orphan webhook sweep at startup and every 6 hours, the export expiry sweep, and the interaction-state TTL sweep. Each run is idempotent.

## What is not preserved on restore

Stated plainly so nobody discovers it during a recovery.

Not backed up at all:

- **Voice and stage states.** Ephemeral by nature.
- **Invites.** Captured for the record and flagged "not restorable", because Discord will not let you re-create an invite with the same code.
- **Presences, typing, read states.** Not exposed by Discord.
- **Guild features** such as verified, partnered, vanity URL, and discovery. A bot cannot set them.
- **Bot-managed and integration roles.** Discord refuses to create or delete them. They are captured and re-linked by name where a matching integration exists in the target, otherwise reported as "not restorable".
- **Message attachment bytes**, when the file is over the download ceiling or its signed URL has expired. Those are recorded with `url: null` and reported as "attachment could not be preserved" rather than dropped silently.

Backed up but changed by restore:

- **Message timestamps.** Restore posts through a webhook and Discord stamps the message at post time. It cannot be forged. The optional `restore_message_timestamp_suffix` appends a relative-timestamp line to each message; it is off by default because it changes content.
- **Reactions, pins, and threads on restored messages** are off in the default path. Reactions need one request each and are off unless enabled; pins are off unless enabled.
- **Message ids and reply chains.** Replies cannot be rethreaded, because the reply target's id changed. Backup records the relationship; restore posts replies as plain messages and says so in the report.
- **Author identity.** A restored message appears from the webhook, which impersonates the author's name and avatar but is not the author. Anyone hovering sees the webhook's name.

The 250-role and 500-channel guild caps are not hard-blocked. The restore lets Discord return its own error and surfaces the parsed code.
