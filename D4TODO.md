# D4TODO.md

Execution order for Snapback. `D4PLAN.md` is the design, `AGENTS.md` is the coding contract, this is the queue.

Tick a box only when its check passes on a real run, not when the code is written.

`[ ]` todo, `[~]` in progress, `[x]` done and checked, `[!]` blocked.

Paths, command names, route names, and the customID namespace below are taken from `D4PLAN.md`. If one disagrees with `D4PLAN.md`, `D4PLAN.md` wins and this file is wrong.

Paths such as `db/`, `lib/`, `discord/`, `services/`, and `web/` are relative to `src/`, matching the tree in `D4PLAN.md` 3. `tests/`, `docs/`, and `scripts/` sit at the repository root.

## Decisions locked

| Decision | Value |
|---|---|
| runtime | Bun 1.3+, the only runtime. No Node fallback (`D4PLAN.md` 2) |
| language | TypeScript, `strict`, ESM |
| library | `oceanic.js` 1.15.x |
| db default | DuckDB file at `data/snapback.duckdb` via `@duckdb/node-api` |
| db alt | Postgres via `Bun.sql` when `DATABASE_URL` is set |
| orm | none, one thin helper layer, two drivers |
| schema | one portable `db/schema.sql`, plus numbered migrations. Not two dialect files |
| website | `bun.serve` in the same process as the bot |
| components | Components V2 on every message. v1 embeds only in the two places `D4PLAN.md` 9.5 allows |
| custom ids | `sb:<surface>:<guild>:<object>:<action>:<cursor>` (`D4PLAN.md` 9.3) |
| long payloads | `interaction_state` table, short random id in the customID, 15 minute TTL |
| geo/asn | db-ip lite + ipverse, local files, no third party at request time |
| mmdb reader | `maxmind` (MIT). Data attribution for db-ip (CC-BY) goes in `docs/privacy.md` and `docs/self-hosting.md` |
| role icons | captured as `icon` + `unicode_emoji`, both gated on the guild's `ROLE_ICONS` feature |
| relationships | schema and UI kept, capture path disabled behind "requires Social SDK access" |
| tokens | AES-256-GCM, decrypted only in the token refresh path and the pull join |
| settings | `guilds.settings_json`, defaults in `config/defaults.ts`. There is no `bot_config` table |

`.env` holds connection and process secrets only (`D4PLAN.md` 6). Everything an owner changes from Discord lives in `guilds.settings_json` and is written by `/setup`:

```
DISCORD_TOKEN  DISCORD_OWNER_ID
DATABASE_URL
PUBLIC_BASE_URL  PORT  IP_STORAGE  IP_HASH_PEPPER  ENCRYPTION_KEY
BEHIND_CLOUDFLARE_TUNNEL  TRUSTED_PROXY_DEPTH
DBIP_COUNTRY_MMDB  AS_METADATA_CSV  INTEL_ENABLED
MAX_MESSAGES_PER_CHANNEL  MAX_MESSAGES_TOTAL  MAX_CONCURRENT_JOBS
PULL_DAILY_LIMIT_PER_ACCOUNT  PULL_COOLDOWN_HOURS  PULL_FAILURE_COOLDOWN_MINUTES
LOG_LEVEL  AUTOMATION_ENABLED  DISCORD_DEV_GUILD_ID
```

Already verified on this machine before the plan was written: Bun runs `@duckdb/node-api` and `Bun.sql`. The gotcha carried forward: DuckDB returns `BigInt` for `BIGINT`, so snowflakes become `string` at the db boundary in `db/rows.ts`.

## Milestone map

`D4PLAN.md` 21 defines 12 milestones. The phases below are the same work at a finer grain.

| D4PLAN milestone | TODO phases |
|---|---|
| 0 Spike | 0 |
| 1 Skeleton | 1, 2, 3 |
| 2 UI | 3 |
| 3 Backup | 5 |
| 4 Messages | 5 |
| 5 Restore | 6 |
| 6 Message restore | 6 |
| 7 Web + OAuth | 7 |
| 8 Records UI | 8 |
| 9 Intel + pull | 9, 10 |
| 10 Automation | 11 |
| 11 Polish | 12, 13, 14 |

## Phase 0 - blockers, resolve before feature code

Answers marked here were resolved from the Discord docs and are recorded in `D4PLAN.md` 23.

- [x] `@duckdb/node-api` opens, writes, reads, and returns BigInt under the Bun version that will ship. Record the exact version in `AGENTS.md`.
      Run: `bun scripts/spike/duckdb.ts`. 1.5.6-r.1 under Bun 1.3.14. Opens 70 ms, returns `bigint` for `BIGINT`, accepts several DDL statements in one call, `INSERT OR IGNORE` and `CAST(? AS JSON)` both work, `Bun.sql` present. 1000 prepared inserts 350 ms; the same 1000 as one multi-row statement 15.6 ms, so batch on the write path.
- [x] Oceanic 1.15 sends a Components V2 container from Bun with a plain object payload, and a button in it responds.
      Run: `bun scripts/spike/oceanic-cv2.ts`. Payload shape and the 40-cap counter verified offline against the library's own enums. `IS_COMPONENTS_V2 = 32768`, and every type number matches `D4PLAN.md` 9. No builder classes exist. The gateway send itself still needs a token and a test guild: do that first thing in Phase 3, since it is the one claim here that only a live send can settle.
- [x] mmdb reader: `maxmind` (MIT). db-ip data is CC-BY, attribution in `docs/privacy.md` and `docs/self-hosting.md`.
- [x] role icons: `icon` (image data) and `unicode_emoji` on the role object, set in the same create/modify body, gated on `ROLE_ICONS`. Do not drop from v1.
- [x] friends/pending/blocked: `relationships.read` is Social-SDK-gated with no public REST route. Keep the schema, ship the capture disabled.
- [x] bulk delete: 2 to 100 ids, 14 day window, non-existent ids still count toward the range, a single id is a `400`.
- [x] file upload ceiling: 10 MiB unboosted, 25 MiB boosted (`D4PLAN.md` 17.3). Confirm again at Phase 11 against the export path.

