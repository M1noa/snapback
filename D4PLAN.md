# D4PLAN.md

Plan for Snapback: an open-source Discord server backup, restore, and member-verification bot.

Status: design complete, nothing implemented.
Scope of this doc: everything needed to build v1.0.0, feature by feature, plus the failure modes each feature has to survive.

Legend for confidence:
- `[v]` verified against Discord docs or the Oceanic source this session
- `[r]` taken from a reference project, behaviour read directly
- `[?]` assumed, needs a spike before it is coded

Companion docs: `AGENTS.md` is the coding contract, `D4TODO.md` is the execution order, `S5PLAN.md` is the earlier draft this supersedes (its command list, its two-file schema, and its `snap:` id namespace are all replaced here; the captcha and public geo-lookup routes it proposed are dropped, see `19.4`).

---

## 1. What this is

A self-hosted Discord bot that does four things and does them completely:

1. **Backup** a guild: settings, roles, channels, permission overwrites, members and their roles, messages, bans, timeouts, emojis, stickers, soundboard, automod rules, onboarding, welcome screen, scheduled events.
2. **Restore** any of that into the same guild or a different one, with per-category selection and ID remapping.
3. **Verify** humans through a website OAuth flow, capture what the owner configured (identity, connections, IP, fingerprint), and optionally pull them into a guild with `guilds.join`.
4. **Report** on all of it through Components V2 slash commands with a log channel, exports, and retention rules.

One owner and a per-guild admin list run everything from Discord. The only things in `.env` are the bot token, owner id, and connection secrets.

### Non-goals

- Not a selfbot. No user-token automation, no message-as-a-user, no account farming. Reference projects in `references/` include that kind of code; none of it ships here.
- Not a "pull farm". Verification is opt-in per user, per guild, with a disclosed scope list and a documented revocation path.
- No Discord API calls through residential proxies or any other ban-evasion infrastructure. `[r]` restorecord-new routes everything through `zproxy.lum-superproxy.io`; Surfshark-style evasion is out of scope and would be the fastest way to get the bot and the owner's account terminated.

### Legal and platform reality, stated once

- `relationships.read` (friends, pending requests, blocked users) is a **restricted scope**. It sits behind Discord approval and the Social SDK terms, which make you responsible for how you handle that data (`[v]`). The feature must default to **off**, require an explicit owner acknowledgement in setup, and be impossible to enable without the scope being granted on the Discord app first.
- `guilds.join` lets the bot add a user to a guild **only** with a token that user granted and only within the scopes they approved. There is no legitimate way to add an unwilling user. Any design that claims otherwise is lying.
- Captured IPs, emails, and friend lists are personal data. The plan stores IPs hashed by default, encrypts tokens at rest, and the website must carry a plain-language notice of what is captured (`22. Privacy`).
- Message restore uses **webhooks**, which means restored messages carry the webhook's timestamp, not the original. That is a hard Discord constraint. Anything claiming perfect message fidelity is wrong. Section `12.6` says what we do about it.

---

## 2. Stack

| Piece | Choice | Why |
|---|---|---|
| Library | `oceanic.js` 1.15.x `[v]` | TypeScript-native, MIT, `tslib` + `ws` only, actively pushed, full Components V2 + modal coverage, gates its endpoints internally so we do not hand-roll rate limiting |
| Language | TypeScript, `strict`, ESM | matches the library's own types |
| Runtime | Bun `[v]` | Oceanic ships a `bun` export condition, so Bun is a supported target `[v]`. Single-runtime (bot + web server + scheduler in one process) is the whole point. No Node fallback in v1: two runtimes means two sets of DuckDB, fetch, and worker bugs |
| DB | DuckDB file by default, Postgres via `DATABASE_URL` `[v]` | one-file deploy for the common case, Postgres for anyone who wants concurrency. The Bun + DuckDB binding is the one thing milestone 0 has to prove (`23.1`); the query layer is written portable so swapping to Postgres, or to `bun:sqlite`, is a config change |
| Web | `node:http` + a tiny router, no framework | the site is five routes and one OAuth callback. A framework buys nothing |
| Docs | `docs/` markdown, rendered into `/snapback help` and `/setup guide` and the site | single source for all three |

**The Bun risk, resolved early.** DuckDB has no official Bun build; `@duckdb/node-api` is a Node-API addon, and Bun's NAPI support is good but not certified for every addon. Milestone 0 is a half-day spike: open a DuckDB file from Bun, write a row, read it back. If it fails, the first fallback is `bun:sqlite` behind the same `Database` interface (`5.1`), which keeps the single-runtime design intact and costs one file. Dropping to Node is the last resort, only if Bun itself is unworkable for a reason SQLite does not fix, because two runtimes means two sets of addon, fetch, and worker bugs.

Anything else is a distraction. No Python, no Go, no ORM.

---

## 3. Repository layout

```
snapback/
  package.json
  tsconfig.json
  .env.example
  README.md
  D4PLAN.md
  AGENTS.md
  scripts/
    spike/                   phase 0 probes, kept so each finding carries its evidence
  src/
    index.ts                 entrypoint, wires everything
    config/
      env.ts                 parse + validate env once, throw loudly
      parse-env.ts           the pure parser env.ts binds to the process
      defaults.ts            every tunable with its default
    db/
      index.ts               driver selection from DATABASE_URL
      types.ts               the only place SQL-agnostic row types live
      rows.ts                the one place a driver BigInt becomes a string
      duckdb.ts
      postgres.ts
      schema.sql
      migrate.ts             idempotent, versioned
    discord/
      client.ts              gateway client, intent list, error hook
      errors.ts              DiscordApiError, code table, formatter
      ratelimit.ts           global + per-route guard, 429 backoff
      registry.ts            command registration, diff against live commands
      components/            Components V2 factories (plain objects)
        container.ts
        page.ts
        row.ts
        fields.ts
        colors.ts
      commands/
        setup/               wizard + subcommands
        backup/              create, list, inspect, delete, export
        restore/             start, status, cancel
        verify/              panel creator, records, refresh, delete
        pull/                start, status, per-account counters
        users/               lookup, export
        admin/               admins, log channel, ephemeral, retention
        system/              status, diagnostics, about
      interactions/
        router.ts            customID -> handler, namespaced prefixes
        state.ts             short-lived interaction state store + TTL
    services/
      backup/
        index.ts
        guild.ts             guild-level settings
        roles.ts
        channels.ts
        members.ts
        messages.ts
        assets.ts            emoji, sticker, soundboard, banner/icon fetching
        automod.ts
        onboarding.ts
        events.ts
      restore/
        index.ts
        plan.ts              dry-run diff builder
        guild.ts
        roles.ts
        channels.ts
        permissions.ts       name-based overwrite remap
        members.ts
        messages.ts          webhook replay
        assets.ts
      verify/
        panel.ts
        oauth.ts
        records.ts
        refresh.ts
      pull/
        index.ts
        counter.ts           per-account daily counters + cooldown
        member.ts            guilds.join add
      intel/
        dbip.ts              country + ASN, db-ip lite
        asmetadata.ts        hosting vs residential, ipverse CC0
        classify.ts          vpn/proxy/hosting verdict
      retention/
        index.ts
      export/
        json.ts
      scheduler/
        index.ts             cron-ish ticker, persisted job table
    web/
      server.ts
      router.ts
      routes/
        verify.ts
        callback.ts
        revoke.ts
        health.ts
        legal.ts
      capture/
        ip.ts
        fingerprint.ts
      views/                 server-rendered HTML, one file per page
    lib/
      http.ts                  cdn GET with a timeout, the one non-API fetch
      log.ts                   log channel + rotating file, redaction applied here
      sleep.ts
      chunk.ts
      redact.ts
      snowflake.ts
  tests/
  docs/
    setup.md                 the operator guide, referenced by /setup
    developer-panel.md
    cloudflare-tunnel.md
    scopes.md
    self-hosting.md
    troubleshooting.md
```

---

## 4. Architecture

One process. Three loops.

```
                   Discord gateway
                          |
                   discord/client.ts
                          |
              interactions/router.ts  (customID + slash)
                          |
      +-------------------+-------------------+
      |                   |                   |
  services/backup   services/restore     services/verify
      |                   |                   |
      +---------+---------+---------+---------+
                |                   |
          db/index.ts        discord/ratelimit.ts
                                    |
                            one HTTP path to discord.com

  web/server.ts  --OAuth-->  services/verify/oauth.ts
                 --capture-> web/capture/{ip,fingerprint}.ts
                 --intel-->  services/intel/*

  scheduler/index.ts  every 15s:  due backups, due restores, token refresh,
                                  retention sweep, counter reset
```

Rules that keep it sane:

- **Every Discord call goes through the client.** Nothing in `services/` imports `fetch` for `discord.com`. That is what makes the rate-limit guard, the error parser, and the redaction layer actually apply everywhere.
- **Long jobs never run inside an interaction handler.** A backup is a job row in the DB with a runner; the interaction gets an ack and a message it edits. This is what lets a 40-minute, 10k-message restore survive a gateway reconnect.
- **Jobs are resumable.** Each backup/restore job writes progress checkpoints (`job_progress`), so a crash resumes at the last completed channel instead of restarting a 10k-message replay.
- **All state that a button needs lives in the DB or in a customID, never in a module-level Map.** Cold restart mid-wizard must not brick the wizard.

### 4.1 Job model

Every long operation is a row in `jobs`:

```
jobs(id, guild_id, kind, status, requested_by, payload_json,
     progress_json, error_code, error_body, created_at, started_at,
     finished_at, attempts)
```

`status` in `queued | running | paused | succeeded | failed | cancelled`.
`kind` in `backup | restore | pull | verify_refresh | export`.

A single `JobRunner` per kind, serialised per guild (two restores into the same guild would fight over channel names; two backups of the same guild are pointless). Cross-guild work runs concurrently up to `MAX_CONCURRENT_JOBS` (default 2).

---

## 5. Data model

Two files, one abstraction.

- `db/duckdb.ts`, `db/postgres.ts`: both implement `Database` in `db/types.ts` (`query`, `execute`, `transaction`, `close`).
- `schema.sql` is written in portable SQL: `TEXT`, `INTEGER`, `BIGINT`, `BOOLEAN`, `DOUBLE`, `TIMESTAMP`. No engine-specific types, no `SERIAL`, no `AUTOINCREMENT`. Primary keys are application-generated UUIDv7 strings, which keeps insert order roughly time-ordered and removes the only real dialect difference.
- `BIGINT` for snowflakes. Snowflakes are 64-bit and exceed `Number.MAX_SAFE_INTEGER`; every id crosses the wire as a **string** and only becomes a `bigint` inside the DB layer. This is the single most common bug in every reference project `[r]`, all of which store ids as `BigInt` in Prisma or plain `str` and then compare them to JS numbers.
- `db/migrate.ts` keeps a `schema_version` row in a `meta` table and applies numbered upgrade steps. Idempotent, safe to run at every boot.

**Concurrency caveat, DuckDB:** DuckDB allows one writer process. The bot owns the file; the web server runs in the same process so it shares the connection pool. If an operator points both at the same file from two processes (they will), the second one gets a lock error. `db/duckdb.ts` opens with a busy timeout, retries the lock for 30s, then exits with a message naming the offending path. Documented in `docs/self-hosting.md`.

### 5.1 Tables

Grouped, with the non-obvious columns called out.

**Core**

| Table | Columns |
|---|---|
| `meta` | `key`, `value` |
| `guilds` | `guild_id` PK, `name`, `icon_url`, `owner_user_id`, `added_at`, `removed_at`, `settings_json` |
| `guild_admins` | `guild_id`, `user_id`, `added_by`, `added_at`, `can_backup`, `can_restore`, `can_manage_admins`, `can_view_records`, `can_delete_records` |
| `jobs` | see `4.1` |
| `job_progress` | `job_id`, `step`, `cursor`, `done_count`, `total_count`, `updated_at` |
| `audit_log` | `id`, `guild_id`, `actor_user_id`, `action`, `target`, `detail_json`, `created_at` |
| `interaction_state` | `state_id` PK (short random), `guild_id`, `user_id`, `surface`, `payload_json`, `created_at`, `expires_at` |
| `oauth_states` | `state` PK, `guild_id`, `created_at`, `expires_at`, `consumed_at`, `client_ip` |

`interaction_state` backs the "payload too long for a customID" case in `9.3`; the scheduler sweeps it by `expires_at` (`17.1`). In-memory is the default path, the table is what makes a multi-worker deployment correct.

`oauth_states` backs the CSRF nonce in `13.3`. Same reasoning: in-memory by default, the table exists so a restart mid-authorization does not invalidate a user's pending link.

Per-flag admin permissions rather than a single "admin" boolean. The setup wizard asks for them, and "can peek at captured records" is a different trust level from "can wipe the server and restore". Keep the granular columns; the whole security model is that `verify.read` does not imply `restore.execute`.

**Backups**

