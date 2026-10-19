# Architecture

One process. The bot, the web server, the job runner, and the scheduler all live in it and share one database handle.

The rule the rest of this page hangs off: **every call to Discord goes through `src/discord/client.ts`**. Nothing else in `src/` reaches for `fetch` against `discord.com`. That is what makes the rate limiter, the error parser, and the redaction layer apply everywhere. A module that reached for `fetch` itself would take all three out of the loop.

## The shape of the process

`src/index.ts` is the entrypoint. It prints a banner, then calls `boot()` in `src/boot.ts`, and installs the `SIGINT` and `SIGTERM` handlers.

`boot()` composes and owns no behaviour of its own. It opens the pieces in this order:

1. the database, and the migrations, which are idempotent and run on every boot
2. the REST client
3. the gateway
4. the interaction router and the authorisation check
5. the setup surface, and its component handlers
6. the job runner, and the handlers for the backup, export, and restore kinds
7. the backup and restore command surfaces
8. the command list, and `buildDefinitions` over it
9. the boot assertion: every custom id a surface can produce has a handler, or the process refuses to start
10. Discord: a token preflight, the gateway connection, the wait for ready, and then the command registration
11. the web server

Registration needs the application id, which only exists once the gateway says who the bot is, so it comes after the connection. The web server comes last because the OAuth flow needs the gateway's application id for the client id.

Shutdown runs the other way: the gateway first, so no new interaction arrives while the rest closes, then the web server, the job runner, the database, and the log sink.

## The layers

| Layer | Where | What it owns |
|---|---|---|
| Discord transport | `src/discord/client.ts`, `ratelimit.ts`, `errors.ts`, `gateway.ts` | the only REST path, the rate-limit buckets, the parsed error type, the gateway connection |
| Discord surface | `src/discord/commands/`, `src/discord/interactions/`, `src/discord/components/`, `src/discord/registry.ts` | the slash commands, the component handlers, the custom id router, the short-lived interaction state, the registration diff |
| Domain services | `src/services/` | the actual work: capture, restore, verify, pull, retention, export, the job runner, the scheduler |
| Wizard | `src/setup/` | the twelve wizard steps, the portal checklist, the self-test, the guide renderer |
| Web | `src/web/` | `Bun.serve`, five routes, the client IP capture, the fingerprint reader, the HTML views |
| Data | `src/db/` | one portable schema for two engines, the row types, the query modules |
| Shared | `src/lib/` | the logger and the redaction, the CDN fetch, the snowflake helpers, the validators |

## The directory map

Where to open what.

| Question | File |
|---|---|
| what is the process doing at startup | `src/boot.ts` |
| what does an environment key mean and what is its default | `src/config/parse-env.ts` |
| what does a per-guild setting mean and what is its default | `src/config/defaults.ts` |
| what is a row | `src/db/types.ts` |
| what is the schema | `src/db/schema.sql` |
| how does a driver value become a row value | `src/db/rows.ts` |
| what are the SQL statements for a table | `src/db/queries/<table>.ts` |
| what does a Discord error look like | `src/discord/errors.ts` |
| how is a command defined and grouped | `src/discord/commands/index.ts` |
| what does a command page look like | `src/discord/commands/<group>/pages.ts` |
| how is a button's custom id parsed and routed | `src/discord/interactions/router.ts` |
| how is a page laid out | `src/discord/components/page.ts` |
| what does a capture read and what does it skip | `src/services/backup/<category>.ts` |
| what a restore does, phase by phase | `src/services/restore/<phase>.ts` |
| what the restore will do before it does it | `src/services/restore/plan.ts` |
| how a job is queued, run, and resumed | `src/services/jobs/runner.ts` |
| what the scheduler decided was due | `src/services/scheduler/index.ts` |
| what the OAuth flow requests and stores | `src/services/verify/oauth.ts` |
| what a record holds | `src/services/verify/records.ts` |
| how a token is encrypted | `src/services/verify/token-store.ts` |
| what is captured about a visitor | `src/web/capture/ip.ts`, `src/web/capture/fingerprint.ts` |
| what the web server answers | `src/web/routes/`, `src/web/views/pages.ts` |
| what the backup JSON looks like | `src/services/export/json.ts`, `docs/backup-format.md` |
| what a backup cannot bring back | `docs/backup-format.md` |
| what the wizard's steps are | `src/setup/steps/`, `src/setup/state.ts` |

## A backup

The command is a thin wrapper. `/backup create` checks the caller is an admin, reads the guild's settings, and enqueues a `backup` job. It returns a job page. It does not capture anything.

`createBackupJobHandler` in `src/services/backup/job.ts` handles the job. It calls `runBackup` in `src/services/backup/index.ts`, which owns the pipeline.

`runBackup` does four things:

1. **Inserts the `backups` row before the first request.** A crash leaves an open backup rather than an invisible half-capture, and `listOpenBackups` is how one is found.
2. **Runs the thirteen steps in a fixed order.** The order is not cosmetic. Roles come before members, because a member carries the names of its roles. Members come before messages, because a message's author nickname comes from the member list. Channels come before messages, because a message needs its channel. Members also come before channels, because a channel overwrite on a member resolves its name from that member's row.
3. **Records what it could not read.** A step that Discord refuses, or that throws, records why in the skip list and the pipeline carries on. A partial backup is visibly partial rather than silently partial.
4. **Seals the backup.** `sealBackup` in `src/services/backup/selfcheck.ts` runs the self-check, writes the counts, measures the asset directory on disk, and writes `self_check_json`. A backup whose self-check failed is stored anyway, marked incomplete, with the failures listed. It still restores, and the restore warns.