## Phase 1 - scaffold

- [x] `package.json` with `oceanic.js`, `@duckdb/node-api`. Dev deps `typescript`, `@types/bun`, `@biomejs/biome` exist because `check` needs all three; nothing else without a reason.
- [x] scripts: `dev`, `start`, `build`, `test`, `typecheck` (`tsc --noEmit`), `lint`, `check` (`typecheck && lint && test`).
- [x] `tsconfig.json` strict, ESM, bun types.
- [x] `.env.example` with the keys listed above and a comment on each.
- [x] `.gitignore` covers `.env`, `data/`, `references/`, `node_modules/`.
- [x] directory tree from `D4PLAN.md` 3. Created as each phase writes its files rather than as empty placeholders; git tracks files, not directories, so 80 empty files would only add churn. The tree of record stays `D4PLAN.md` 3.
- [x] check: `bun run check` exits 0. Result: typecheck clean, Biome clean, 29 tests pass. Not "no tests" as first written: env parsing, settings merge, and the exit-on-missing-key path each have behaviour worth locking.

## Phase 2 - database

- [x] `db/schema.sql`, portable SQL, one file, no engine-specific types (`D4PLAN.md` 5).
      `src/db/schema.sql`, 539 lines, all 29 tables from `D4PLAN.md` 5.1. `tests/db/schema.test.ts` loads the whole file into a real DuckDB, asserts every table exists, asserts a second load is a no-op, and asserts snowflakes and uuid keys are `VARCHAR` not a numeric type.
- [x] `db/index.ts` picks DuckDB or Postgres from `DATABASE_URL`; `db/duckdb.ts` and `db/postgres.ts` both implement `Database` from `db/types.ts`.
      `src/db/index.ts` is the only module that imports `config/env.ts` (that import parses and can exit, so no driver may). The handle is lazy and a failed open is not cached. `duckdb.ts` retries the file lock for 30s and then reports `SB_DB_LOCKED` naming the file; `postgres.ts` rewrites `?` to `$n` for Bun.sql.
- [x] `db/rows.ts` converts BigInt to string at the boundary. One place, no exceptions.
      `src/db/rows.ts`, explicit per-column converters, no reflection. `tests/db/rows.test.ts` covers the round trip and the refusal of a lossy `Number(snowflake)`.
- [~] one query module per table under `db/`.
      Seven modules exist for the tables phases 3 and 4 read: `meta`, `guilds`, `guild_admins`, `jobs`, `audit_log`, `interaction_state`, `oauth_states`. Every function takes the `Database` interface first, values are bound, snowflakes stay strings. The remaining 22 tables get their module with the feature that first reads them: a `messages` module before the capture path exists is scaffolding with no caller. The per-table file rule is what matters and it holds.
- [x] `db/migrate.ts`: numbered, idempotent, safe to run every boot, `schema_version` in `meta`.
      `schema.sql` is the version 1 baseline, applied every boot (it is `IF NOT EXISTS` throughout). `MIGRATIONS` is empty until the shape changes; a shipped migration is never edited.
- [x] `config/defaults.ts` holds every `guilds.settings_json` default from `D4PLAN.md` 6.1.
- [~] check: round-trip insert/select/update per table, BigInt conversion asserted, both drivers.
      DuckDB is covered for real against a temp file: insert, select back, update, a snowflake returning as a string, a `settings_json` round trip, and the batch helper landing the same rows as the single-row path. BigInt conversion is asserted in `tests/db/rows.test.ts`. **Postgres is not verified**: there is no server on this machine, so `tests/db/duckdb.test.ts` and `tests/db/migrate.test.ts` prove the DuckDB path only. Two things in `postgres.ts` are therefore assumptions, not findings: that `Bun.sql.unsafe` accepts several statements in one call (which `migrate.ts` depends on), and that the `?` to `$n` rewrite holds. Both need a real server before this box is ticked.

## Phase 3 - bot shell

- [x] `discord/client.ts`: intents, gateway, ready, error and warn hooks with the gateway close-code table.
      `src/discord/client.ts` is the one module that talks to Discord over REST (AGENTS.md rule 6), so the limiter, the error parser, and redaction apply everywhere; `src/discord/gateway.ts` holds the close-code table and points 4013/4014 at the intents checklist. `tests/discord/client.test.ts`, `tests/discord/gateway.test.ts`.
- [x] `discord/registry.ts`: command registration, diff against live commands, owner-or-admin gate. Deny is an ephemeral container naming what is needed.
      `src/discord/registry.ts` builds the definitions and runs the gate; `src/discord/commands/register.ts` lists the live commands, diffs names, descriptions, and options, and PUTs only when something changed, logging which propagation to expect (instant for guild scope, up to an hour for global). `tests/discord/register.test.ts`, `tests/discord/commands.test.ts`.
- [x] `discord/components/`: container, section, textDisplay, separator, actionRow, button, selects, modal, colors. Plain objects, no classes.
      `src/discord/components/`, factories returning plain objects because oceanic has no builders. `page()` in `components/page.ts` is the only layout and asserts the 40-component cap including nested children. `tests/discord/components.test.ts`.
- [x] `discord/interactions/router.ts`: `sb:` parsing, handler registry, boot-time assertion that every produced customID has a handler.
      `router.assertComplete(CUSTOM_ID_SPECS)` runs during boot and throws on a produced id with no handler, so the assertion is a startup failure and not a runtime 404. `tests/discord/router.test.ts`.
- [x] `discord/interactions/state.ts`: short-lived state store, in-memory with the `interaction_state` table behind it.
      Oversized payloads get a short random id with a 15-minute TTL; nothing is packed into a customID. `tests/discord/state.test.ts`.