| Table | Columns |
|---|---|
| `backups` | `backup_id` PK (uuid7), `guild_id`, `label`, `kind` (`manual`\|`auto`\|`pre_restore`), `guild_name`, `icon_url`, `banner_url`, `splash_url`, `discovery_splash_url`, `owner_user_id`, `member_count`, `message_count`, `channel_count`, `role_count`, `size_bytes`, `schema_version`, `guild_settings_json`, `onboarding_json`, `welcome_screen_json`, `widget_json`, `afk_json`, `created_at`, `created_by` |
| `backup_roles` | `backup_id`, `source_role_id`, `name`, `color`, `hoist`, `mentionable`, `position`, `permissions` (BIGINT string), `is_everyone`, `is_bot_managed`, `bot_id`, `integration_id`, `icon_url`, `unicode_emoji`, `tags_json` |
| `backup_channels` | `backup_id`, `source_channel_id`, `parent_source_id`, `type`, `name`, `position`, `topic`, `nsfw`, `rate_limit_per_user`, `bitrate`, `user_limit`, `rtc_region`, `video_quality_mode`, `default_auto_archive_duration`, `default_thread_rate_limit_per_user`, `default_sort_order`, `default_forum_layout`, `available_tags_json`, `flags`, `is_news` |
| `backup_channel_overwrites` | `backup_id`, `source_channel_id`, `target_type` (`role`\|`member`), `source_target_id`, `target_name`, `allow` (BIGINT string), `deny` (BIGINT string) |
| `backup_threads` | `backup_id`, `source_thread_id`, `source_parent_id`, `type`, `name`, `archived`, `locked`, `auto_archive_duration`, `rate_limit_per_user`, `applied_tags_json` |
| `backup_members` | `backup_id`, `user_id`, `username`, `global_name`, `discriminator`, `nickname`, `avatar_url`, `joined_at`, `is_bot`, `role_ids_json`, `pending`, `timed_out_until`, `premium_since`, `flags`, `source_role_names_json` |
| `backup_messages` | `backup_id`, `channel_source_id`, `message_id`, `author_id`, `author_username`, `author_global_name`, `author_nickname`, `author_avatar_url`, `author_is_bot`, `author_webhook_id`, `content`, `embeds_json`, `attachments_json`, `stickers_json`, `components_json`, `reactions_json`, `reference_json`, `thread_source_id`, `flags`, `pinned`, `type`, `created_at`, `edited_at` |
| `backup_bans` | `backup_id`, `user_id`, `username`, `global_name`, `reason` |
| `backup_emojis` | `backup_id`, `source_emoji_id`, `name`, `animated`, `managed`, `available`, `roles_json`, `url` |
| `backup_stickers` | `backup_id`, `source_sticker_id`, `name`, `description`, `tags`, `format_type`, `url` |
| `backup_sounds` | `backup_id`, `source_sound_id`, `name`, `volume`, `emoji_name`, `emoji_id`, `url` |
| `backup_automod` | `backup_id`, `source_rule_id`, `name`, `event_type`, `trigger_type`, `trigger_metadata_json`, `actions_json`, `enabled`, `exempt_roles_json`, `exempt_channels_json` |
| `backup_events` | `backup_id`, `source_event_id`, `name`, `description`, `scheduled_start`, `scheduled_end`, `privacy_level`, `entity_type`, `entity_metadata_json`, `status`, `cover_url` |
| `backup_tags` | `backup_id`, `table`, `row_id`, `tag` |

The `backup_tags` table exists so messages and members can be filtered by tag on restore ("restore only messages from #general, #announcements") without a second pass over JSON. Keep it. Selective restore is a first-class feature (`15.2`), and the alternative is re-reading every message row's JSON to answer "which channels had messages", which is the same work stored twice.

Everything asset-like stores a **URL plus a local blob path**. Discord CDN URLs for emojis, stickers, and avatars are signed and expiring; icons and banners are semi-stable. `services/backup/assets.ts` downloads every asset at backup time into `backups/<backup_id>/assets/` and stores the relative path. On restore we upload from disk. This is the difference between a backup that restores in six months and one that restores empty. No reference project does this `[r]`; all of them store bare CDN URLs and silently restore blank icons.

**Verification and members**

| Table | Columns |
|---|---|
| `verify_panels` | `panel_id` PK, `guild_id`, `channel_id`, `message_id`, `title`, `description`, `color`, `thumbnail_url`, `button_label`, `button_style`, `scopes_json`, `redirect_uri`, `created_at`, `updated_at`, `enabled` |
| `verify_records` | `record_id` PK, `guild_id`, `user_id`, `username`, `global_name`, `discriminator`, `avatar_url`, `email`, `email_verified`, `locale`, `mfa_enabled`, `premium_type`, `flags`, `connections_json`, `guilds_json`, `relationships_json`, `oauth_scopes_json`, `oauth_granted_at`, `oauth_last_checked_at`, `access_token_enc`, `refresh_token_enc`, `token_expires_at`, `token_status` (`valid`\|`unauthorized`\|`revoked`\|`missing`), `first_ip_hash`, `first_ip_enc`, `last_ip_hash`, `last_ip_enc`, `ip_history_json`, `country_code`, `country_name`, `city`, `region`, `isp`, `asn`, `as_org`, `ip_type` (`residential`\|`hosting`\|`mobile`\|`unknown`), `is_vpn`, `is_proxy`, `is_tor`, `intel_checked_at`, `fingerprint_json`, `referrer`, `user_agent`, `revoked_at`, `notes`, `created_at`, `updated_at` |
| `verify_record_events` | `record_id`, `at`, `kind` (`oauth`\|`refresh`\|`revoked`\|`refreshed_ok`\|`refreshed_fail`\|`note`), `detail_json` |
| `pull_attempts` | `id`, `guild_id`, `user_id`, `attempted_at`, `outcome` (`added`\|`already_member`\|`failed`\| `skipped`), `error_code`, `error_body` |
| `account_counters` | `user_id`, `guild_id`, `day` (UTC date), `attempts`, `successes`, `failures`, `cooldown_until`, `restricted`, `restricted_reason`, `restricted_at`, `updated_at` |

`verify_records` is one row per (guild, user). Two reasons: revoking app access in one guild must not erase another guild's record, and the owner's "who removed the app" list is per guild. `[+]` RestoreCord keys `members` on `@@unique([userId, guildId])` `[r]`; same idea, plus the token-status and event history they lack.

`fingerprint_json` holds the `x-track` payload (`14.2`). Storing it as a blob rather than 20 columns because the field set will change and a schema migration per fingerprint field is silly.

**Retention and export**

| Table | Columns |
|---|---|
| `retention_policies` | `guild_id`, `keep_days`, `keep_count`, `keep_kind_json` (`["manual"]` etc), `enabled` |
| `pending_exports` | `export_id`, `guild_id`, `kind` (`backup`\|`records`\|`all`), `scope_json`, `file_path`, `size_bytes`, `created_at`, `expires_at` |

---

## 6. Configuration

`src/config/env.ts` parses, validates, and freezes everything at boot. Missing required values print a numbered list of exactly what is missing and how to get it, then `process.exit(1)`. No `undefined` leaking into the app.

`.env.example` (annotated in the file itself):

```ini
# ---- required ----
DISCORD_TOKEN=
DISCORD_OWNER_ID=

# ---- database ----
# unset      -> ./data/snapback.duckdb
# postgres:// -> user:pass@host:5432/dbname
DATABASE_URL=

# ---- web / verification ----
# public base URL the OAuth redirect and button point at
PUBLIC_BASE_URL=https://example.com
PORT=8080
# unset -> plaintext (only acceptable behind a trusted local tunnel)
IP_STORAGE=hash                 # hash | encrypted | plaintext
IP_HASH_PEPPER=                 # required when IP_STORAGE=hash
# 32-byte base64 key, required when IP_STORAGE=encrypted or to encrypt tokens
ENCRYPTION_KEY=

# ---- proxy awareness ----
# set to true when running behind Cloudflare Tunnel; the IP capture then
# trusts cf-connecting-ip and ignores x-forwarded-for
BEHIND_CLOUDFLARE_TUNNEL=false
TRUSTED_PROXY_DEPTH=0

# ---- intel ----
DBIP_COUNTRY_MMDB=./data/dbip-country-lite.mmdb
AS_METADATA_CSV=./data/as.csv
INTEL_ENABLED=true

# ---- limits ----
MAX_MESSAGES_PER_CHANNEL=1000    # hard ceiling 10000
MAX_MESSAGES_TOTAL=10000         # hard ceiling, cannot be raised
MAX_CONCURRENT_JOBS=2
PULL_DAILY_LIMIT_PER_ACCOUNT=100 # 100-500; trips cooldown at the cap
PULL_COOLDOWN_HOURS=24
PULL_FAILURE_COOLDOWN_MINUTES=60 # consecutive 403/429 burst cooldown

# ---- optional ----
LOG_LEVEL=info
AUTOMATION_ENABLED=true   # false = scheduler off, every job is manual
DISCORD_DEV_GUILD_ID=     # instant command registration while developing
```

Rules:

- `MAX_MESSAGES_PER_CHANNEL` and `MAX_MESSAGES_TOTAL` are **clamped** in code, not trusted. A `.env` with `MAX_MESSAGES_TOTAL=999999` gets clamped to 10000 and a warning. The user asked for a hard limit; a hard limit enforced only by documentation is not a hard limit.
- `IP_STORAGE=plaintext` logs a one-line warning at boot with the sentence "captured IP addresses are personal data; you are responsible for them" and links `docs/scopes.md`.
- Secrets are never echoed. `redact.ts` handles the log path; a token that appears in any log line is replaced with `sk_***`.

### 6.1 Tunables not in `.env`

Things an owner changes from Discord live in `guilds.settings_json` with defaults from `config/defaults.ts`:

```
ephemeral_default: true
log_channel_id: null
auto_backup_enabled: false
auto_backup_interval_hours: 24
auto_backup_message_count: 1000
auto_restore_enabled: false
restore_clear_before: false
restore_message_timestamp_suffix: false
notify_on_join: false
# retention is not duplicated here: it lives in the `retention_policies` table (`5.1`)
```

`/setup` writes these; `/admin` edits them. Every one of them is also settable by the setup wizard, so nothing requires editing a file after first run.

---

## 7. Discord application setup

This is the part every reference project skips and every operator gets wrong, so it gets its own wizard chapter and its own doc (`docs/developer-panel.md`).

### 7.1 Intents

Exactly these, no more. Requesting more than needed is a review flag.

| Intent | Why |
|---|---|
| `GUILDS` | required |
| `GUILD_MEMBERS` **(privileged)** | member list, role assignment on restore, nicknames. Must be toggled in the Developer Panel |
| `GUILD_MODERATION` | bans, timeouts, automod |
| `GUILD_EMOJIS_AND_STICKERS` | emoji and sticker backup |
| `GUILD_VOICE_STATES` | soundboard, voice channel detail |
| `GUILD_SCHEDULED_EVENTS` | scheduled event backup |
| `GUILD_MESSAGES` | only for receiving; history is REST, but presence of the intent is needed for some message events |
| `GUILD_MESSAGE_REACTIONS` | reaction capture on live messages (optional, off by default) |
| `DIRECT_MESSAGES` | none. Do not request it. Nothing here DMs users |

`GUILD_PRESENCES` is **not** requested. It is privileged, it needs a separate approval, and nothing in this bot needs presence.

### 7.2 OAuth2 scopes

Pick per-panel in `/setup verify scopes`. Every scope is a checkbox with a plain-English consequence line.

| Scope | Consequence shown |
|---|---|
| `identify` | "basic profile: id, username, avatar" |
| `email` | "email address and whether it is verified" |
| `connections` | "linked accounts: Steam, Twitch, GitHub, Spotify and similar" |
| `guilds` | "the list of servers they are in (names and ids, not contents)" |
| `guilds.join` | "allows the bot to add them to a server you own" |
| `guilds.members.read` | "their nickname and roles inside a server you own" |
| `role_connections.write` | "required if you use Discord's linked-roles feature" |
| `webhook.incoming` | "creates a webhook in a channel they pick" |
| `relationships.read` | **"their friends list, pending friend requests, and blocked users. Restricted scope, requires Discord approval, and you must disclose and handle it under Discord's Social SDK terms."** |
| `gdm.join` | "join a group DM" |

Defaults: `identify`, `email`, `guilds.join`. `relationships.read` requires a separate acknowledgement checkbox in the wizard and a saved `acknowledged_restricted_scopes` timestamp in `guilds.settings_json`; without it the wizard refuses to include the scope and `/verify panel` refuses to build a panel that requests it.

### 7.3 Developer Portal checklist the wizard enforces

`/setup app` walks this and **verifies what it can from the API** rather than trusting the operator:

