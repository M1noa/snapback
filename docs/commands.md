# Commands

The slash command surface. Mirrors `D4PLAN.md` 8, which is the design of record; if the two disagree, the plan wins and this file is wrong.

Slash commands only. No prefix commands, no message handlers. Registration is global in production, or guild-scoped and instant when `DISCORD_DEV_GUILD_ID` is set.

Every command is owner-or-guild-admin gated by `discord/registry.ts` before the handler runs. A non-admin gets an ephemeral container naming what is needed, never a stack trace. `default_member_permissions` is deliberately unset, because Discord's permission model cannot express "Snapback admin" (a database list) or per-flag granularity.

Every option that names a backup, guild, job, user, or record has autocomplete. Every list paginates at a fixed size. Every destructive command has a `dry_run` that defaults on where a dry run is meaningful.

`tests/docs/commands.test.ts` asserts that every command registered at boot appears in this file, and that this file names no command that does not exist, so the two cannot drift.

## /setup

The wizard. Stateful and resumable; the subcommands jump straight to a step.

| Subcommand | Does |
|---|---|
| `/setup open` | opens the wizard at the first incomplete step |
| `/setup status` | one page: every step with a green, amber, or red dot, and for amber or red a button that jumps to the fix |
| `/setup app` | token, owner id, gateway, and the privileged intent |
| `/setup web` | public base url, port, the live ip probe, and the page name |
| `/setup branding` | bot avatar, banner, and display name |
| `/setup admins` | who else may change settings |
| `/setup logs` | log channel and event families |
| `/setup backup` | include set, message limits, auto-backup schedule |
| `/setup restore` | clear-before, timestamp suffix, default selections |
| `/setup verify` | the panel, its colour, and its buttons |
| `/setup policy` | when a verification is refused: the network rule and the alt check |
| `/setup guide` | reads the operator docs. Options: `doc` (the guide, or the index of them all) and `page` |

## /backup

| Subcommand | Options | Does |
|---|---|---|
| `/backup create` | `label`, `messages` (bool), `members` (bool), `message_limit` (int), `dry_run` (bool) | queues a backup job; a dry run writes nothing |
| `/backup list` | `page` | paginated list, newest first |
| `/backup info` | `backup` (autocomplete) | counts, size, age, contents summary, the self-check's failures and skips |
| `/backup export` | `backup` (autocomplete), `format` | writes the backup into the export directory as json (lossless) or restorecord, and reports the path, its size, and when the sweeper takes it |
| `/backup import` | `file` (upload), `label`, `format` (auto, snapback, restorecord, vaultcord) | reads an uploaded backup file into a stored backup and seals it against the same self-check, reporting what the format could not carry |
| `/backup delete` | `backup` (autocomplete), `confirm` | arms the delete on a typed value, then hard-deletes the rows and the asset files |
| `/backup prune` | `dry_run` (default on) | shows the retention policy's plan, and acts on the second press. the page's **set the policy** button opens the modal that stores the day and count limits |

## /restore

| Subcommand | Options | Does |
|---|---|---|
| `/restore start` | `backup`, `target_guild` | opens the category selection UI |
| `/restore plan` | `backup`, `target_guild` | dry run: prints what the restore would change, writes nothing |
| `/restore status` | | how the last restore in this server is going |
| `/restore cancel` | | stops the restore that is running, at its next checkpoint |
| `/restore members` | `backup`, `target_guild` | members' roles and nicknames only, no channel or message work |
| `/restore messages` | `backup`, `target_guild` | replays the message history only |

## /snapback

| Subcommand | Does |
|---|---|
| `/snapback status` | uptime, gateway, queue, database, and version at a glance |
| `/snapback diagnostics` | runs every self-test and returns a copyable report |

## /verify

| Subcommand | Options | Does |
|---|---|---|
| `/verify panel` | `scopes` (multi-select, defaults to identify, email, guilds.join) | builds or edits the verification panel and prints its link |
| `/verify records` | `page` | paginated list of the records this server holds |
| `/verify record` | `user` | one person's record in full |
| `/verify refresh` | | refreshes the OAuth tokens that are due |
| `/verify delete` | `user`, `scope` (the record, the address, the token, or all of it) | erases what was captured |
| `/verify stats` | | verification counts for this server |

## /users

| Subcommand | Options | Does |
|---|---|---|
| `/users lookup` | `user` | what this server holds about a person |
| `/users export` | `scope` | writes this server's records out as json |
| `/users blacklist` | `action`, `kind`, `value` | reads the entries you want to look at, for this server |

## /pull

| Subcommand | Options | Does |
|---|---|---|
| `/pull start` | `exclude_revoked` (bool), `max` (int) | adds the accounts that granted a token back into this server |
| `/pull status` | | attempts, successes, failures, and what is restricted |
| `/pull counters` | | today's attempts, successes and failures, per account |
| `/pull reset` | `user` (autocomplete) | clears one account's counters by hand |
| `/pull config` | | the limits in force, and where they come from |

Every pull attempt is recorded, and an account is refused when it is inside the failure cooldown or its daily limit is spent. `pull` has no join link: a person is added through the token they granted, never through a url and never with the bot's own token.

## Not registered yet

`D4PLAN.md` 8 specifies more than this build registers: a data-export step in the wizard, a records browser, and the help pages under the bot group. The plan is where they are written down.

## Guides

`/setup guide` renders the guides listed in `src/setup/guide.ts`. The four newest guides in the table below are not in that list yet, so they are shipped but not reachable from Discord.

| Guide | Covers |
|---|---|
| `docs/setup.md` | clone to a verified member |
| `docs/developer-panel.md` | the Discord developer portal, redirect strings, intents |
| `docs/cloudflare-tunnel.md` | running behind a tunnel, and the loopback IP failure |
| `docs/scopes.md` | every OAuth scope, what it grants, and why it is asked for |
| `docs/self-hosting.md` | Postgres, retention, data files, db-ip attribution |
| `docs/troubleshooting.md` | the failures that actually happen |
| `docs/backup-format.md` | the backup JSON contract and the known-lossy list |
| `docs/privacy.md` | what is captured about a visitor, the storage modes, and how to revoke |
| `docs/architecture.md` | process layout, the job runner, the database boundary |
| `docs/contributing.md` | the gate, the conventions, and the test expectations |