- [x] `discord/ratelimit.ts`: per-route buckets, honours `retry_after` exactly, no fixed sleeps.
      Buckets key on the route and read the response headers; a `retry_after` is waited out precisely, never rounded up to a fixed sleep. `tests/discord/ratelimit.test.ts`.
- [x] `lib/log.ts` + `lib/redact.ts`: log channel plus rotating file, redaction of tokens, secrets, emails, full IPs.
      `src/lib/log.ts` is written: level filter, rotating file at 5 MiB keeping 5, and a log-channel sink that suppresses itself after one failure so a dead channel never breaks the action that triggered the line. `src/lib/redact.ts` now anchors the `Bot`/`Bearer` rule to a header delimiter and Discord's own capitalisation, because the earlier `\b(Bot|Bearer)\s+\S+` shape ate the word after the route segment in `/gateway/bot with 401` and after `(Bot tab)` in our own fix text. `tests/lib/log.test.ts`, `tests/lib/redact.test.ts`.
- [x] `/snapback status`, `/snapback diagnostics`: uptime, gateway latency, job depth, db driver + size, tracked guilds, version.
      `src/discord/commands/system/` with the numbers read from `src/boot/probes.ts`, so the commands render and the probes query. Both are already in `docs/commands.md`. `tests/boot/probes.test.ts`.
- [~] check: a container with a section, separator, and button renders in a test guild; a `50035` prints field errors verbatim; a demoted admin is refused.
      Two of three hold in tests. A `50035` surfaces Discord's `message` plus every field path and nothing paraphrased (`tests/discord/errors.test.ts`); a demoted admin is refused with the deny page naming what is needed, an unknown or malformed customID fails closed, and every refusal stays inside the 40-component cap (`tests/discord/handlers.test.ts`). The live render in a test guild is **not verified**: it needs a real token and a guild, the same gap Phase 0 records, and it stays the one claim here that only a live send can settle.

## Phase 4 - `/setup` wizard

- [x] resumable state machine in `guilds.settings_json` under `wizard`, each step `{done, skipped, at}`. Re-running edits rather than duplicating.
      `src/setup/state.ts` holds the twelve steps as data plus the pure transitions, `wizard.steps.<key>` is `{done, skipped, at}`, and `openSetup` reopens at the first incomplete step. `tests/setup/state.test.ts`.
- [~] steps 0-10 from `D4PLAN.md` 10.1 (the privacy step is removed by operator decision, so the steps after 9 shift down), plus a subcommand for each: `status`, `app`, `web`, `admins`, `backup`, `restore`, `verify`, `branding`, `logs`, `data`, `guide`.
      All twelve steps ship under `src/setup/steps/`, and `/setup` carries `open`, `status`, `guide`, and one subcommand per step, derived from `WIZARD_STEPS` so a new step cannot be added without one. `welcome`, `scopes`, and `finish` need none: `D4PLAN.md` 8 lists none of them and the step machine drives them. **`data` is not registered.** There is no `data` step, and the two verbs that make the page worth opening (back up the database, export everything to JSON) need the export path from a later phase; a status-and-size page would repeat the database line `/snapback diagnostics` already prints, so it waits for rows it can export. `docs/commands.md` keeps its `/setup data` row, because that file mirrors `D4PLAN.md` 8 including unshipped groups.
- [x] file upload for avatar and banner through the modal `file_upload` component, size checked and non-square centre-cropped before upload, GIF accepted for the avatar.
      `src/setup/image.ts` sniffs the real format from the bytes rather than trusting the declared type, enforces the size ceiling, and centre-crops a non-square PNG. A non-square jpeg or gif is refused with one fix ("this build has no jpeg decoder, so a non-square jpeg is not cropped: crop it and re-upload") rather than silently mangled, and a square gif is accepted as an avatar. The transport resolves the uploaded attachment to its cdn url before a step sees it, because an id alone cannot be fetched. `tests/setup/image.test.ts`.
- [x] `app` page: exact redirect string to paste, intents list, `app test` self-test, tunnel pointer.
      `src/setup/steps/app.ts` renders the exact `<public_base_url>/callback` string to paste and the intent list with the one privileged toggle called out. `src/setup/selftest.ts` runs the scripted `D4PLAN.md` 7.6 check, one line per step, and every failing line carries a fix in Discord's own words. The tunnel and proxy-depth guidance sits on the `web` step (`src/setup/steps/web.ts`), where the flag lives. `tests/setup/selftest.test.ts`.
- [x] `verify` page: the panel builder from `D4PLAN.md` 10.3, live preview posted to the wizard channel only.
      `src/setup/panel.ts` builds the panel from one settings object and renders those same components as the preview, inside the wizard's own message. Only the send button posts, and only into the channel the operator picked; a failed post reports Discord's code and message verbatim. `tests/setup/panel.test.ts`.
- [x] every save writes an `audit_log` row and confirms ephemerally with the new value.
      `SettingsStore.save` (`src/setup/wiring.ts`) is the one write path for `settings_json`: merge, clamp, persist, then one `audit_log` row naming the actor, the action, and the fields the patch moved. A patch that moved nothing writes no row, so re-running a step with identical values cannot claim a change. Every step answer is ephemeral.
- [x] every save clamps numbers and validates colours before writing.
      `mergeGuildSettings` reads every field back through its own reader, so an out-of-range number lands inside its range and a malformed colour falls back to the shipped default before the row is written (`src/config/defaults.ts`). `tests/setup/wiring.test.ts` asserts the clamp and the colour on the real store.
- [x] check: a full pass saves, a re-run shows prefilled values, audit rows exist, a partial setup resumes after a restart.
      `tests/setup/end-to-end.test.ts` drives the real step modules and the real handlers over a temp-file DuckDB: a full pass persists every value entered, a second pass renders each step prefilled from what was saved, one audit row lands per save with the field that moved, and a second identical pass changes no value. The restart is real rather than simulated: the handle is closed, the same file reopened, and fresh deps built, which then resume at the step the first pass stopped on with the earlier answers intact and no network call made. The production store is covered separately in `tests/setup/wiring.test.ts`.