1. Application created, bot user present. Wizard calls `GET /applications/@me` and shows name, id, and whether the bot token matches the owner id given in `.env`.
2. **Redirect URIs** registered. Wizard cannot create these, so it prints the exact string to paste, computed from `PUBLIC_BASE_URL`: `{PUBLIC_BASE_URL}/callback`. It then runs a self-test (`7.6`) that fails with a specific message if the redirect is missing or mismatched.
3. **Privileged intents**: `GUILD_MEMBERS` on. Wizard reads `GET /applications/@me`'s `flags` and the gateway handshake; if the intent is not granted the bot never reaches `ready`, so the wizard reports "the gateway refused `GUILD_MEMBERS`" with the toggle path.
4. **Install link / authorization URL** generated from the selected scopes, shown as a copyable code block plus a "open in browser" step.
5. **Bot permissions** for the invite: administrator is not required and is discouraged; the wizard computes the exact bitfield from the features enabled (manage roles, manage channels, manage webhooks, ban members, manage guild, manage messages, read message history, manage emojis and stickers, manage expressions, manage events, moderate members, view audit log) and generates the invite with that number.
6. **Interactions endpoint**: not used. This bot is gateway-only. Wizard says so explicitly, because half the tutorials online tell people to set it and a stale endpoint URL breaks slash commands with a silent `401` on every interaction. (`[v]` an interaction endpoint set while running a gateway client causes "The application did not respond" for every command; it is the single most common self-host support ticket.)
7. **Public key**: irrelevant for gateway, wizard says skip.

### 7.4 Cloudflare Tunnel guide (in the wizard and in `docs/cloudflare-tunnel.md`)

Why: Discord requires **HTTPS** for a redirect URI. Local development has no certificate, so the tunnel provides one.

Steps the wizard prints, with a copyable command per step:

1. `cloudflared tunnel login`
2. `cloudflared tunnel create snapback`
3. Write `~/.cloudflared/config.yml` mapping a hostname to `http://localhost:8080`
4. `cloudflared tunnel route dns snapback verify.example.com`
5. `cloudflared tunnel run snapback`
6. Set `PUBLIC_BASE_URL=https://verify.example.com`
7. **Tick the Cloudflare tunnel checkbox** in the wizard. This sets `BEHIND_CLOUDFLARE_TUNNEL=true`.

The checkbox is not cosmetic. It changes IP capture (`14.1`): with a tunnel, every request arrives from `127.0.0.1`, and the only trustworthy source of the real client IP is `CF-Connecting-IP`. Without the checkbox set, the captured IP is `::1` for every user, which silently corrupts the entire record set and, worse, makes every "VPN check" look identical. The wizard runs a live probe after the toggle: it tells the operator to open `{PUBLIC_BASE_URL}/health?probe=1` in a browser on their phone, and the wizard confirms whether the captured IP looks like a real public address rather than a loopback. If it sees a loopback address it says "tunnel mode is on but no `CF-Connecting-IP` arrived; check that the tunnel is actually in front of this port."

Also documented: quick tunnels (`cloudflared tunnel --url http://localhost:8080`) work but the hostname is random and changes on restart, which breaks the registered redirect URI. The wizard says that up front.

### 7.5 Non-Cloudflare deployments

| Setup | `BEHIND_CLOUDFLARE_TUNNEL` | IP source |
|---|---|---|
| Cloudflare Tunnel or Cloudflare proxied DNS | `true` | `CF-Connecting-IP` |
| nginx / Caddy reverse proxy | `false`, `TRUSTED_PROXY_DEPTH=1` | rightmost-minus-N of `X-Forwarded-For` |
| Direct exposure | `false`, `TRUSTED_PROXY_DEPTH=0` | socket address |
| ngrok | `false`, `TRUSTED_PROXY_DEPTH=1` | `X-Forwarded-For` |

`TRUSTED_PROXY_DEPTH` matters: taking the leftmost `X-Forwarded-For` entry lets any client prepend a fake IP. `web/capture/ip.ts` walks from the right, skipping `TRUSTED_PROXY_DEPTH` entries, and validates every candidate as a parseable IP before accepting it (`14.1`).

### 7.6 Connection self-test

`/setup app test` runs a scripted check and reports one line per step, pass or fail with a fix:

| Step | Pass condition | Failure message |
|---|---|---|
| Token valid | `GET /users/@me` returns the bot user | "token rejected (401). Regenerate in the Developer Panel" |
| Owner id correct | `DISCORD_OWNER_ID` resolves to a real user and equals the configured owner | "owner id does not resolve" |
| Gateway connected | shard reaches ready | "gateway closed with code 4004: authentication failed" |
| `GUILD_MEMBERS` granted | a 1000-limit member fetch on the dev guild returns without `50001` | "fetch members failed with 50001, enable the Server Members intent" |
| Web port reachable | local socket accept on `PORT` | "nothing listening on 8080" |
| Public URL resolves | `GET {PUBLIC_BASE_URL}/health` from the public internet via a third-party fetch | "PUBLIC_BASE_URL did not respond over HTTPS" |
| Redirect registered | OAuth authorize URL request returns 200 and not `invalid_redirect_uri` | "add {PUBLIC_BASE_URL}/callback to Redirect URIs in the Developer Panel" |
| OAuth round-trip | full authorize with a throwaway account, exchange code, revoke | "code exchange failed: invalid_client, check the client secret" |
| History readable | `GET /channels/{id}/messages?limit=1` on a channel in the dev guild returns without `50001` | "read message history failed: grant `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` to the bot" |
| Message content present | that same fetch returns a non-empty `content` for a text message | "message content came back empty; check channel permissions, not the Message Content intent" |

Note on that last one, because it is a widespread myth: **message backup does not need the Message Content intent.** That intent gates the *gateway* `MESSAGE_CREATE` payload's `content` field. Snapback reads history over REST (`GET /channels/{id}/messages`), which returns `content` whenever the bot has `READ_MESSAGE_HISTORY` and `VIEW_CHANNEL`. The intent is only needed if live-capture mode (`11.7`) is enabled, and the wizard says exactly that rather than telling people to flip a privileged toggle they do not need.

---

## 8. Command surface

Slash commands only. No prefix commands, no message handlers to maintain. Global registration in production, `DISCORD_DEV_GUILD_ID` guild registration when set (instant propagation).

Every command is owner-or-guild-admin gated by `discord/registry.ts` before the handler runs. A non-admin gets an ephemeral container: "you are not a Snapback admin for this server" plus a button explaining how to ask the owner. No stack traces.

`default_member_permissions` is deliberately unset so commands are visible; authorisation happens in code, because Discord's permission model cannot express "Snapback admin" (a DB list) or per-flag granularity.

### `/setup`

The wizard. Stateful, resumable, subcommands to jump straight to a step.

| Subcommand | Does |
|---|---|
| `/setup` | opens the wizard at the first incomplete step |
| `/setup status` | one page: every subsystem with a green/amber/red dot, and for amber/red a button that jumps to the fix |
| `/setup app` | Developer Panel checklist (`7.3`) and `/setup app test` self-test (`7.6`) |
| `/setup web` | `PUBLIC_BASE_URL`, port, tunnel checkbox, live IP probe (`7.4`) |
| `/setup admins` | add/remove/list admins, per-flag toggles |
| `/setup backup` | default include set, message counts, auto-backup schedule |
| `/setup restore` | restore defaults: clear-before, timestamp suffix, default selections |
| `/setup verify` | build and manage panels, choose scopes, choose redirect target |
| `/setup branding` | bot avatar and banner upload (GIF accepted), bot display name |
| `/setup logs` | log channel, event families, test-fire a log entry |
| `/setup privacy` | IP storage mode, retention policy, website disclosure text |
| `/setup data` | DB status and size, back up the DB, export everything to JSON |
| `/setup guide` | renders `docs/setup.md` in paginated Components V2 pages |

### `/backup`

| Subcommand | Options | Does |
|---|---|---|
| `/backup create` | `label`, `messages` (bool), `members` (bool), `message_limit` (int, clamped) | queues a backup job |
| `/backup list` | `page` | paginated table with per-row select + delete button |
| `/backup info` | `backup` (autocomplete) | counts, size, age, contents summary, restore button |
| `/backup restore` | `backup`, `target_guild` | hands off to `/restore`'s selection UI prefilled |
| `/backup delete` | `backup`, `confirm` | hard-deletes rows and asset files |
| `/backup export` | `backup`, `format` | writes a JSON or zip into the export dir and returns it as a file component |
| `/backup prune` | `dry_run` | applies retention policy and reports what would go |

### `/restore`

| Subcommand | Options | Does |
|---|---|---|
| `/restore start` | `backup`, `target_guild` | opens the category selection UI (`12.1`) |
| `/restore status` | `job` | live progress page with pause/cancel |
| `/restore cancel` | `job` | cooperative cancel at the next checkpoint |
| `/restore plan` | `backup`, `target_guild` | dry run: prints the diff between backup and target with no writes |
| `/restore members` | `backup`, `target_guild` | member-and-role-only restore, no channel or message work |
| `/restore messages` | `backup`, `target_guild`, `channels` | message-only re-replay into an existing structure |

### `/verify`

| Subcommand | Options | Does |
|---|---|---|
| `/verify panel` | opens the panel builder (`8.1`) | |
| `/verify list` | | all panels in this guild, with edit/repost/disable |
| `/verify records` | `page`, `filter` | paginated record browser, per-user detail view |
| `/verify user` | `user` | full record for one user, all captured fields |
| `/verify refresh` | `all` (bool) or `records` | re-checks every token against Discord, live-edits the message per user, reports who revoked |
| `/verify delete` | `user`, `scope` (`record`\|`ip`\|`token`\|`all`), `confirm` | the only path that erases captured data |
| `/verify export` | `format`, `filter` | JSON or CSV of records |
| `/verify stats` | | verified count, revoked count, scopes in use, intel breakdown |

### `/pull`

| Subcommand | Options | Does |
|---|---|---|
| `/pull start` | `source_guild`, `target_guild`, `exclude_revoked`, `max` | adds verified users to a guild via `guilds.join` |
| `/pull status` | `job` | live page with per-account counters |
| `/pull counters` | `page` | `account_counters` table: per user, today's attempts, cooldown state |
| `/pull reset` | `user`, `confirm` | clears a cooldown or daily counter by hand |
| `/pull config` | | daily limit per account, cooldown hours, auto-pull toggle |

### `/users`

| Subcommand | Options | Does |
|---|---|---|
| `/users lookup` | `user` or `id` | identity + membership + record + counters, one page |
| `/users export` | `scope` | JSON dump of records or members |
| `/users blacklist` | `add`/`remove`/`list` | per-guild blacklist by user id, ip hash, or asn |

### `/snapback`

| Subcommand | Does |
|---|---|
| `/snapback status` | bot uptime, gateway latency, job queue depth, DB size, tracked guilds, version |
| `/snapback diagnostics` | runs the full self-test (`7.6`) plus DB, disk, and permission probes, returns a copyable report |
| `/snapback version` | version, commit, Oceanic version, schema version |
| `/snapback help` | paginated `docs/` index |

---

## 9. Interface system

Everything the user sees is Components V2. No classic embeds anywhere except where a Discord limitation forces it (see `9.5`).

`[v]` The rules that constrain the design:

- `MessageFlags.IS_COMPONENTS_V2` is `32768`. Setting it disables `content` and `embeds` on that message. The flag can never be removed once set.
- **40 components per message, total.** That is the budget for the entire layout tree, including nested children. This is the number that shapes pagination.
- Layout: Action Row (1), Section (9), Container (17).
- Content: Text Display (10), Thumbnail (11), Media Gallery (12), File (13), Separator (14).
- Interactive: Button (2), String Select (3), User Select (5), Role Select (6), Mentionable Select (7), Channel Select (8), Label (18), File Upload (19), Radio Group (21), Checkbox Group (22), Checkbox (23).
- Container children allowed: Action Row, Text Display, Section, Media Gallery, Separator, File. Container `accent_color` runs `0x000000`-`0xFFFFFF`.
- Section: 1-3 Text Displays plus exactly one accessory (a Thumbnail or one Button).
- In modals, only Label (18) and Text Display (10) may be top-level.
- Oceanic has **no component builder classes**. Components are plain objects with camelCase keys (`customID`, `maxValues`, `minValues`); raw payload keys are snake_case. `10.1` picks one convention and sticks to it.

### 9.1 Component factories

`discord/components/` exports plain functions returning plain objects. No classes, no builders, no state.

```
container({ accent, children })
section({ texts, accessory })
textDisplay(md)
separator({ divider, spacing })
actionRow(components)
button({ id, label, style, emoji, disabled })
stringSelect({ id, placeholder, options, min, max, disabled })
roleSelect(..) userSelect(..) channelSelect(..) mentionableSelect(..)
mediaGallery(items) file(url) thumbnail(url)
checkbox({ id, label, default, description })
radioGroup({ id, options })
checkboxGroup({ id, options })
```

`textDisplay` takes markdown. Containers never nest inside containers.

### 9.2 Page grammar

Every multi-step surface is built from one function:

```
page({ state, title, sections, controls, status })
  -> one Container, accent by status, title row, body sections,
     separator, then at most two Action Rows of controls
```

Budget per page: 1 container + N sections + separators + up to 2 rows. `page()` asserts the total against the 40 cap and, if the caller overflows, throws in development and truncates with a visible "page truncated" footer in production. A silently truncated message that drops the confirm button is worse than an error.

### 9.3 Navigation and state

Buttons carry their whole context in the `customID`. No module-level maps.

Namespace:

