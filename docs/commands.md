# Commands

The slash command surface. Mirrors `D4PLAN.md` 8, which is the design of record; if the two disagree, the plan wins and this file is wrong.

Slash commands only. No prefix commands, no message handlers. Registration is global in production, or guild-scoped and instant when `DISCORD_DEV_GUILD_ID` is set.

Every command is owner-or-guild-admin gated by `discord/registry.ts` before the handler runs. A non-admin gets an ephemeral container naming what is needed, never a stack trace. `default_member_permissions` is deliberately unset, because Discord's permission model cannot express "Snapback admin" (a database list) or per-flag granularity.

Every option that names a backup, guild, job, user, or record has autocomplete. Every list paginates at a fixed size. Every destructive command has a `dry_run` that defaults on where a dry run is meaningful.

A test asserts that every command registered at boot appears in this file, so it cannot drift.

## /setup

The wizard. Stateful and resumable; the subcommands jump straight to a step.

| Subcommand | Does |
|---|---|
| `/setup open` | opens the wizard at the first incomplete step |
| `/setup status` | one page: every subsystem with a green, amber, or red dot, and for amber or red a button that jumps to the fix |
| `/setup app` | Developer Panel checklist and the `app test` self-test |
| `/setup web` | `PUBLIC_BASE_URL`, port, tunnel checkbox, live IP probe |
| `/setup admins` | add, remove, and list admins, with per-flag toggles |
| `/setup backup` | default include set, message counts, auto-backup schedule |
| `/setup restore` | restore defaults: clear-before, timestamp suffix, default selections |
| `/setup verify` | build and manage panels, choose scopes, choose the redirect target |
| `/setup branding` | bot avatar and banner upload (GIF accepted), bot display name |
| `/setup logs` | log channel, event families, test-fire a log entry |
| `/setup privacy` | IP storage mode, retention policy, website disclosure text |
| `/setup data` | database status and size, back up the database, export everything to JSON |
| `/setup guide` | renders `docs/setup.md` in paginated Components V2 pages |

## /backup

| Subcommand | Options | Does |
|---|---|---|
| `/backup create` | `label`, `messages` (bool), `members` (bool), `message_limit` (int, clamped) | queues a backup job |
| `/backup list` | `page` | paginated table with a per-row select and delete button |
| `/backup info` | `backup` (autocomplete) | counts, size, age, contents summary, restore button |
| `/backup restore` | `backup`, `target_guild` | hands off to `/restore` with the selection UI prefilled |
| `/backup delete` | `backup`, `confirm` | hard-deletes rows and asset files |
| `/backup export` | `backup`, `format` | writes JSON or a zip into the export directory and returns it as a file component |
| `/backup prune` | `dry_run` | applies the retention policy and reports what would go |

## /restore

| Subcommand | Options | Does |
|---|---|---|
| `/restore start` | `backup`, `target_guild` | opens the category selection UI |
| `/restore status` | `job` | live progress page with pause and cancel |
| `/restore cancel` | `job` | cooperative cancel at the next checkpoint |
| `/restore plan` | `backup`, `target_guild` | dry run: prints the diff between backup and target, writes nothing |
| `/restore members` | `backup`, `target_guild` | member-and-role-only restore, no channel or message work |
| `/restore messages` | `backup`, `target_guild`, `channels` | message-only replay into an existing structure |

## /verify

| Subcommand | Options | Does |
|---|---|---|
| `/verify panel` | | opens the panel builder |
| `/verify list` | | all panels in this guild, with edit, repost, and disable |
| `/verify records` | `page`, `filter` | paginated record browser with a per-user detail view |
| `/verify user` | `user` | the full record for one user, every captured field |
| `/verify refresh` | `all` (bool) or `records` | re-checks every token against Discord, live-edits the message per user, reports who revoked |
| `/verify delete` | `user`, `scope` (`record` \| `ip` \| `token` \| `all`), `confirm` | the only path that erases captured data |
| `/verify export` | `format`, `filter` | JSON or CSV of records |
| `/verify stats` | | verified count, revoked count, scopes in use, intel breakdown |

## /pull

| Subcommand | Options | Does |
|---|---|---|
| `/pull start` | `source_guild`, `target_guild`, `exclude_revoked`, `max` | adds verified users to a guild through `guilds.join` |
| `/pull status` | `job` | live page with per-account counters |
| `/pull counters` | `page` | the `account_counters` table: per user, today's attempts, cooldown state |
| `/pull reset` | `user`, `confirm` | clears a cooldown or a daily counter by hand |
| `/pull config` | | daily limit per account, cooldown hours, auto-pull toggle |

## /users

| Subcommand | Options | Does |
|---|---|---|
| `/users lookup` | `user` or `id` | identity, membership, record, and counters, one page |
| `/users export` | `scope` | JSON dump of records or members |
| `/users blacklist` | `add` / `remove` / `list` | per-guild blacklist by user id, ip hash, or asn |

## /snapback

| Subcommand | Does |
|---|---|
| `/snapback status` | bot uptime, gateway latency, job queue depth, database size, tracked guilds, version |
| `/snapback diagnostics` | the full self-test plus database, disk, and permission probes; returns a copyable report |
| `/snapback version` | version, commit, Oceanic version, schema version |
| `/snapback help` | paginated index of `docs/` |

## Guides

`/setup guide` and `/snapback help` render these, so a guide cannot be added without being reachable.

| Guide | Covers |
|---|---|
| `docs/setup.md` | clone to a verified member |
| `docs/developer-panel.md` | the Discord developer portal, redirect strings, intents |
| `docs/cloudflare-tunnel.md` | running behind a tunnel, and the loopback IP failure |
| `docs/scopes.md` | every OAuth scope, what it grants, and why it is asked for |
| `docs/backup-format.md` | the backup JSON contract and the known-lossy list |
| `docs/self-hosting.md` | Postgres, retention, data files, db-ip attribution |
| `docs/privacy.md` | what is captured, the retention policy, and how to erase it |
| `docs/troubleshooting.md` | the failures that actually happen |
| `docs/architecture.md` | process layout, the job runner, the database boundary |
| `docs/contributing.md` | the gate, the conventions, and the test expectations |