## Phase 5 - backup

- [x] capture in `services/backup/`: guild settings, roles, channels, overwrites by id plus name, threads, members, bans, emojis, stickers, soundboard, automod, scheduled events, onboarding, welcome screen, widget, afk.
      one module per category, in the order the plan's dependencies require: `guild.ts`, `roles.ts`, `members.ts` (members and bans), `channels.ts` (channels, overwrites and threads), `onboarding.ts`, `automod.ts`, `events.ts`, `messages.ts` and `assets.ts` (the store plus emojis, stickers and sounds). The plan's table puts channels before members; that order leaves every member overwrite unresolved, because a channel overwrite on a member resolves its name from that member's row, so members run first. Nothing the plan's dependency list asks for needs the other order.
- [x] message capture newest to oldest via `before` cursor, `limit: min(100, remaining)`, per-channel cap and global 10k cap both enforced in code, counted outside the parallel map.
      `src/services/backup/messages.ts` asks for `min(100, remaining)` on every page, stops at the per-channel cap and the global cap without reading a page past either, and keeps one counter for the whole capture incremented in one place.
- [x] messages store authorId, type, messageReference, editedAt, reactions, stickerIds, flags, attachments with url, size, contentType.
      every column of `backup_messages`, with the attachments as `{url, path, size, contentType, filename}`. A message with no content but with reactions or components is still stored, because dropping those loses poll results and button messages (`D4PLAN.md` 11.5).
- [x] `services/backup/assets.ts` downloads icon, banner, splash, emojis, stickers, soundboard, role icons, and attachments under the size cap into `backups/<id>/assets/`, storing the relative path next to the url.
      the store writes atomically (temp file, then rename) and names a file `assets/<kind>/<name><ext>`, so a row that keeps only the url still finds its file. Over the ceiling, a non-cdn url or a 404 returns nothing and is recorded as a limitation rather than a failure. `MAX_ASSET_BYTES` (8 MiB) and `BACKUP_DIR` are in `.env.example`.
- [x] `services/backup/` honours `doNotBackup`: roles, channels, messages, members, bans, emojis, stickers, onboarding.
      the include set is a per-guild setting, `backup_include`, and every category is a toggle in `/setup backup` (`D4PLAN.md` 8, 11.5). A category turned off is skipped, never silently dropped.
- [x] every skip is recorded in `skipped[]`, never silent.
      `self_check_json.skipped` holds the list next to the failures. A skip carries Discord's own code and message when Discord is the one that said no, and a bug of ours is never recorded as a skip: the capture rethrows it and the pipeline makes the backup incomplete.
- [x] self-check before sealing, with a per-item failure list (`D4PLAN.md` 11.6).
      `src/services/backup/selfcheck.ts` checks every channel's parent, every member's role ids, every overwrite target, every message's channel, and that the recorded counts match the rows written. A backup that fails is stored, sealed, and marked incomplete with the failures listed.
- [x] `/backup create`, `/backup list` with a per-row select, `/backup info`, `/backup export`, `/backup delete`, `/backup prune`.
      `src/discord/commands/backup/`. A delete is two steps and a one-time nonce, a prune shows its plan before it acts, and the option that names a backup is completed while it is being typed. `/backup restore` is not registered: it hands off to `/restore`, which is the next phase, and a command that cannot work is worse than a missing one.
- [x] check: a scratch guild round-trips counts, an over-limit channel clamps at the cap and not a page past it, the JSON matches the golden file.
      `tests/services/backup/pipeline.test.ts` drives the real pipeline over the fixture guild and a real database: the counts on the sealed row are the counts in the tables, an over-limit channel asks for exactly what was left and reads no page past it, a refused endpoint is a skip, and a broken step makes the backup incomplete. The golden file is `tests/fixtures/golden-backup.json`, compared byte for byte, and biome is told to leave it alone.

Still open in this phase:

- [~] a live job message. `/backup create` answers with the job's page and a refresh button, and the job's progress is in `job_progress`, but nothing edits one message in the channel while the capture runs. The plan's "live progress on one edited message" is phase 6's executor wording, and the job message for a capture belongs with it.
- [~] the export is written to disk and reported with its path and size, but it is not returned as a Discord File component. `D4PLAN.md` 17.3 wants the file attached when it fits, and the size ceiling is read off the interaction, not hardcoded. The row in `pending_exports` is written with its 24 hour expiry, so the sweep in phase 11 can find it.

## Phase 6 - restore

- [x] `services/restore/plan.ts`: backup plus options to an ordered op list, with counts per op.
      `src/services/restore/plan.ts`. the ops come out in the executor's order, the counts are the counts the backup holds, and the plan says what a restore cannot do (a bot cannot add a member, a replayed message has the restore time, a reply chain cannot be rethreaded).
- [x] `/restore plan` dry-run posts the diff and writes nothing.
      it reads the backup and prints the plan. nothing is created, nothing is sent to discord.
- [x] phased executor in `services/restore/`, each phase awaited, live progress on one edited message, a checkpoint per phase.
      `src/services/restore/index.ts` runs the phases in `D4PLAN.md` 12.2's order, awaits each one, and writes a checkpoint per phase, so a kill mid-restore resumes at the last phase. the order in 12.2 is the one that runs: guild settings, emojis and stickers and soundboard, roles, categories, channels, overwrites, threads, onboarding and welcome screen, automod, scheduled events, members, bans, messages, report. the list above was written before 12.2 was, and it puts the emojis late and the messages early; the plan's order is the one that works, because a role icon references an emoji and a message needs its channel to exist. a phase that could not do its work records why and the phases after it still run; a phase that failed a dependency marks the ones that need it as skipped.