```
sb:<surface>:<guild>:<jobOrObj>:<action>:<cursor>
```

All ids are `\x1f`-free and under the 100-char customID limit; anything longer (a selection payload) goes into `interaction_state` in the DB, keyed by a short random id embedded in the customID, with a 15-minute TTL swept by the scheduler.

Every handler starts by re-checking authorisation against the DB. A button that was rendered for an admin and then re-sent by a demoted user must fail closed. Also re-check ownership: only the user who opened a wizard may drive it, unless the surface is explicitly marked shared. Tracking cookies are a thing.

### 9.4 Colour and status language

One mapping, used everywhere, so an operator learns it once:

| Status | Accent | Used for |
|---|---|---|
| info | `0x5865F2` (blurple) | neutral pages, wizards |
| success | `0x57F287` | job finished, verification verified |
| warning | `0xFEE75C` | partial success, cooldown, retention about to prune |
| danger | `0xED4245` | failure, revoked token, destructive confirm |
| busy | `0xEB459E` | job running, progress pages |

Destructive actions never have their confirm button on the same page as the trigger. They open a second page whose confirm button carries `danger` style and a customID with a one-time nonce, and it expires in 15 minutes.

### 9.5 The two places classic embeds still appear

1. **Verify panel**, if the owner wants a plain embed with a link button. The user explicitly asked for an embed with title, colour, message, thumbnail, and a link button. A Components V2 Container reproduces all of that (title text, accent colour, body text, Thumbnail accessory or Media Gallery, and a Link button inside an Action Row), so the panel is Components V2 by default. The classic-embed path exists only for the case where the target channel is owned by an older client experience, and it is opt-in.
2. **Webhook-replayed messages during restore.** `[v]` Non-app-owned webhooks ignore `components` unless the request passes `?with_components=true`, and when `IS_COMPONENTS_V2` is set the webhook message may contain *only* components. Rather than take on that constraint for restored history, restored messages are sent as ordinary webhook messages with `content` and embeds, which is what they originally were. Fidelity beats consistency here.

### 9.6 Accessibility and discipline

- No state conveyed by colour alone. Every coloured container also carries a word: "done", "failed", "running".
- Removed or renamed options do not break old buttons: an unknown customID returns an ephemeral "this button is from an older version" page instead of an unhandled rejection.
- Every interactive component handler is registered in `interactions/router.ts` at boot. A boot check asserts that every `customID` produced by `discord/components/` has a matching handler prefix. Catches the classic "I added a button and forgot the handler" bug at startup.

---

## 10. Setup wizard

A resumable state machine, persisted in `guilds.settings_json` under `wizard`. Each step has `done`, `skipped`, `at`. The wizard honours "skip for now" everywhere and `/setup status` shows what is still outstanding, so a partial setup is a supported state rather than a broken one.

### 10.1 Step order

| # | Step | Required to finish | Notes |
|---|---|---|---|
| 0 | Welcome and scope disclosure | yes | says what the bot will do, and what the verification feature captures |
| 1 | App check (`7.3`, `7.6`) | yes | blocks on token, owner id, gateway, `GUILD_MEMBERS` |
| 2 | Web and tunnel (`7.4`) | only if verification is enabled | includes the loopback-IP probe |
| 3 | Branding | no | avatar and banner upload, GIF accepted (`10.2`) |
| 4 | Admins | no | wizard offers the invoking user first |
| 5 | Logging | no | pick channel, test-fire one entry so the operator sees it work |
| 6 | Backup defaults | no | include set, message limits, auto-backup schedule |
| 7 | Restore defaults | no | clear-before off by default, timestamp suffix off by default |
| 8 | Verification panel | only if verification is enabled | `10.3` |
| 9 | Scopes | only if verification is enabled | default three, restricted scope needs an acknowledgement |
| 10 | Privacy | yes | IP storage mode, retention, disclosure text |
| 11 | Finish | yes | writes `wizard.done`, prints the invite, the command list, and the docs pointer |

### 10.2 Branding upload

Discord's bot avatar endpoint takes image data. GIF is accepted for the bot avatar (animated avatars are supported for bots); the banner is not animated anywhere in Discord's UI. Two Upload components in a modal, or a message-with-attachment path where the operator drops a file and the wizard reads it.

Constraints enforced before upload: png/jpg/gif, and a size ceiling (the API rejects oversized payloads; the wizard resizes via a pure-JS image pass rather than sending and hoping). Non-square images are centre-cropped, with the crop previewed as a Thumbnail component before the operator confirms. Nothing is uploaded until they press apply.

### 10.3 Verification panel builder

Fields, in the order the user asked for them:

| Field | Control |
|---|---|
| Channel | Channel select (type 0 and 5 only) |
| Title | text input (modal) |
| Description | text input, multiline (modal) |
| Colour | preset row of five swatches as buttons, plus a modal for a hex value |
| Thumbnail | URL text input, or an upload |
| Button label | text input, default "Verify" |
| Button style | Link (fixed when it points at the site) or Primary |
| Button URL | derived from `PUBLIC_BASE_URL`, editable, defaulted and validated |
| Scopes | checkbox group, consequence lines from `7.2` |
| Redirect target | read-only display of `{PUBLIC_BASE_URL}/callback` with a copy button |

Then a live preview: the wizard posts the assembled panel **to the wizard channel only** with a "send to #channel" button and a "discard" button. The preview is the real component tree, not a mock, so what is previewed is what ships. This catches the 40-component overflow and the "link button inside a section accessory" mistake before it reaches production.

### 10.4 Wizard failure behaviour

- If the guild is lost mid-wizard (bot kicked, or the operator closes Discord), the wizard resumes from the last persisted step on the next `/setup`.
- If a component interaction arrives for a wizard step from a different user, it is refused with an ephemeral note naming the original invoker.
- If a step's precondition is now false (say, the port stopped listening between steps), the step re-validates and says so rather than writing a broken config.

---

## 11. Backup engine

A backup is a job. Steps run in a fixed order, each writing a checkpoint so a crash resumes rather than restarts.

| # | Step | Endpoint(s) | Notes |
|---|---|---|---|
| 1 | Guild settings | `GET /guilds/{id}`, `/guilds/{id}/widget`, `/vanity-url` | name, icon, splash, banner, discovery splash, verification level, explicit content filter, notifications, locale, system channel flags, afk channel and timeout, rules channel, public updates channel, safety alerts channel, preferred locale, premium tier |
| 2 | Assets | download | icon, banner, splash, discovery splash into `assets/` |
| 3 | Roles | `GET /guilds/{id}/roles` | see `11.2` |
| 4 | Emojis | `GET /guilds/{id}/emojis` | download each image |
| 5 | Stickers | `GET /guilds/{id}/stickers` | download each |
| 6 | Soundboard | `GET /guilds/{id}/soundboard-sounds` | download each |
| 7 | Channels | `GET /guilds/{id}/channels` | categories, then everything else; overwrites recorded with target names, not just ids (`11.3`) |
| 8 | Threads | `GET /guilds/{id}/threads/active` plus archived via `GET /channels/{id}/threads/archived/public` and `/private` | captured only when message backup is on |
| 9 | Onboarding | `GET /guilds/{id}/onboarding` | prompts, default channels, mode, enabled |
| 10 | Welcome screen | `GET /guilds/{id}/welcome-screen` | `[v]` only Community guilds have one; Discord errors rather than returning null, so a failure here means "no welcome screen", never a failed backup. Capture the `WELCOME_SCREEN_ENABLED` feature flag alongside it |
| 11 | Automod | `GET /guilds/{id}/auto-moderation/rules` | |
| 12 | Scheduled events | `GET /guilds/{id}/scheduled-events?with_user_count=true` | |
| 13 | Bans | `GET /guilds/{id}/bans` | paginated; needs `BAN_MEMBERS` |
| 14 | Members | paginated `GET /guilds/{id}/members` | see `11.4` |
| 15 | Messages | per text channel | see `11.5` |
| 16 | Finalise | | counts, size, `size_bytes`, seal the row |

Order matters: channels before messages (messages need channel identity), roles before members (members reference roles), members before messages (message authors need nicknames).

### 11.1 What is deliberately not backed up

Stated in the UI, not just here, so nobody discovers it during a recovery:

- **Voice/stage states.** Ephemeral by nature.
- **Invites.** `GET /guilds/{id}/invites` returns codes, and Discord will not let you re-create an invite with the same code. We capture the list for the record, flagged "not restorable".
- **Presences, typing, read states.** Not exposed.
- **Guild features** (verified, partnered, vanity URL, discovery). Cannot be set by a bot.
- **Bot-managed / integration roles.** Discord refuses to create or delete them. Captured with `is_bot_managed` and re-linked by name during restore where a matching integration exists (`12.3`).
- **Message attachments' bytes.** URLs expire. Attachments are recorded as metadata (filename, size, content type, signed URL) and, if the file is under a configurable ceiling (default 8 MiB) and still fetchable, downloaded into `assets/attachments/`. Bigger files and expired URLs are recorded with `url: null` and `reuploaded: false`, and the restore reports them as "attachment could not be preserved" rather than silently dropping them. This is an honest limitation that every reference project hides `[r]`.
- **The 250-role / 500-channel guild caps.** We do not hard-block; we let Discord return its error and surface the parsed code (`18.2`). If the observed limits differ from what people repeat online, the bot is right and the folklore is wrong.

### 11.2 Roles

`GET /guilds/{id}/roles` returns each role with `name`, `color`, `hoist`, `icon`, `unicode_emoji`, `position`, `permissions`, `managed`, `mentionable`, `tags` (including `bot_id`, `integration_id`, `premium_subscriber`, `subscription_listing_id`, `available_for_purchase`, `guild_connections`), `flags`.

`is_everyone` is `role.name === "@everyone" && role.position === 0`, matching the reference `[r]` but with the id check added too (`role.id === guild_id` is the actual invariant, and it is cheaper and cannot be spoofed by a role someone renamed).

Role **icon** is a per-role asset and gets the same download treatment as the guild icon. `[v]` the role object carries `icon` (image data) and `unicode_emoji`, both gated on the guild's `ROLE_ICONS` feature. A guild without that feature returns neither, so both are captured as nullable and the restore skips them when the target lacks the feature.

### 11.3 Channels and overwrites

`GET /guilds/{id}/channels` returns categories (type 4) and everything else in one list. We store `parent_id` as a **source** id and resolve it on restore.

The critical difference from every reference project: overwrites are captured with **the target's name as well as its id**. `[r]` RestoreCord stores `roleId` plus the allow/deny bits, and androz stores `roleName`. RestoreCord's restore then remaps by name anyway, because the id is meaningless in the target guild. So do it properly: store `source_target_id`, `target_type`, and `target_name`, and resolve by name with the id as a tiebreak. Name resolution has a failure mode (two roles with the same name) which the restore surfaces as a warning rather than picking arbitrarily.

Channel types captured: 0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum, 16 media. Thread types (10, 11, 12) are captured in `backup_threads`, never in `backup_channels`. `[r]` RestoreCord filters out types 6, 10, 11, 12 from its channel list, which is right about 10/11/12 and wrong about nothing else, since 6 is a legacy store channel that no longer exists.

### 11.4 Members

`GET /guilds/{id}/members?limit=1000&after={last_user_id}`, paginating on `after` until a short page returns. `[v]` limit is 1-1000 and the `GUILD_MEMBERS` intent is required.

Per member: user id, username, global name, discriminator, nickname, avatar URL, joined timestamp, `is_bot`, role ids, `pending` (not yet passed membership screening), `timed_out_until`, `premium_since`, `flags`. Also `source_role_names_json`, because role ids are useless in a target guild and looking them up later per member costs a join.

Avatar URLs are captured **and** downloaded where the avatar is a custom one. Default avatars are recomputed deterministically on restore instead of stored (`12.5`).

This is the step that eats memory. A 100k-member guild with avatars is a lot of objects, so members are processed and flushed in batches of 1000, never held whole.

### 11.5 Messages

Per text-based channel (`0`, `5`, `15`, `16`, and threads when enabled): `GET /channels/{id}/messages?limit=100&before={oldest_id}`, paginating backwards to the configured limit.

Limits, enforced in code:

- `MAX_MESSAGES_PER_CHANNEL` default 1000, configurable per backup, ceiling 10000.
- `MAX_MESSAGES_TOTAL` default 10000, ceiling 10000, not raisable.

The 10k total ceiling exists because a full replay of a large guild is hours of webhook posts and is the single easiest way to get the bot rate-limited into a global bucket. The assistant's job here is to be blunt about that in the UI: `message_limit` over 1000 shows a warning page stating the approximate duration.

Per message captured: id, author (id, username, global name, nickname, avatar URL, `is_bot`, `webhook_id`), content, embeds, attachments, stickers, components, reactions, message reference, thread, flags, pinned, type, created and edited timestamps.

Filtering. Default set is 0 (`DEFAULT`), 19 (`REPLY`), and 20 (`CHAT_INPUT_COMMAND`) — the three that are actual conversation. Everything else (joins, boosts, pins, thread creates) is off by default because it replays as noise in a restored channel, and each is a toggle in `/setup backup` for anyone who wants it. The reference keeps 0 and 19 only `[r]`; we add 20 because slash-command invocations often carry the only visible record of what a command produced.