Every step is a `Capture`: a function that takes one context and returns how many rows it wrote. The context carries the database, the client, the logger, the ids, the settings, the limits, the asset store, the skip list, a checkpoint callback, and a clock. That is why a capture can be driven by the fixture guild in a test with no disk and no network.

The asset store is one seam. `ctx.assets.save(kind, name, url)` downloads a CDN url into `backups/<backup_id>/assets/<kind>/` and returns the stored path, or null when the file was over the ceiling, already gone, or not a CDN url. A null is a recorded limitation, not an error.

Exporting is a second job. `/backup export` enqueues an `export` job, `services/export/job.ts` calls `buildExport`, and `writeExport` writes `backup.json` and copies the asset tree beside it. The file is recorded in `pending_exports` with an expiry 24 hours out, and the scheduler sweep deletes it when it passes.

## A restore

`/restore start` opens the category selection UI. The selection becomes the `RestoreOptions`, and the command enqueues a `restore` job.

`runRestore` in `src/services/restore/index.ts` runs the phases in a fixed order: guild, emojis, roles, categories, channels, overwrites, threads, onboarding, automod, events, members, bans, messages. Each phase is awaited, checkpointed, and independently failable. A phase that fails does not end the restore: the phases that do not depend on it still run, and the ones that do are marked skipped with the reason.

The optional clear runs first and is not one of the phases. It is the destructive one, so it is guarded three ways before it gets there: its own page, a typed guild name, and a nonce with a fifteen-minute expiry on the confirm button. It also refuses to touch the development guild.

The thing that makes a restore work across two guilds is `RestoreMaps`. Four maps carry a source id to a target id: roles, channels, members, and emojis. A channel's parent, an overwrite's target, a member's roles, a thread's parent, an automod rule's exempt channels, and an event's channel are all resolved through them. A role is matched by name, with the id as a tiebreak, because a name is the only thing two guilds can share.

`/restore plan` runs `buildPlan` in `src/services/restore/plan.ts`, which turns the same options into an ordered list of operations with counts and writes nothing. It is the executor's order, because a plan whose order differs from the executor is worse than no plan.

## The job model

A long operation is a row in `jobs`, not a function that runs inside an interaction handler.

```
jobs(id, guild_id, kind, status, requested_by, payload_json,
     progress_json, error_code, error_body, created_at, started_at,
     finished_at, attempts)
```

`status` is one of `queued`, `running`, `paused`, `succeeded`, `failed`, `cancelled`. `kind` is one of `backup`, `restore`, `pull`, `verify_refresh`, `export`.

Three things follow from that.

**The handler returns immediately.** The interaction answers with a job page, and the runner edits that page as the job progresses. A capture of ten thousand messages takes far longer than an interaction is worth spending, and the operator should be able to close the client and come back.

**A restart does not lose the job.** The progress goes into `job_progress`, one row per step, with a cursor, a done count, and a total. `JobRunner.start()` re-queues every job that was queued, running, or paused when the process died, and the handler picks up from its last checkpoint. A capture of a hundred channels resumes at the channel it was on.

**The runner enforces the limits.** At most `MAX_CONCURRENT_JOBS` jobs across all guilds, and at most one job per guild, because two restores into one guild fight over channel names and two backups of one guild are pointless.

Cancel and pause are cooperative. They set a flag the handler polls at its checkpoints; the handler returns, and only then is the terminal status written. A handler that never checks the flag is not reported cancelled until it actually stopped.

The scheduler is the other producer of work. Every 15 seconds it reads the due work from the database, so a restart does not lose a schedule and two processes do not double-fire it. It sweeps the expired interaction state and the expired exports, and it enqueues the auto backups that are due.

## The seams

The places where one side meets another. These are the boundaries to keep clean.

**Discord client.** `src/discord/client.ts`. A route, a method, a body, and the limiter and the error parser apply. The one carve-out is `src/lib/http.ts`, a read-only CDN GET with a timeout and no auth header, used for icons, emojis, stickers, and attachments. The client refuses an absolute url, so a caller cannot smuggle one past it.

**Database.** `src/db/types.ts` defines the `Database` interface, and both drivers implement it. Nothing in the app talks to a driver directly. `src/db/rows.ts` is the only place a driver's `bigint` becomes a string, and the only place a string becomes a `bigint` on the way in.

**Query modules.** `src/db/queries/` is one module per table, and no module writes SQL inline. That is what keeps the export shape from drifting away from the tables.

**Command surface.** `src/discord/commands/index.ts` holds `buildDefinitions`, and the boot and the registration diff both read the same list. `src/discord/registry.ts` resolves the scope: a guild id means guild-scoped registration, no guild id means global.

**Custom id vocabulary.** `src/boot.ts` collects every `CustomIdSpec` the surfaces produce and hands them to `router.assertComplete`. A control with no handler stops the boot rather than failing an interaction later.

**Services.** `src/services/` is where the domain work lives, and it is the only layer that knows what a backup or a restore is. The command surface renders pages; the web routes render HTML; neither one captures a guild.

**Injected clock and store.** The capture takes a clock, the record writer takes one, the job runner takes one, and the scheduler takes one. That is what makes a test deterministic without a fake timer.