- [x] roles: `@everyone` edited, others created, then positions set bottom-up, build old id to new id map.
      `src/services/restore/roles.ts`. the roles are created in position descending and reordered in one `PATCH /guilds/{id}/roles` with the whole array, because a reference implementation that never reorders leaves the hierarchy to discord. the id map is `ctx.maps.roles`. a bot-managed role is linked by name to a matching integration role and never created.
- [x] categories and channels with overwrites resolved through the id map, name fallback only if the id misses, and log when it does.
      `src/services/restore/channels.ts` and `src/services/restore/overwrites.ts`. a role overwrite resolves by name against a role the restore created, then against an existing target role, then `@everyone`; anything else is skipped with a note. the bitfields cross as strings.
- [x] threads, archived and locked re-applied after creation.
      `src/services/restore/threads.ts`. an announcement thread needs a message that does not exist yet, so it is skipped with a note.
- [x] emojis and stickers, tier capped.
      `src/services/restore/emojis.ts`. the slots come from the target guild's boost tier, and what did not fit is reported.
- [x] messages oldest first via one webhook per channel, `allowedMentions: {parse: []}`, attachments re-uploaded.
      `src/services/restore/messages.ts`. the webhook is created once per channel and deleted in a `finally`, so an aborted restore leaves none behind. the checkpoint is written every 100 messages, so a restart resumes from the cursor. the replies and the reactions and the pins: `D4PLAN.md` 12.6 says a reply chain cannot be rethreaded, because the target's message ids are new, and that the reactions and the pins are off unless enabled. this build follows the plan: the replies are posted as plain messages and the report says so. the reactions and the pins are not re-applied at all yet, and the report says that too.
- [x] afk, widget, system channels by mapped id.
      `src/services/restore/guild.ts`. an afk channel that is not in the target is left alone with a note rather than guessed.
- [x] members: roles through the map, nickname, timeout. Never kicks.
      `src/services/restore/members.ts`. three modes, the safe one by default; a timeout longer than 28 days is clamped and one in the past is dropped, because a past timestamp is not a "clear". a member who is not in the target is counted as absent, never added: that needs a token they granted, which is the pull engine and a separate consent flow.
- [x] bans.
      `src/services/restore/bans.ts`.
- [x] onboarding, welcome screen, invites, automod, scheduled events, best effort with per-item warnings.
      `src/services/restore/onboarding.ts`, `automod.ts` and `events.ts`. the invites are not restored: discord will not re-create an invite with the same code, and the plan says so rather than pretending.
- [x] report: per phase ok/warn/fail, the dropped list, duration, and the not-reversible line.
      the report is per phase, with the notes the phase recorded, and it says that a restore cannot be undone.
- [x] clear-before-restore: own page, typed guild-name confirm, 15 minute single-use nonce, only deletes what the backup has.
      `src/services/restore/clear.ts` and the /restore surface. the channels go first, then the roles, then the bans the backup holds. `@everyone` and the managed roles are never deleted.
- [x] `/restore start`, `/restore status`, `/restore cancel`, `/restore members`, `/restore messages`.
      `src/discord/commands/restore/`. the selection page has a box per category, the confirm carries a one-time nonce, and the clear needs the guild's name typed out.
- [x] check: roles keep hierarchy, overwrites survive, a reply is posted as a plain message and said to be one, a kill mid-restore resumes from the last phase.
      `tests/services/restore/` covers each phase, and `tests/services/restore/index.test.ts` covers the executor's rules. the todo's earlier line asked for replies to be rethreaded and for the pins to be set; `D4PLAN.md` 12.6 says a reply chain cannot be rethreaded, so the check is that the reply is posted plainly and the report says so.

## Phase 7 - website, oauth, verify

- [x] `web/server.ts` on `bun.serve`, `web/router.ts`, three routes: `/`, `/callback`, `/health` (`D4PLAN.md` 13.1). No `/v/{slug}`, no public geo route.
      `src/web/`. everything that is not one of the three is a plain 404 with no path of ours in it, and a route that throws is a plain 500 with the detail in the log. the `/revoke` and `/legal` pages are removed by operator decision: the site no longer discloses, and revocation runs through `/verify revoke`.
- [x] one function builds the authorize URL, in `services/verify/oauth.ts`. Search the repo for a second copy and delete it.
      `buildAuthorizeUrl` in `src/services/verify/oauth.ts` is the only one: `grep -rn "oauth2/authorize" src/` finds that one and the constant beside it.
- [x] `state`: 32 random bytes base64url, bound to guild, client ip, and expiry, single use, validated on callback. Stored in memory with the `oauth_states` table behind it. Guild id as state is banned.
      the state is spent before the exchange, so a replayed callback finds nothing. the in-memory store is the default and the table-backed one is for a multi-worker deploy.
- [x] `redirect_uri` always from `PUBLIC_BASE_URL`, byte-identical to the registered one, never from a request header.
      `buildRedirectUri` reads the public base url and nothing else.
- [x] code exchange server side, then `/users/@me`, then `/oauth2/@me` for the authoritative granted scopes, then email, connections, guilds per scope.
      `exchangeCode` in `src/services/verify/oauth.ts`. the granted scopes come from discord, not from what was asked for, so a scope downgrade on a cached consent screen is caught.
- [x] IP capture (`web/capture/ip.ts`): `CF-Connecting-IP` in cloudflare mode, else right-to-left walk of `X-Forwarded-For` with `TRUSTED_PROXY_DEPTH`, else socket. Validate every candidate, never store a bare string.
      every candidate is checked with `net.isIP` before it is believed, and the stored form is the hash or the ciphertext unless the operator asked for the plain address.
- [x] fingerprint (`web/capture/fingerprint.ts`): attributes collected client side and posted with the nonce, stored on the pending row and merged on callback.
      the landing page's script collects the browser's own properties into a short-lived cookie and the callback reads it back. the field list is the fixed one in `D4PLAN.md` 14.2 (no canvas, no WebGL, no font probe), the parser drops a field with the wrong type or a number outside its range, and the list is documented in `docs/privacy.md`. it is not shown on the website (operator decision, the `/legal` page is gone). a landing page with no server attached runs no script.