A message with no content, no embeds, no attachments and no stickers is still stored if it has reactions or components; the reference drops those `[r]`, which loses poll results and button messages. We keep them.

**Author avatar fallback.** `[r]` RestoreCord falls back to `https://cdn.discordapp.com/embed/avatars/{discriminator % 5}.png`. That is wrong for the modern username system, where most users have no discriminator. The correct fallback is the same computation Discord itself uses, and for users who have never set an avatar we store `null` and let the restore recompute it (`12.5`).

### 11.6 Self-check after backup

Before a backup is marked sealed, it validates itself:

- every channel has a resolvable `parent_source_id` (or is top-level)
- every member's `role_ids_json` entries exist in `backup_roles` or are flagged as integration roles
- every overwrite target resolves to a captured role or a captured member, or is flagged unresolved
- every message's `channel_source_id` exists
- counts recorded match the rows actually written

A backup that fails self-check is stored but marked `incomplete` with the specific failures listed in `/backup info`. It can still be restored; the restore simply warns. Silent partial backups are the failure mode this prevents.

### 11.7 Live capture (optional, off by default)

An optional mode where the bot records message create/edit/delete events from the gateway into the backup as they happen, so a busy guild's history stays current between scheduled backups. Requires `GUILD_MESSAGES` and, for content, the Message Content intent.

Guarded: only enabled for guilds that opted in, only for channels in a configured allow list, and only while a backup row is open. Deleted-message capture stores the content with a `deleted_at` marker. This is a power feature and it is documented as one.

---

## 12. Restore engine

### 12.1 Selection UI

The restore starts with a selection page. One checkbox per category, defaults prefilled from `/setup restore`, and a sub-page per category for detail.

Categories and their sub-options:

| Category | Sub-options |
|---|---|
| Guild settings | name, icon, banner, splash, verification level, content filter, notifications, locale, afk, system channel flags, widget |
| Roles | all, or a role picker; whether to overwrite existing roles with the same name; whether to delete target roles that are not in the backup |
| Channels | all, or a channel picker; whether to create categories, whether to overwrite topic/permissions of existing same-name channels |
| Permission overwrites | included or skipped; whether to overwrite existing |
| Members | roles only (safe), or roles plus nickname; whether to strip roles the backup does not know about |
| Messages | channel picker, per-channel cap, whether to append a timestamp suffix (`12.6`) |
| Bans | all or by user |
| Emojis, stickers, soundboard | all or picker; name-collision policy |
| Automod | all or picker |
| Scheduled events | all or picker |
| Onboarding, welcome screen | included or skipped |
| **Clear target first** | destructive, requires its own confirmation page (`12.7`) |

Target guild: a channel/guild picker, or "this guild". `[+]` the user asked for "restore users to a new server or any server with a selection menu where they select" - so the target picker lists every guild the bot is in, and the restore is allowed across guilds as long as the bot has the needed permissions in the target.

A `dry_run` plan is always available (`/restore plan`) and is offered as a button on the confirm page: "preview what will change". The plan is a diff summary (create N roles, edit M channels, post K messages, ban B users) with no writes.

### 12.2 Execution order

Reverse of backup, and the order is not negotiable:

1. Guild settings (name, icon, banner) - done first so an abort leaves a recognisable guild, and because the icon upload is the most likely thing to fail (`12.8`)
2. Emojis, stickers, soundboard - **before** roles, because role icons and emojis can reference them, and automod actions reference emoji ids
3. Roles (create, then adjust permissions, then order)
4. Category channels
5. Non-category channels with parent resolution
6. Channel overwrites (needs both roles and channels to exist)
7. Threads (need their parent messages)
8. Onboarding and welcome screen (reference channels)
9. Automod rules (reference roles and channels)
10. Scheduled events (reference channels)
11. Members (roles and nicknames; needs roles)
12. Bans
13. Messages (last, because it is the slowest and the most likely thing an operator aborts)
14. Verification panel repost, log entry, finish

Rate limiting is handled by the shared limiter, not by sleeps. Every reference project uses `setTimeout` sleeps at fixed values (`[r]` 1800 ms per role, 150 ms per message, 500/750 ms per delete), which is simultaneously too slow on a quiet token and too fast on a busy one. `discord/ratelimit.ts` reads the `X-RateLimit-*` headers and the `429` `retry_after`, and backs off per-bucket. Paths are grouped into buckets matching Discord's own bucket names so a burst of webhook posts does not trip the channel-edit bucket.

### 12.3 Roles

- `@everyone` is **edited**, never created. Its permissions are set from the backup.
- Non-`@everyone`, non-managed roles are created, ordered by `position` **descending**, and then reordered in one `PATCH /guilds/{id}/roles` call with an array of `{id, position}` rather than one call per role. `[r]` RestoreCord creates in order with a sleep between each and never reorders, meaning a restored guild's hierarchy is whatever Discord decided.
- Matching existing roles: if a role with the same name exists, the default is to reuse and edit it rather than create a duplicate. Configurable to force-create.
- Bot-managed roles cannot be created or deleted. If the backup has a role with `bot_id` and the target guild has an integration role from the same application, they are linked by name in the mapping table. If there is no matching integration, the role is reported as "not restorable: integration role from an application not in this guild".
- Role colour, hoist, mentionable, icon and unicode emoji are all set. `[v]` icon and `unicode_emoji` go in the same `POST`/`PATCH` body as `color` (data URI for the icon), no separate upload call. The target guild must have `ROLE_ICONS`; if it does not, the icon is dropped and the report says so rather than the request failing.

### 12.4 Channel overwrites

Overwrites are remapped **by target name**, with the source id as a tiebreak, into the new guild's ids.

Resolution order for a role overwrite:

1. exact name match against a role we just created from the same backup row (tracked in an in-memory map for the job)
2. exact name match against an existing target role
3. `@everyone` if the name is `@everyone`
4. otherwise unresolved, warning emitted, overwrite skipped

Member overwrites resolve against the target member list by user id (ids are global, so this one is exact and free).

The `allow`/`deny` bitfields are copied as 64-bit values. They cross the wire as strings and are only `BigInt` in the DB layer (`5.1`). A naive `Number(permissions)` silently corrupts bit 62 (`VIEW_GUILD_INSIGHTS` and friends), which is exactly the kind of bug that makes a restored server look fine and be subtly wrong.

Bitrate is clamped into the target guild's tier (`[v]` min 8000; tier ceilings 64000 / 128000 / 256000 / 384000, chosen by the guild's boost tier) rather than `[r]` the hardcoded 96000 in the reference. `user_limit` is clamped to the documented maxima for the channel type.

### 12.5 Members

Three modes, in increasing order of how much they can break:

1. **Roles only** (default). For each backup member who is currently in the target guild, set their roles to the intersection of (backup roles) and (roles present in the target), by name. This is safe and reversible.
2. **Roles plus nickname.** Also sets the nickname, which needs `MANAGE_NICKNAMES` and cannot exceed 32 characters; longer ones are truncated with a warning.
3. **Sync.** Removes target roles that are not in the backup. Dangerous, off by default, requires its own confirmation.

Members who are **not** in the target guild cannot be added by this path. Adding a user requires a `guilds.join` token they granted, which is the pull engine (`15`), a separate flow with its own consent model. The restore result page says so explicitly and offers a "pull verified users" button when records exist.

Timeouts: `PATCH /guilds/{id}/members/{user_id}` with `communication_disabled_until`. `[v]` the maximum is 28 days; a restored value in the past is dropped rather than sent (Discord rejects past timestamps or clears the timeout, and silently sending a past date to "clear" is a behaviour difference worth choosing deliberately: we drop it and log).

### 12.6 Messages

The mechanism: one webhook per channel.

1. `POST /channels/{id}/webhooks` with `{name, avatar}` — `[v]` `avatar` (image data) is accepted on create, so one call sets name and avatar. Name it `Snapback`, and reuse the webhook for every message in the channel.
2. For each stored message, `POST /webhooks/{id}/{token}` with `{content, username, avatar_url}`.
3. `DELETE /webhooks/{id}` when the channel is done (and in a `finally`, so an aborted job does not leave webhooks behind; a startup sweep deletes orphaned Snapback webhooks too).

What is preserved: content, author display name, author avatar, embeds (as embeds), attachments (re-uploaded where the file was saved, otherwise their URL if it still resolves).

What is **not** preserved, stated plainly in the restore report:

- **Timestamps.** Discord sets the webhook message's timestamp at post time. There is no way to forge it. The optional `restore_message_timestamp_suffix` appends a small line to each message, e.g. `-# originally sent <t:1735689600:f>`, which uses Discord's own relative-timestamp rendering. Off by default because it changes message content.
- **Reactions, pins, threads on those messages** in the default path. Reactions need one request each and are off unless enabled. Pins need `PUT /channels/{id}/pins/{message_id}` per message and are off unless enabled.
- **Message ids and references.** Reply chains cannot be rethreaded, because the reply target's id changed. Backups with replies record the relationship; restore posts them as plain messages and says so in the report.
- **Author identity.** The message appears from the webhook, which is impersonating the author's name and avatar but is not the author. Anyone hovering sees the webhook's name. This is a Discord-level truth, documented rather than hidden.

Ordering: sorted by created timestamp ascending, then posted sequentially per channel. Parallel channels, sequential within a channel, so each channel's history reads in order.

Interruptions: the job checkpoints `job_progress.cursor` after every 100 messages. A restart resumes from the cursor rather than duplicating 5000 messages. Duplicate protection: on resume, the webhook's existing last messages are not re-read (webhook messages cannot be listed by the bot after posting without `MANAGE_MESSAGES` reads), so the cursor is the only source of truth. It is written after the post is acknowledged, which means a crash can duplicate at most one message per 100. That tradeoff is documented and is the right one.

### 12.7 Clearing the target

`clear before restore` deletes channels, then roles, then (optionally) bans, in that order.

Deleting channels: for channels with messages, `POST /channels/{id}/messages/bulk-delete` takes 2 to 100 ids and refuses anything older than 14 days `[v]`. Three documented traps, all handled in one helper: a single id is a `400` (the minimum is 2), ids that do not exist still count toward the 2-100 range (so a batch of 100 with 40 stale ids is fine but a batch of 1 stale id is not), and clearing a channel older than 14 days needs individual `DELETE /channels/{id}/messages/{id}` calls at one request each. Prefer `DELETE /channels/{id}` when the whole channel is going anyway; bulk-delete only matters when the channel is kept and emptied.

Deleting roles: `DELETE /guilds/{id}/roles/{role_id}` for every non-`@everyone` non-managed role.

Because this is the most destructive thing the bot does, it is triple-guarded:

1. its own page, not a checkbox on the selection page
2. an acknowledgement input requiring the operator to type the guild name
3. a 15-minute nonce on the confirm button, single use

And it refuses to run if the target guild is the bot's `DISCORD_DEV_GUILD_ID` unless an explicit env flag is set. Eating your own test server once is enough.

### 12.8 Failure handling per step

Each step is independently resumable and independently failable. The restore continues past a failed step unless the step is a dependency of a later one, in which case the dependent steps are marked `skipped (dependency failed)`.

| Failure | Behaviour |
|---|---|
| Icon upload rejected (too large, unsupported) | skip, note, continue. Never abort a whole restore for a banner. |
| Role creation hits the role cap | note the count Discord reported, stop creating, continue with everything that does not need roles |
| Channel name invalid (bad characters after sanitisation) | sanitise, note the change |
| Parent category missing | create the channel at top level, note it |
| Overwrite target unresolved | skip the overwrite, note it |
| Member left the guild | skip, count as "member absent", include in the pull suggestion |
| Webhook creation denied (`MANAGE_WEBHOOKS` missing) | stop the message phase only, report per channel which ones could not be replayed |
| Message payload rejected (`50035`) | log the parsed `errors` object, skip that message, continue, count it |
| `429` | the limiter handles it; sustained global 429 pauses the job and reports |
| Token invalidated mid-job | pause the job, say so, keep the checkpoint |
| Gateway reconnect | jobs are not gateway-dependent, so nothing happens; the progress message is re-edited on ready |

The end report lists per category: created, edited, skipped, failed, with the first few failure reasons inline and a "full report" file attachment for the rest. No reference project produces a restore report `[r]`; they print progress and end with nothing.

---

## 13. Verification and the website

### 13.1 Routes

Five routes, one process, no framework.

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | landing page. If `?guild=<id>` is present, shows that guild's name and icon and a Verify button. Otherwise a neutral page. |
| `/callback` | GET | OAuth redirect target. Exchanges the code, captures the client IP and fingerprint, writes the record, shows a result page. |
| `/revoke` | GET | lets a verified user revoke their token and optionally delete their record. Required for a defensible consent model, and it is what `/verify refresh` reports against. |
| `/health` | GET | JSON: version, uptime, DB reachable, gateway state, job queue depth. Also the `?probe=1` mode used by the wizard's tunnel check. |
| `/legal` | GET | the disclosure page: what is captured, why, retention, how to revoke. Rendered from the same text the wizard's privacy step writes. |

Everything else 404s with a plain page. No directory listing, no error page that leaks a path.

### 13.2 The panel

The bot posts the panel into the chosen channel from `10.3`. Default when the owner picks "link button": a Link-style button whose URL is `{PUBLIC_BASE_URL}/?guild={guild_id}`. A Link button needs no interaction handler, works for users who have never interacted with the bot, and survives a bot restart. The alternative (an interactive button that replies with an ephemeral OAuth URL) is offered because it lets the bot pre-check whether the user already has a record, and it is the better experience for the "you are already verified, want to re-verify" case. Both are supported; the panel stores which.

### 13.3 OAuth flow

Standard authorization code, no PKCE (public client is the browser, confidential client is the bot server, and the code exchange happens server-side where the secret lives).

1. User clicks the button, lands on `/?guild=<id>`.
2. Page generates a `state` (random 32 bytes, base64url) and stores it with `guild_id`, a timestamp, and the client IP in an in-memory map with a 15-minute TTL (or a `oauth_states` table if the operator runs multiple web workers).
3. Redirect to `https://discord.com/oauth2/authorize?client_id=...&redirect_uri={PUBLIC_BASE_URL}/callback&response_type=code&scope={scopes}&state={state}&prompt=consent`.
4. `/callback` validates `state` (exists, not expired, not used, guild matches), then `POST https://discord.com/api/v10/oauth2/token` with `grant_type=authorization_code`, the code, the redirect URI **byte-identical to the one registered**, and the client secret.
5. Read the access token, refresh token, and `expires_in`. `[v]` `expires_in` is 604800 seconds for the default scopes.
6. `GET /users/@me` with the token for identity. `GET /oauth2/@me` for the granted scopes and expiry, which is authoritative and catches a scope downgrade from a cached consent screen.
7. If `email` was granted, `email` and `verified` are on the `/users/@me` response.
8. If `connections` was granted, `GET /users/@me/connections`.
9. If `guilds` was granted, `GET /users/@me/guilds`.
10. `relationships.read` `[v]`: Discord documents this scope as "part of our Social SDK — submit for access", not a plain OAuth scope, and exposes no public REST route for reading the list. So there is nothing to call with a normal OAuth token. The capture path stays disabled with a "requires Social SDK access" state, the scope is requested and acknowledged in the consent text, and `relationships_json` stays nullable (`23`).
11. Capture IP and fingerprint (`14`).
12. Upsert the record. Write a `verify_record_events` row with `kind: oauth`.
13. Show the result page: success, the guild name, what was captured, the revocation link, and the disclosure link.
14. Fire the log-channel entry.

Any step failing gives the user a specific, non-technical message ("we could not complete verification, the link may have expired, try clicking Verify again") and logs a `DiscordApiError` with the parsed body for the operator.

### 13.4 Token storage

Access and refresh tokens are stored **encrypted** with AES-256-GCM using `ENCRYPTION_KEY`, with the IV stored alongside. `IP_STORAGE=plaintext` is a separate choice from token encryption; tokens are never stored in the clear, because a leaked refresh token is persistent account access and that is categorically worse than a leaked IP.