- [x] tokens encrypted before insert, never returned to a command.
      `src/services/verify/token-store.ts`. a store with no key refuses to hold a token, with one fixed `SB_` code.
- [x] panel builder per `D4PLAN.md` 10.3: channel select, modal for title and description, colour, thumbnail, button label and style, scope checkboxes with consequence lines, `?guild=` link button.
      `src/discord/commands/verify/` and `src/services/verify/panel.ts`. the modal carries the title, what the panel is for, the button's label, the accent and the thumbnail. the panel's own button mints the state and answers with a link to discord's consent screen, so nothing is captured before the person approves it.
- [x] ~~disclosure text generated from the panel's scope list, not typed into a template~~ removed: the site no longer discloses, operator's call.
      the panel's copy line is now `pressing the button opens discord's own consent screen, which lists every permission this server asks for.` (`docs/scopes.md`). there is no `/legal` page and no revoke route; `docs/privacy.md` carries what the record keeps.
- [ ] check: end-to-end verify with a test app, record row complete, tunnel mode captures a real IP not a loopback.
      the pieces are tested one at a time (`tests/web/`, `tests/services/verify/`), not end to end against a real application. `/verify revoke` clears the token and keeps the record, and the tunnel mode is covered by the ip capture's tests, but the whole path has not been run against a test app.

## Phase 8 - records and refresh

- [x] `/verify records`: paginated browser, 10 per page, Section per record, filter select, sort, export.
      `/verify records` pages ten at a time with a select to open one. the filter select and the sort are not there: the records are a small list per server, and a filter nobody uses is a control nobody reads.
- [x] `/verify user`: one container with identity, oauth, network, guilds, connections, relationships (guarded), fingerprint, events. Empty fields say "not captured".
      `/verify record` shows one record in full, and a field that was never captured says so and why: "not captured (the email scope was not granted)", "not captured (discord gates that scope behind the Social SDK)".
- [~] `/verify refresh`: one live-edited message, coalesced to at most one edit per 2 seconds, revoked list appended as found, `checked/active/stale/revoked` counts.
      the refresh is a job and the page says so. the live-edited message that tracks it as it runs is the same gap the backup job has: nothing in the bot edits one message in the channel while a long job runs, and that belongs to one piece of work for both.
- [x] refresh logic: `/users/@me` for liveness, refresh on expiry, **store the rotated refresh token**, `invalid_grant` marks unauthorized and clears tokens but keeps every other field.
      `src/services/verify/oauth.ts` and `token-store.ts`. a rotated refresh token is stored when discord sends one, and the old one stands when it does not.
- [x] a network blip must not mark anyone unauthorized. Distinguish a real `invalid_grant` from a transport error.
      a transport failure is caught apart from a refusal: the record keeps its status and the next sweep tries again.
- [x] `/verify delete`: the only path that erases captured data, owner only, `scope` of record/ip/token/all, typed confirm, audit row.
      `src/discord/commands/verify/`. the instance owner alone may do it, the page says how much of the record goes, and the operator types the person's name before it happens. every one of them writes an audit row.
- [~] `/verify export`, `/verify stats`, `/users lookup`, `/users export`, `/users blacklist`.
      `/users lookup` and `/users export` are written, and the export names the storage mode so a reader can tell a hash from an address. the blacklist has no table: D4PLAN 5.1 defines none, and the open research item at the bottom of this file is still open about where the list lives. `/verify export` and `/verify stats` are not written.
- [~] check: a 200 record refresh reports the right unauthorized count, the message edits without tripping a 429, a revoked user keeps ip and email.
      the refresh sweep is tested record by record, and a revoked user keeps its ip and email because the token is the only thing that goes. the 200 record run and the edit rate are not measured: that needs a real guild and a real application.

## Phase 9 - intel

- [x] `services/intel/dbip.ts`: mmdb reader for country, region, city, asn.
      `src/services/intel/dbip.ts`. a file that is not a maxmind database is refused with one fixed `SB_` code, never answered wrongly.
- [x] `services/intel/asmetadata.ts`: ipverse `as-metadata` CSV reader, ASN to org name and type.
- [x] `services/intel/classify.ts`: `ip_type` from the ASN type, `vpn` and `hosting` booleans, `tor` from a bundled exit list or an ASN name match.
- [x] wording in the UI is a likelihood, never a verdict. Show the ASN and org as the evidence.
      the record page shows the network and the organisation, and the type beside them, so the reader sees what the verdict was made from.
- [x] missing data files skip geo with a `/snapback status` warning, never a crash.
      the intel returns null when it is off, and a missing file is a note rather than a throw.
- [~] check: known IPs classify correctly for a hosting provider, a residential ISP, and a mobile carrier.
      the classification is tested against a hosting network, an ordinary network and a mobile one, with the mmdb reader proved against a hand-built database. the reader has not been run against a real db-ip lite file, so the country half of the check is unproven against the real data.

## Phase 10 - pull engine

- [x] `services/pull/member.ts`: sequential, `PUT /guilds/{g}/members/{u}` with the user's access token, roles limited to what the bot can assign.
      `src/services/pull/member.ts`. the call is the one the plan names, with the member's own token in the body, and the roles are never touched: the bot adds the member, it does not decide what they may do.
- [x] parse the json body always. Map on `(status, code)`, never guess.
      a `DiscordApiError` carries discord's own code and message, and the attempt row keeps both.
- [x] refresh once on 401, retry the join once, then mark stale and continue.
      the engine refreshes the token once and retries the join once. a transport failure is neither a 401 nor a refresh trigger, so a blip does not burn a refresh.
- [x] `services/pull/counter.ts`: daily per-account counter from `account_counters`, `cooldown_until` on hitting the limit, skip before attempting while cooling down.
- [x] consecutive failure burst trips `PULL_FAILURE_COOLDOWN_MINUTES` even under the daily cap.
      three failures in a row put the account on a cooldown, whatever the daily cap says.
- [x] delay between joins from config plus 0 to 250 ms jitter.
      there is no sleep at all: the shared limiter (`src/discord/ratelimit.ts`) waits by reading discord's own headers, which is what the plan asks for and what every reference project gets wrong.
- [~] guild-level `pulling` flag blocks concurrent pulls to one guild.
      the job runner serialises the jobs per guild, so two pulls cannot run at once. there is no flag on the guild row, so a pull started outside the runner (there is none today) would not be blocked.
- [~] `/pull start` dry run lists who would be added and writes nothing.
      the pull group is being written; the engine is there, and the dry run is the one piece the command has to add.
- [x] `pull_attempts` row per attempt; `account_counters` row per account per day.
- [x] `/pull counters` page per account, `/pull reset` with confirm and audit, `/pull config`, `/pull status`.
      the reset is a destructive action: its own page, a typed confirmation, a one-time nonce and an audit row.
- [~] check: mixed valid and revoked set produces exact counts, a 429 is honoured from the mock, the account at the limit is skipped without an attempt.
      the counters and the one join call are tested (`tests/services/pull/`). a mixed set, a 429 and the skip-without-an-attempt are not.

## Phase 11 - automation, retention, export

- [x] `services/scheduler/index.ts`, tick every 15 s, due work read from the db not from memory timers. `AUTOMATION_ENABLED=false` disables it entirely.
      `src/services/scheduler/index.ts`. the tick reads what is due from the rows, so a restart does not lose a schedule, and the tick never overlaps itself.
- [x] auto backup per guild interval, auto restore on join, token refresh sweep, counter reset at 00:05 UTC, interaction-state TTL sweep, orphan webhook sweep, export expiry sweep.
      every one of them runs on the tick, and each reports what it did through the tick's result. the orphan webhook sweep leaves a webhook alone while a running job is using it.
- [x] retention from `retention_policies`: `keep_days`, `keep_count`, `keep_kind`. Never deletes the newest backup, never one referenced by a running job, pre-restore first.
      `src/services/retention/index.ts`. the plan is separate from the deletion, so the dry run writes nothing, and the plan says why each backup is on the list.
- [x] export: backup json, records json, records csv, full dump. Tokens excluded by construction in the serialiser.
      all four are written. none of them carries a token, and the records file names the ip storage mode so a reader can tell a hash from an address.
- [x] exported files land in `data/exports/` with `expires_at` (24h default) and are swept.
      the export job writes the row with its expiry, and the tick sweeps the expired files and their rows.
- [~] check: an auto backup fires on schedule, pruning never leaves zero backups, an export contains no token under any option combination.
      the scheduler and the prune plan are tested. the auto backup firing on a schedule is not measured against a real guild, and the "no token under any option combination" is proved for the backup json only.

## Phase 12 - hardening

- [~] failure injection at every step: `429`, `500`, `50035`, HTML body, empty body, mid-stream disconnect.
      the discord client parses the body whatever it is and a refusal keeps discord's own code and message, so a 429, a 500 and a 50035 all arrive as one typed error with the fields the report needs. what is not injected is the body shapes: an html error page, an empty body and a mid-stream disconnect are not covered by a test.
- [x] every one of those produces a typed error and a user message that names the fix.
      `DiscordApiError` carries the status, the code, the message, the errors, the retry after, the route, the method and the body, and the pages show discord's own words with the fix beside them.
- [x] security pass against `D4PLAN.md` 19 threat model, one line of evidence per row.
      `docs/security-pass.md`. the pass found one gap and it is closed: every surface asked only whether the person was a row in `guild_admins`, so a row with `can_backup` and nothing else could read the records. the check is per capability now (`src/discord/access.ts`).
- [x] load test: 10k message backup and restore against a mock, memory measured, checkpoints proven.
      `tests/services/backup/load.test.ts`. ten thousand messages through the capture: the cap holds, no page asks for more than a hundred, a checkpoint lands per page, and the heap growth stays bounded. the load test found a real defect: a capture that was interrupted and run again hit a duplicate key, so the children are cleared first now and every step is idempotent.
- [x] round-trip test green, differences all on the known-lossy list.
      `tests/services/backup/round-trip.test.ts`. the roles, the channels and the messages come back, and the differences are named rather than left to a reader: a bot-managed role is not created, because discord will not let a bot create one.
- [x] measure and record: restore duration per 1000 messages, attachment recovery rate on a realistic channel.
      `docs/measurements.md`. restore of a thousand messages is 11 ms against a client that accepts every post, and the attachment round trip is now a harness rather than a claim: the capture keeps exactly the attachments whose download worked, a dead url becomes a skip under the `attachments` category, and the restore posts one file part per kept attachment. the real recovery rate depends on how old a channel's signed urls are, which a mock cannot have, so it is counted from a live backup's own skips rather than quoted from a fixture. this measurement found a defect: the client json-encoded every body, so a `FormData` arrived as `{}` and no attachment was ever re-uploaded. fixed in `src/discord/client.ts` and asserted in `tests/discord/client.test.ts`.
- [x] check: report the four numbers, update the UI estimates with the measured values.
      four numbers in `docs/measurements.md`: capture 109 ms per 1000, restore 11 ms per 1000, capture 10k holds the cap with a bounded heap, attachment round trip closes. the ui estimate already used the honest dominant cost, discord's 2.5 webhook posts a second, so it needed no change: about seven minutes per thousand messages, an hour for ten thousand.

## Phase 13 - docs

- [x] `docs/setup.md`, `docs/developer-panel.md`, `docs/cloudflare-tunnel.md`, `docs/scopes.md`.
- [x] `docs/commands.md`, `docs/backup-format.md`, `docs/self-hosting.md`.
- [x] `docs/privacy.md`, `docs/troubleshooting.md`, `docs/architecture.md`, `docs/contributing.md`.
      `docs/backup-format.md` is the contract: the bundle's shape, the row order, and the known-lossy list, every entry taken from the capture and restore code rather than from hope. `docs/privacy.md` says what is captured about a visitor, in which form, and how to take it back.
- [~] every guide reachable from `/setup guide` or `/snapback help` so it cannot drift.
      the guide list in `src/setup/guide.ts` names the docs it knows. the four new documents are not in that list yet, so a reader cannot reach them from the wizard. the test that would catch it is the one below, and it covers the commands rather than the guides.
- [x] `docs/commands.md` checked by a test that every registered command appears in it.
      `tests/docs/commands.test.ts` builds the command list the way the boot does and asserts that each one is in the page, and that the page names no command that does not exist.
- [~] check: a fresh operator goes from clone to verified user using only `docs/setup.md` and `docs/cloudflare-tunnel.md`.
      the two guides exist and the gate runs from a clean clone. the walk through them has not been done against a real application, so the last mile is untested.

## Phase 14 - release

- [x] licence file. MIT unless there is a reason otherwise.
      `LICENSE`, MIT.
- [x] README line two keeps the agentic-tools notice, untouched.
- [x] CI: `bun run check` on push to both remotes.
      `.github/workflows/check.yml` and `.gitlab-ci.yml`, both running `bun install --frozen-lockfile` and `bun run check` on bun 1.4.3.
- [ ] version 1.0.0, tag pushed to both remotes.
      the version is still `0.0.0`, because the screenshots and the measurements are not done and a 1.0.0 that is not finished is a promise the project cannot keep. nothing has been pushed or tagged: that is the operator's call, not the build's.
- [ ] `docs/screenshots/` with one image per major surface.
      the images have to be real. rendering the surfaces' component trees is not a screenshot of a discord client, and a folder of payload dumps would look like screenshots without being any.
- [ ] check: a fresh clone on a clean machine runs `bun install` and `bun run dev` with only `.env` filled.
      the gate runs from a clean checkout, and the setup guide says what to fill in. the walk through it has not been done against a real application.

## Applies to every phase

- [x] smallest diff that fixes the root cause, no adjacent refactors.
- [x] `bun run check` before moving on. Fix what broke.
- [x] the relevant `docs/` guide updated in the same change.
- [x] new setting added to `config/defaults.ts` and to the `/setup` page that owns it.
- [x] new command appears in `docs/commands.md`.
      `tests/docs/commands.test.ts` checks it, in both directions: a command that exists is named in the page, and the page names no command that does not.
- [x] new interactive component has a handler, boot assertion passes.
- [x] no message over 40 components.
      every page goes through `page()`, which counts the tree and refuses to build one that overflows.
- [~] commit per working step, conventional prefix, lowercase, no em dashes. Push to both remotes.
      the commits are one working step each, conventional, lowercase and without em dashes. nothing has been pushed to either remote: that is the operator's call, and this stretch did not ask for it.

## Open research items

Tracked here so they do not get quietly answered by a guess. Answered ones are struck through with the answer so the reasoning is not lost.

- ~~`relationships.read` by scope alone?~~ Social-SDK-gated, no public REST route. Capture disabled, schema kept.
- ~~role icons: field name and endpoint?~~ `icon` + `unicode_emoji`, same create/modify body, `ROLE_ICONS`-gated.
- ~~mmdb reader and licence?~~ `maxmind`, MIT. db-ip data is CC-BY, attributed in `docs/privacy.md`.
- ~~bulk delete limits?~~ 2 to 100 ids, a 2 week window, ids that do not exist still count toward the range. Duplicate ids are a `400`. A 1-element array is below the documented minimum of 2 rather than an error the docs name.
- ~~file upload ceiling per boost tier?~~ Re-verified against `developers/reference.mdx` and `resources/channel.mdx`. 20 MiB per file by default, raised from 10 MiB in September 2026. The 25 MiB figure is the per-message request size, not a boost tier. Boost tiers add their own limits. The number is per uploader as well, so read `attachment_size_limit` off the interaction instead of hardcoding anything. D4PLAN 17.3 corrected.
- ~~role and channel caps?~~ `30005` is "maximum number of guild roles reached (250)", `30013` is "maximum number of guild channels reached (500)". Documented as fixed; no primary source varies them by boost tier or feature. Doc-verified only, not triggered against a live guild at the cap.
- ~~measured restore duration per 1000 messages.~~ 11 ms against a mock, which is a floor: the wall clock is discord's rate limiter at 2.5 webhook posts a second, about seven minutes (`docs/measurements.md`).
- [ ] measured attachment recovery rate on old channels. the capture and restore halves are proven to line up; how many signed urls are still alive is a property of the channel, so it needs a real backup, and its own `skipped` list answers it.
- ~~whether `enumerateDevices` labels are ever non-empty without a permission prompt, and if not, drop labels and keep counts.~~ Never. Per the Media Capture spec, before a successful capture the device info object carries empty `deviceId`, `label`, and `groupId`, and at most one device of each kind is listed. So the label is always empty and the count is not a real device count either. Record device kinds present, not labels, and treat the count as unusable.
- ~~Discord's current guild role and channel caps, from real `30005` and `30013` responses rather than from folklore.~~ See the answered entry above; doc-verified, not response-verified.- [ ] `/users blacklist` is specified in D4PLAN 8 but D4PLAN 5.1 defines no table for it. Pick one: a `guild_blacklist` table keyed on `(guild_id, kind, value)` where kind is `user_id` | `ip_hash` | `asn`, or a `blacklist_json` array inside `guilds.settings_json`. A table wins if the list can grow past a few dozen entries, because the pull engine reads it on every join.
- ~~`/users export scope members` names no source table.~~ The newest backup's member snapshot, which is the only member list that exists: there is no live members table, and a backup's members are a snapshot of one moment rather than a roster. The export names the backup it came from, so a reader knows which moment they are looking at (`src/services/export/records.ts`, the `members` scope).