`token_status` tracks: `valid`, `unauthorized` (Discord returned `invalid_grant` on refresh), `revoked` (user hit `/revoke` or the record's token was cleared by an admin), `missing`.

### 13.5 Refresh

`/verify refresh` runs as a job because it is one API call per record and there could be thousands.

Per record:

- If `token_expires_at` is in the future: `GET /users/@me`. Cheap liveness check.
- If expired and a refresh token exists: `POST /oauth2/token` with `grant_type=refresh_token`. On success, rotate **and store the new refresh token** (Discord rotates them; the reference project refreshes but the storage of the rotated token is exactly the kind of thing that gets missed `[r]`). Update `oauth_last_checked_at`.
- On `invalid_grant`, `invalid_client`, or `400`: set `token_status = 'unauthorized'`, clear the encrypted tokens, **keep every captured field**. This is the user's explicit requirement: IP, email, and the rest survive until a human deletes the record.
- On `429`: the limiter handles it.
- On a network error: leave the status alone, count as "unchecked", retry next run. Do not mark someone revoked because the network blipped.

Live editing: the refresh page is a single message the bot edits every few records with a running count (`checked 340/1200, 12 revoked, 3 errors`) and a per-user line appended as each revocation is found. Discord's edit rate limits apply to that message (the limiter treats message edits as their own bucket), so the edits are coalesced to at most one per 2 seconds and the per-user lines are batched. A naive per-record edit on a 5000-record refresh gets the bot 429'd into a multi-minute stall, which is what `[r]`-style code does.

Result: a summary page with the counts, a list of the revoked users with their ids and last-seen timestamps, and a button that reposts the full unchanged record set for export.

### 13.6 Records UI

`/verify records` is a paginated browser. 10 per page, one Section per record with the user's avatar as the Section accessory and a Text Display per field group. Buttons: previous, next, filter (a select for all / revoked / active / vpn / no-email), sort, export.

`/verify user` shows one record in full, grouped:

- **Identity**: id, username, global name, discriminator, avatar, email plus verified flag, locale, MFA, premium type, account age, account flags.
- **OAuth**: scopes granted, granted at, last checked, token status, and (behind a reveal button) the token's expiry but never the token itself.
- **Network**: first IP hash with a copy button, last IP hash, IP history count, country, city, region, ISP, ASN and org, IP type, VPN, proxy, Tor.
- **Presence in guilds**: the `guilds` scope list, filterable to "servers where this user is not in yours".
- **Connections**: linked accounts, with the type and the verified flag.
- **Relationships**: only shown if the scope was granted and acknowledged, and the page carries the Social SDK notice.
- **Fingerprint**: OS, browser, version, locale, timezone, screen, referrer, user agent, and the audio-device count.
- **Events**: the `verify_record_events` timeline.

Every field that is empty says "not captured" rather than being absent, because "not captured" and "captured as empty" are different facts and operators need to tell them apart.

---

## 14. IP capture, fingerprinting, and IP intelligence

### 14.1 Client IP

`web/capture/ip.ts` resolves one IP with a documented, testable precedence. The reference `[r]` takes `cf-connecting-ip` first, then `x-forwarded-for` whole, then `x-real-ip`, then the socket, and strips `::ffff:`. Taking the whole `x-forwarded-for` header is a spoofing hole, so this version is stricter:

```
1. if BEHIND_CLOUDFLARE_TUNNEL:      use cf-connecting-ip (validated)
   else if TRUSTED_PROXY_DEPTH > 0:  walk x-forwarded-for right to left,
                                     skip TRUSTED_PROXY_DEPTH entries,
                                     take the next valid IP
   else:                             use the socket address
2. validate the candidate: parseable IPv4 or IPv6 (never a bare string),
   not a private range, not loopback, not link-local
3. normalise: strip ::ffff:, expand IPv6 to a canonical form,
   lowercase, drop any zone id
4. if every source is a private or loopback address, store it anyway but
   set ip_public = false and flag the record, because this is the exact
   failure mode of a misconfigured tunnel and it must be visible
```

Evidence: `[v]` Cloudflare sets `CF-Connecting-IP` and `X-Forwarded-For`; the tunnel terminates on loopback, so a missing or mis-set flag makes every record show `::1`.

### 14.2 Fingerprint

The reference `[r]` posts a base64 JSON `x-track` header with `os`, `browser`, `system_locale`, `browser_user_agent`, `browser_version`, `referrer`, `referring_domain`, `device_aspect_ratio`, `screen`, `hardwareConcurrency`. Snapback keeps that shape and extends it, all client-side, no canvas or WebGL hashing:

| Field | Source | Note |
|---|---|---|
| `os`, `browser`, `browser_version` | UA parse server-side (`14.3`) | parsed values are what get stored; the raw UA is kept too |
| `user_agent` | `navigator.userAgent` | |
| `languages` | `navigator.languages` | full array, not just the first |
| `system_locale` | `navigator.language` | |
| `timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | |
| `timezone_offset_min` | `new Date().getTimezoneOffset()` | |
| `screen` | `screen.width/height/availWidth/availHeight` | |
| `device_pixel_ratio` | `devicePixelRatio` | |
| `device_aspect_ratio` | derived | |
| `color_depth` | `screen.colorDepth` | |
| `hardware_concurrency` | `navigator.hardwareConcurrency` | |
| `device_memory_gb` | `navigator.deviceMemory` | Chromium only, often absent |
| `max_touch_points` | `navigator.maxTouchPoints` | mobile vs desktop signal |
| `platform` | `navigator.platform` | |
| `audio_devices` | `enumerateDevices()` filtered to `audioinput`/`audiooutput`, **counts and labels only where the browser already permits it** | without permission the labels are empty strings and the count is still meaningful |
| `referrer`, `referring_domain` | `document.referrer` | |
| `captured_at` | client clock | stored alongside the server clock so a skew is visible |

Nothing here is a canvas, WebGL, or font probe. Those are what a fingerprinting library does, they are the part that makes a collection legally and ethically indefensible, and they add nothing the bot needs. `[+]` the user asked for "fingerprinting items"; this is the defensible subset and the doc says why the rest is excluded.

The payload travels as a base64 JSON header on the `/callback` request, so it is captured even if the page's JS fails before an XHR would have fired. The callback also accepts it as a query parameter for the no-JS path, with a length cap.

### 14.3 UA parsing

A small table-driven parser in `web/capture/fingerprint.ts`. No dependency: the general-purpose UA libraries are large, unmaintained, and their databases go stale, while the realistic browser set on the web in 2026 is small. The reference `[r]` has `getPlatform`/`getBrowserName` doing string matching on `navigator.platform`, which is deprecated and reports `"Linux x86_64"` on Android. We parse the UA string instead and fall back to client hints when they are present.

### 14.4 IP intelligence

Two local data files, no API keys, no per-request cost, no third party seeing the operator's user IPs.

| Purpose | Source | Format | Refresh |
|---|---|---|---|
| Country, city, region, ASN | db-ip lite (Country and City/ASN editions) | MMDB | monthly; the file name carries `YYYY-MM` `[v]` |
| ASN to org name, ASN type (hosting, ISP, business, education, government) | ipverse `as-metadata` | CSV/JSON, CC0-1.0 `[v]` | weekly |

Reading MMDB needs a reader. Use `maxmind` (the `node-maxmind` package): pure JS, MIT, sync and async readers, handles both the country and city editions. `mmdb-lib` is the lower-level alternative but its API is thinner. The reader licence is MIT; the *data* is the licensed part, and db-ip lite is CC-BY, so the attribution goes in `docs/self-hosting.md` and on `/legal`, with the copyright line reproduced verbatim on the page. The reader is lazy-loaded on first verify so a deploy without the `.mmdb` files still boots.

`services/intel/classify.ts` produces a verdict from those two sources:

```
ip_type: residential | hosting | mobile | business | education | government | unknown
is_vpn:  heuristic
is_proxy: heuristic
is_tor:   from the ASN name or a bundled exit-node list
```

**Be honest about what this can and cannot do.** ASN type alone cannot reliably distinguish a commercial VPN from a hosting provider, because most commercial VPNs are hosting providers. The reference `[r]` leans on `proxycheck.io`, which is an external service that sees the operator's data and needs a key. Snapback's default is the local pair, labelled as a *classification*, with the UI wording "likely VPN or hosting provider" rather than "VPN: true". An optional `PROXYCHECK_API_KEY` in `.env` enables the third-party path for operators who want it, and the doc states the privacy tradeoff of turning it on.

The record page shows the verdict with the evidence: the ASN, the ASN org, and the type field, so an operator can judge rather than trust a boolean.

### 14.5 IP storage modes

| Mode | Stored | Reversible | Use when |
|---|---|---|---|
| `hash` (default) | SHA-512 of `pepper + ip`, plus a truncated prefix for grouping | no | default. `[r]` VaultCord uses SHA-512 for exactly this reason |
| `encrypted` | AES-256-GCM ciphertext, plus the hash | yes, with the key | operators who need to see the address |
| `plaintext` | the address | yes | local testing only, warns at boot |

Blocks that need several IPs for one record store an `ip_history_json` array of `{hash, at, event}` so a user who verifies twice from different addresses is visible as two entries without storing either address twice.

Uniqueness and lookup are done on the hash in every mode, so the record UI works identically. The copy button copies the hash, and says it is a hash.

### 14.6 Header hygiene

- Request bodies capped at 64 KiB for the callback (the fingerprint is a header, so this is generous).
- All headers that arrive are *not* stored. Only the ones the capture layer names.
- `X-Forwarded-For` chains are logged in raw form at debug level only, and redacted in production logs, because a forwarded chain is other people's IPs.

---

## 15. Pull engine

Adding verified users to a guild with `guilds.join`.

### 15.1 The add

`PUT /guilds/{guild_id}/members/{user_id}` with body `{access_token, roles?, nick?, mute?, deaf?}`. `[v]` this is the `guilds.join` path and it requires the target user's granted token. The reference does the same `[r]`.

`roles` is limited to roles the bot itself can assign (below the bot's highest role). The pull engine computes the assignable subset per guild and reports roles it had to drop, rather than sending an array Discord rejects whole with `50013`.

### 15.2 Pull counter

The user's requirement, and it is a genuinely good idea: Discord throttles account creation and join patterns, and a burst of joins from one authorized account is the pattern that gets an account flagged.

`account_counters` is keyed `(user_id, guild_id, day)` where `day` is a UTC date string.

Rules, all configurable from `/pull config`:

- `PULL_DAILY_LIMIT_PER_ACCOUNT` default 100, sane range 100-500, hard ceiling 500. Above 500 the UI says the account risks a flag and requires a second confirmation.
- On reaching the limit: `restricted = true`, `restricted_reason = 'daily_limit'`, `cooldown_until = now + PULL_COOLDOWN_HOURS` (default 24).
- While restricted, the pull engine **skips that account entirely** before making any request. It does not attempt-and-handle-error; it does not attempt. This is what the user asked for ("stop attempts for that account immediately").
- Failures also count. Three consecutive `403`/`429` results on one account trip a shorter cooldown, `PULL_FAILURE_COOLDOWN_MINUTES` default 60, even under the daily cap, because failure bursts are the actual signal and a slow daily limit reacts too late. The counter is per account and per process; it resets on any `201`.
- A successful `201` clears the consecutive-failure counter.
- Counters reset by UTC day, swept by the scheduler at 00:05 UTC and lazily on read, so a missing sweep cannot hand someone a fresh budget.

`/pull counters` is a page per account: today's attempts, today's successes and failures, current state, and when the cooldown lifts, as a relative Discord timestamp.

`/pull reset` clears one by hand, with a confirmation page, and writes an `audit_log` entry. Used when an operator knows an account is fine.

### 15.3 Error handling in the pull

`[v]` Documented outcomes and their parsed codes, no guessing:

| Situation | Discord response | Action |
|---|---|---|
| Added | `201` | increment success, clear failure streak |
| Already a member | `204` | count as `already_member`, not a failure, no counter penalty |
| User's token is stale | `401` with `{"code": 0, "message": "401: Unauthorized"}` | mark the record `unauthorized`, drop the tokens, keep the record, skip the account for the rest of the job |
| Bot lacks `CREATE_INSTANT_INVITE` or role authority | `403`, `50013` | abort the whole pull with a permissions report, because retrying cannot help |
| User is banned in the target | `400`, `40007` | count as `blacklisted`, do not retry, do not treat as an account failure |
| Guild member limit reached | `403`, `30001` | abort the pull, report that the target is full. Do not burn account reputations into a full guild |
| User left your guild and revoked | `401` | as above |
| `429` | with `retry_after` | limiter backs off; a sustained `429` on one account triggers the shorter cooldown |

The rule from the user, made concrete: **`discord/errors.ts` never produces a message it made up.** Every error surfaced carries the HTTP status and, when the body parsed as JSON, Discord's own `code` and `message`, verbatim. A known code gets a human sentence and a suggested fix appended; an unknown code is shown exactly as Discord sent it with the raw body attached, and logged with the route and method so it can be looked up. A non-JSON body (HTML from Cloudflare, an empty body, a gateway hiccup page) is stored as text and labelled "non-JSON response", which is itself a signal that the request never reached Discord.

### 15.4 Ordering and pacing

Accounts are shuffled before a run (`[r]` the reference has a `shuffle` helper for this) so the same accounts are not always the ones that hit the cap first. Within a run, one attempt at a time, with the limiter's spacing. A run is pausable and resumable, and its progress is a checkpointed job.

### 15.5 What the pull deliberately will not do

- No joining with a user token. Ever. The whole point of `guilds.join` is that the user consented and Discord knows it.
- No retry storm on a `401`. One unauthorized result means the token is gone; retrying it is how accounts get flagged.
- No bypassing the counter, including for admins, except through `/pull reset`, which is audited.

---

## 16. Logging

Three destinations, one event model.

**Destination 1: the log channel.** Events are posted as Components V2 containers, one per event, with the accent colour encoding severity (`9.4`). Event families, each toggleable in `/setup logs`:

| Family | Events |
|---|---|
| `lifecycle` | bot started, bot stopped, gateway reconnecting, gateway resumed, shard ready |
| `backup` | started, finished with counts, failed with the parsed error, pruned |
| `restore` | started, finished with the per-category report, failed, cancelled, cleared a guild |
| `verify` | verification completed (with the captured field set, not the values), revoked, refreshed, panel created, panel edited |
| `pull` | run started, run finished, account restricted, account released, guild full |
| `admin` | admin added, admin removed, permission changed, destructive action confirmed |
| `error` | anything unhandled |

The log entry for a verification carries the user id, the guild, the scopes, and the country, but not the email or the IP. The log channel is typically more readable by more people than the records browser, and duplicating the sensitive fields into it is a mistake the reference makes `[r]`.

**Destination 2: structured stdout.** JSON lines, one per event, with a severity and a request id. Redaction runs before the write. Suitable for `docker logs` and for anything that ships them.

**Destination 3: `audit_log`.** Every mutating action by a human, in the DB, with actor, action, target, and a small detail object. This is the record that answers "who deleted this record" six months later. Log channels scroll away; the DB does not.

Log-channel failure must never break the action that triggered it. A missing channel, lost permissions, or a `403` logs once at warning level and disables that family until `/setup logs` re-tests it, with a single notice to the owner. A backup that fails because it could not post a log line is an absurd failure mode.

---

## 17. Automation, retention, and export

### 17.1 Scheduler

One ticker, `services/scheduler/index.ts`, every 15 seconds. It reads due work from the DB, not from in-memory timers, so a restart does not lose a schedule and a long job does not drift.

Jobs it owns:

- due auto-backups (`auto_backup_interval_hours` per guild, last-run timestamp in `jobs`)
- due auto-restores (`auto_restore_enabled`, target guild, backup source: latest or a fixed one)
- token refresh sweep (`verify_refresh` when the oldest `oauth_last_checked_at` is older than a configured age, default 24h)
- retention sweep (hourly; `17.2`)
- counter reset (00:05 UTC daily)
- orphan webhook sweep (startup and every 6 hours: list the bot's webhooks in tracked guilds, delete any whose channel is not in a running restore job)
- pending-export expiry sweep
- interaction-state TTL sweep

Each job is a row, each run is idempotent, and each is disabled globally by `AUTOMATION_ENABLED=false` for anyone who wants a pure manual deployment.

### 17.2 Retention

`retention_policies` per guild: `keep_days`, `keep_count`, and which `kind`s are eligible (`manual`, `auto`, `pre_restore`).

Pruning is deterministic and explainable:

1. Never delete the newest backup, whatever the policy says. A guild whose retention would leave zero backups keeps one. Silent total data loss from a misconfigured number is the failure this prevents.
2. Never delete a backup referenced by a queued or running job.
3. Delete `pre_restore` backups first, then `auto`, then `manual`, oldest first.
4. `keep_days` removes anything older; `keep_count` removes anything past the newest N. Both apply; the union of what survives is the result.
5. Delete rows and asset files together. Asset files with no row are swept as orphans.

`/backup prune` runs it with `dry_run: true` by default and reports a table of what would go with reasons.

### 17.3 Export

`/backup export` and `/users export` both write a file and return it as a Discord File component, if the size permits, or a path plus a note if it does not. The ceiling is not a constant: read `attachment_size_limit` off the interaction object, which Discord documents as "the maximum" of the uploader's Nitro limit and the guild's boost tier. The documented default is 20 MiB per file (`[v]`, raised from 10 MiB in September 2026); the 25 MiB figure elsewhere in Discord's docs is the per-message request size, a different limit. Anything larger means the operator pulls the file from disk and the message says exactly where it is.

Trusting a hardcoded constant here would be wrong twice over: it drifts when Discord raises the floor, and it is per-user, so a Nitro subscriber and a free user in the same guild have different real limits in the same request.

Formats:

- **Backup JSON**: the whole backup, optionally with messages, optionally pretty-printed. This is the portability story: a backup JSON plus the asset directory is a complete, engine-independent record, and `docs/` documents the schema so another tool can consume it.
- **Records JSON**: every field of every record, with tokens excluded entirely and IPs in whatever the configured storage mode produces, plus a header naming the mode so a reader can tell a hash from an address.
- **Records CSV**: the flat subset, for a spreadsheet. Multi-valued fields are semicolon-joined and the header documents it.
- **Full dump**: every backup row, every record, every job, as a zip. This is `/setup data`'s "export everything" and it is the migration path.

`services/export/json.ts` serialises bigints as strings, dates as ISO 8601 UTC, and JSON blobs as parsed objects, so the output is readable rather than a wall of escaped strings. The reference stores them as stringified blobs and exports them as such `[r]`.

### 17.4 Export expiry

Exported files are written under `data/exports/` with a timestamp and an `expires_at` (default 24h). The sweep deletes expired ones. Prevents the disk filling with four copies of a 300 MB dump because someone pressed export four times.

---

## 18. Errors

### 18.1 The rule

**Nothing guesses.** An error surfaced to a user is one of exactly three shapes:

1. **A Discord error with a parsed JSON body.** Shown as `status`, `code`, and Discord's own `message` verbatim, plus, if the code is in the known table, one plain sentence explaining it and one sentence naming the fix.
2. **A Discord error with a non-JSON body.** Shown as `status` plus the first 500 characters of the body, labelled "non-JSON response", which points at Cloudflare or an intermediary rather than at Discord.
3. **One of ours.** A typed internal error with a fixed code (`SB_*`), a fixed message, and a log line with the stack. These are the only errors with human-written wording, and they are all `SB_`-prefixed so they are greppable.

`discord/errors.ts` exports `DiscordApiError` with `{ status, code, message, errors, retryAfter, route, method, body }`. `errors` is Discord's field-level validation object from `50035`, preserved as-is, because "INVALID_FORM_BODY: roles.0: role is above the bot's highest role" only exists in that object and is exactly the information an operator needs.

### 18.2 Known code table

A static map, extending as real errors are seen, never inventing:

| Code | Meaning | Surfaced fix |
|---|---|---|
| `0` generic | the message usually carries the real reason | show it verbatim |
| `10003` | unknown channel | the channel was deleted since the backup |
| `10004` | unknown guild | the bot is no longer in that guild |
| `10007` | unknown member | the member left |
| `10011` | unknown role | the role was deleted since the backup |
| `10013` | unknown user | the user does not exist |
| `10014` | unknown emoji | |
| `10026` | unknown ban | |
| `10062` | unknown interaction | the interaction expired; the handler responds with a fresh message |
| `20012` | you are being rate limited (bot-wide) | |
| `30001` | maximum number of guilds reached | the *account* being pulled is in too many guilds; not a bot problem |
| `30002` | maximum number of friends reached | appears on friend-related OAuth calls |
| `30003` | maximum number of pins reached | |
| `30005` | maximum number of guild roles reached | surfaced with the count Discord reported |
| `30007` | maximum number of webhooks reached | |
| `30010` | maximum number of reactions reached | |
| `30013` | maximum number of guild channels reached | |
| `40007` | invalid user for this guild (banned) | |
| `50001` | missing access | the concrete permission to grant |
| `50013` | missing permissions | the concrete permission to grant |
| `50035` | invalid form body | the `errors` object, field by field |
| `invalid_grant` | OAuth token expired or revoked | mark the record `unauthorized`, keep the data |

The entries for `30005`, `30013`, `30007`, `30010` are the ones that finally answer the role and channel cap question from real data instead of folklore (`11.1`). When one fires, the bot records the count it sent, and `/snapback diagnostics` reports the highest observed value.

### 18.3 Interaction error contract

Every handler is wrapped:

- Expecting an ack but the interaction is already acknowledged or expired (`10062`): drop silently, log at debug. This is normal noise, not an error.
- Handler throws before the first ack: reply ephemerally with the error, and if the action was destructive, state clearly whether it ran. "The action did not run" versus "the action may have partially run, check the log" are different messages and the handler knows which one applies.
- Handler throws after the ack: edit the existing message into the error page, do not leave a spinner.
- A modal submitted with invalid data: the modal is re-opened with the error text on the offending Label's description. Discord has no inline form-error API beyond that.

### 18.4 The unhandled paths

- `process.on('unhandledRejection')`: log, post to the log channel's `error` family, do not exit. Oceanic surfaces most Discord errors as rejections and exiting on them would make the bot a crash loop.
- `process.on('uncaughtException')`: log, post, and exit deliberately after flush. A process in an unknown state after an uncaught exception should not keep serving.
- Gateway `error` and `warn`: logged with the close code and reason, with a code table for gateway close codes (`4004` bad token, `4010` invalid shard, `4011` sharding required, `4013` invalid intents, `4014` disallowed intents). `4013`/`4014` get a link to the intents checklist in the log line itself, because they are always a Developer Panel problem.
- Disk full, DB locked, DB file missing, exports directory unwritable, port already in use: preflight at boot, each with its own exact message.

---

## 19. Security and privacy

### 19.1 Threat model

Who might attack this, and what stops them:

| Adversary | Goal | Mitigation |
|---|---|---|
| A stranger on the internet | hit `/callback` with a fake `code` to write junk records | `state` validation, code exchange server-side, one-time state, TTL |
| A stranger | spoof a client IP via `X-Forwarded-For` | right-to-left walk with a configured depth, per-candidate validation, socket fallback (`14.1`) |
| A guild admin with reduced flags | read records they are not permitted to | every read handler re-checks `can_view_records` against the DB, not the cached interaction |
| A demoted admin with a stale button | drive a wizard they no longer run | authorisation and ownership re-checked on every interaction (`9.3`) |
| Anyone with filesystem access | read tokens | AES-256-GCM with a key from the env, never in the DB or a backup |
| Anyone with a backup export | read tokens | exports never contain tokens, by construction in the serialiser, not by a filter someone might forget |
| A leaked log channel | read emails and IPs | logs exclude those fields by design (`16`) |
| The operator's own DB backup | read tokens | tokens are encrypted with a key held outside the DB; restoring the DB alone does not expose them |
| Someone who guesses the export path | download exports | exports are named with a random component and served only through an authenticated route, or not served at all and read from disk |

### 19.2 Data minimisation

- Nothing is captured that a scope did not grant and an owner did not select.
- `email` is off unless the owner selects it.
- `relationships.read` is off unless the owner acknowledges the Social SDK terms (`7.2`).
- Fingerprint fields are a fixed, documented list (`14.2`), not an extensible grab bag, and the list is shown to the user on the verify page before they consent.
- Revocation is real: `/revoke` clears the tokens, records the event, and offers full deletion.
- Retention applies to records too, not only backups. A guild that sets `keep_days: 90` has records older than 90 days deleted by the same sweep, with the count reported.

### 19.3 Disclosure

The verify page, before the OAuth button, shows a plain list:

> This server uses Snapback to verify you. When you continue it will ask Discord for your username, avatar, email address, the servers you are in, and your linked accounts. This server will also record the IP address your browser connects from, your browser and operating system, and your timezone, and use them to check for VPNs and alternate accounts. It will keep this until you revoke access at /revoke, or until the server's retention period ends. Pressing Continue asks Discord for permission; nothing is captured before you approve.

Exact scopes are listed from the panel's configuration, so the text cannot drift from what is actually requested. That is the whole point: the disclosure is generated from `verify_panels.scopes_json`, not typed by hand into a template.

### 19.4 What we do not build

Stated because the reference material contains all of it `[r]` and it will come up:

- No proxy rotation or ban evasion. No `zproxy.lum-superproxy.io`, no `CF_API_TOKEN`-driven zone juggling. The reference project's setup doc wires a residential proxy in front of every Discord API call; that is an evasion infrastructure and this project does not include it.
- No selfbot behaviour, no user-token message sending, no token harvesting.
- No CAPTCHA-solving service integration. hCaptcha is in the reference's env; here, verification is the OAuth flow and nothing else.
- No public geo-lookup endpoint. The earlier draft exposed `POST /api/geo` so the site could ask the server what an arbitrary IP resolves to; that is an unauthenticated query surface against the intel data and it is not built. Geolocation is computed internally, at verify time, from the stored IP, and never on request.
- No payment, subscription, or gift-code surface. Five of the reference's tables exist to run a paid SaaS; this is a self-hosted tool.
- No "block alts" enforcement that acts on a hash match alone. An IP hash match is a signal shown to an operator, never an automatic ban, because shared NAT, student halls, and mobile carriers all produce false matches.

---

## 20. Testing

| Layer | What | How |
|---|---|---|
| Unit | snowflake handling, permission bitfields, IP precedence and validation, UA parsing, retention selection, counter transitions, error parsing | plain `bun test` / `node --test`, no Discord |
| Fixtures | a synthetic guild: 4 categories, 20 channels of every relevant type, 60 roles including managed and `@everyone`, 300 members with role combinations, 2000 messages with attachments, embeds, replies, reactions, emojis, stickers, automod rules, onboarding, bans | a generator script committed to the repo, so the shape is reviewable |
| Golden files | the backup of the fixture guild, committed as JSON | any change to the backup shape shows up as a diff. This is the only cheap way to catch a schema regression |
| Contract | every endpoint the bot calls, mocked, asserting the exact request shape | catches camelCase/snake_case and bigint bugs before they reach Discord |
| Integration | restore the fixture backup into a real test guild, then diff the target against the fixture | runs manually against a `DISCORD_DEV_GUILD_ID`, never in CI, because it needs a real token |
| Round-trip | backup, restore into an empty guild, backup again, diff the two backups | the strongest single test in the suite. Differences must be explainable by the known-lossy list (`11.1`, `12.6`) and anything else is a bug |
| Failure injection | the mock returns `429`, `500`, `50035`, HTML, an empty body, and a mid-stream disconnect at every step | every one of those paths has to produce a typed error and a sensible user message |
| Load | a 10k-message backup and restore against a mock, measuring memory and asserting the checkpoints work | proves the batching and the resume |
| Web | `state` replay, expired `state`, bad `code`, spoofed `X-Forwarded-For`, no-JS callback, oversized fingerprint | |

CI runs everything except the integration and load suites. Round-trip and load run nightly or on demand.

---

## 21. Milestones

Each milestone ends with something runnable and a verify check.

| # | Milestone | Contents | Verify |
|---|---|---|---|
| 0 | Spike | Bun + DuckDB + Oceanic connect to a test guild; a slash command that posts a Components V2 container | a message with a container renders and a row of buttons responds |
| 1 | Skeleton | repo layout, `env.ts`, DB abstraction with both drivers, migrations, `client.ts`, command registry, error types, limiter, log channel | `/snapback status` and `/snapback diagnostics` work; a `50035` is parsed and printed field by field |
| 2 | UI | component factories, `page()`, interaction router with customID namespacing, state store, 40-component assertion | a paginated list with working buttons that survives a restart |
| 3 | Backup | steps 1-13 of `11` (everything except messages), self-check, `/backup info` | the fixture guild backs up, the JSON matches the golden file, self-check passes |
| 4 | Messages | message capture with pagination, filtering, attachment download, both ceilings | a 1000-message channel backs up in under a minute and the counts match |
| 5 | Restore | plan/dry-run, roles, channels, overwrites, members, bans, assets, per-step reports | the round-trip test passes with only the known-lossy differences |
| 6 | Message restore | webhook replay, checkpoints, resume, orphan sweep, report | 1000 messages land in the right order and a kill mid-job resumes without a full duplicate |
| 7 | Web + OAuth | server, routes, `/callback`, IP capture, fingerprint, token encryption, disclosure page, `/revoke` | a real account verifies, the record shows the right fields, `/revoke` clears the tokens and keeps the record |
| 8 | Records UI | browser, detail page, `/verify refresh` with live edit and coalescing, `/verify delete`, export | refresh over 200 records reports the revoked ones and edits the message without tripping a 429 |
| 9 | Intel + pull | db-ip and as-metadata loading, classification, `/pull` with counters and cooldowns | a pull of 20 accounts respects the daily cap and trips a cooldown at the boundary |
| 10 | Automation | scheduler, auto-backup, auto-restore, retention, exports, full dump | an auto-backup fires on schedule; pruning never deletes the last backup |
| 11 | Polish | wizard audit, all error paths, docs, `AGENTS.md`, README, licence, screenshots | a fresh operator goes from zero to a verified user following only `docs/setup.md` |

---

## 22. Documentation

`docs/`, and every page is also reachable in Discord (`/setup guide`, `/snapback help`) rendered from the same source, so it cannot drift.

| Page | Contents |
|---|---|
| `setup.md` | zero to running, in order, with what to expect at each step |
| `developer-panel.md` | every Developer Panel toggle, where it is, what breaks without it |
| `cloudflare-tunnel.md` | the tunnel guide, the checkbox, the loopback failure and how to spot it |
| `scopes.md` | every scope, what it returns, the restricted ones, the Social SDK obligation |
| `commands.md` | every command, every option, every default |
| `backup-format.md` | the backup JSON schema, for anyone writing a consumer |
| `self-hosting.md` | Postgres, reverse proxies, backups of the DB itself, the DuckDB single-writer rule, db-ip attribution |
| `privacy.md` | what is captured, retention, revocation, the operator's obligations |
| `troubleshooting.md` | indexed by symptom and by Discord error code, because that is how people search |
| `architecture.md` | the `4` diagram, the job model, why jobs are in the DB |
| `contributing.md` | the rules from `AGENTS.md`, plus the test workflow |

---

## 23. Risks and open questions

Ordered by how likely they are to change the plan.

1. **Bun + DuckDB.** Resolved at milestone 0. `@duckdb/node-api` 1.5.6-r.1 under Bun 1.3.14 opens a file database, accepts several DDL statements in one call, and returns JS `bigint` for `BIGINT` exactly as the boundary assumes. `INSERT OR IGNORE` and `CAST(? AS JSON)` both work, so the schema needs no dialect escape hatch. Measured: 1000 prepared inserts in one transaction is 350 ms, the same 1000 as one multi-row statement is 15.6 ms, so bulk inserts are roughly 22x faster and the capture path should batch. Evidence kept in `scripts/spike/duckdb.ts`. `Bun.sql` is present, so the Postgres path needs no extra dependency. Fallback order if this ever regresses: `bun:sqlite` behind the same interface (one file, keeps the single runtime), then Node only as a last resort.
2. **`relationships.read` is Social-SDK-gated.** Answered against the docs. The scope reads "This scope is part of our Social SDK — submit for access", and there is no public REST endpoint for the friends/pending/blocked list. Not a milestone blocker, but the feature is not shippable without Discord granting Social SDK access. Decision: keep `relationships_json`, keep the UI, ship the capture path disabled with a "requires Social SDK access" state and a link to the application form. Do not present it as working.
3. **Role icons.** Answered. `icon` (image data) and `unicode_emoji` on the role object, both gated on the guild's `ROLE_ICONS` feature, both set in the same create/modify role body. Capture as nullable; skip on restore when the target guild lacks the feature and report it.
4. **Message-count math.** A 5000-message restore is roughly 5000 webhook posts plus limiter spacing. The honest duration estimate needs measuring at milestone 6, and the UI should show the measured number, not a guess.
5. **Attachment preservation.** Most historical attachments will be unrecoverable (expired signed URLs). Milestone 4 should measure what fraction of a realistic channel is recoverable so the UI text is accurate.
6. **DuckDB write contention** when someone runs the bot and the web site as separate processes. Mitigated by the lock message, but the doc has to be loud about it.
7. **Restore into a guild with different boosts.** Bitrate and upload limits differ, and the upload limit is also per user, not just per guild: `attachment_size_limit` on the interaction is the maximum of the uploader's Nitro limit and the guild's boost tier. Read it at runtime and clamp, never hardcode (`17.3`). Worth a line in the report.
8. **Guild size.** Everything so far is designed for tens of thousands of members and ten thousand messages. A 500k-member guild is a different engineering problem (pagination memory, job duration measured in hours, the webhook post budget). v1 states a supported ceiling in the docs rather than pretending there is none.
9. **Rate limit behaviour on very large restores.** The limiter is correct but untested at 10k sequential posts. Milestone 6 measures it.

---

## Appendix: what came from where

Reference material read for this plan lives in `references/`. What is taken, and what is deliberately not.

| Reference | Taken | Not taken |
|---|---|---|
| `restorecord-new` (2024, Next.js + Prisma) | the operational data model: per-guild verified member records, migration/pull tracking with per-outcome counts, custom bots, the `getIPAddress` precedence, the `x-track` fingerprint field list, the webhook-replay restore, name-based role remapping, the token-refresh-then-mark-unauthorized pattern | the residential proxy in front of every API call, CAPTCHA and payment surfaces, the `pCheck` third-party dependency, fixed `setTimeout` pacing, `content`-only message capture, the `discriminator % 5` avatar fallback |
| `discord-backup-androz` | the cleanest backup shape in the set: typed `BackupData` with categories, channels-with-threads, per-role and per-channel permission structures, and the `CreateOptions`/`LoadOptions` split. The `MessageData` shape with `username`/`avatar`/`sentAt` is the model the webhook replay needs | its dependence on `discord.js` types, its lack of asset preservation, no member pull, no verification |
| `RestoreCord-Source-Code` (C# bot + PHP site) | the concept list: pull tracking, VPN checks, alt blocking, referrer tracking, per-server verification configuration | the whole monetisation stack, and the setup doc's own warning that the source is a clone carrying inherited vulnerabilities |
| `freecord`, `Oauth-Bot`, `Discord-Auth-Bot`, `Discord-Backup`, `Discord-Backup-Bot`, `Discord-Backup-Tool-V2`, `vaultcord-site` | confirmation of the shape of the problem and the common failure points | anything involving user tokens, selfbot behaviour, or proxy-based evasion |

None of the reference code is copied. The plan reimplements the ideas against Oceanic's API with the failures fixed, and the `[r]`/`[v]` markers say which claims came from reading code and which from documentation.








