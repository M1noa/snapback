# S5PLAN.md — Snapback

Discord server backup/restore bot with OAuth member restore, verification site, and a slash-command setup wizard. One owner, many guilds, everything configured from Discord except `BOT_TOKEN` and `OWNER_ID`.

This file is the spec. `AGENTS.md` is the coding contract meant to keep agents consistent while building it.

---

## 1. Decisions

| choice | pick | reason |
|---|---|---|
| runtime | Bun 1.3+ | you asked; `Bun.sql` gives postgres with zero deps |
| language | TypeScript strict | oceanic's types need it |
| discord lib | `oceanic.js` 1.15.0 | you asked; v2 components, modals, file upload all typed |
| db default | DuckDB file, `@duckdb/node-api` 1.5.x | you asked; verified working under bun with JSON columns |
| db alt | Postgres via `Bun.sql` when `DATABASE_URL` is set | you asked; no ORM (drizzle has no duckdb dialect) |
| website | `Bun.serve` in the same process | one deploy, one config |
| geo/asn | db-ip lite + ipverse, local files | offline, no api keys, no outbound calls |
| ui | Components V2 on every message | you asked; v1 embeds banned in new code |
| presence | bot token only | no selfbot code paths anywhere |

Verified on this machine before writing this: bun 1.3.14, duckdb create/insert/json-extract under bun, `Bun.sql` present, oceanic 1.15.0 `ComponentTypes` including `CONTAINER`/`SECTION`/`TEXT_DISPLAY`/`THUMBNAIL`/`MEDIA_GALLERY`/`SEPARATOR`/`FILE`/`LABEL`/`FILE_UPLOAD`/`CHECKBOX_GROUP`/`RADIO_GROUP`, `MessageFlags.IS_COMPONENTS_V2 = 1 << 15`, `createModal` with `ModalData`, `ComponentInteraction.data.values`, `AutocompleteInteraction.result()`.

Known duckdb gotchas: `BIGINT` comes back as JS `BigInt` (convert at the boundary), JSON params need `CAST(? AS JSON)`, prepared `stmt.run(a, b)` positional binding works but `getRowObjects()` returns strings not numbers.

---

## 2. What I read and what each reference taught

### RestoreCord 2024 source (`references/RestoreCord-Source-Code/`) — the main one

C# Discord.Net bot (`bot source/RestoreCord/`) + PHP site (`website source/`) + MySQL. 703 lines of C#, 106k lines of PHP/CSS.

**Port:**
- join call: `PUT https://discord.com/api/guilds/{g}/members/{u}`, `Authorization: Bot <token>`, body `{access_token}` or `{access_token, roles:[roleId]}` (`Utilities.cs:31-82`)
- refresh path: `POST /oauth2/token` with `grant_type=refresh_token`, `scope=identify guilds.join`, then retry the join once (`Pull.cs:101-145`)
- verify page at `/verify/{owner}/{servername}`, oauth callback at `/auth/` exchanging `code` then forwarding to the verify page (`auth/index.php:27-39`)
- `PUT /guilds/{g}/members/{u}` then `PUT /guilds/{g}/members/{u}/roles/{roleId}` to add the role (`verify/index.php`)
- opt-out button: delete from `members`, `DELETE .../roles/{roleId}`, webhook log
- DB tables `members(userid, access_token, refresh_token, server, ip)`, `servers(guildid, roleid, redirecturl, pic, vpncheck, webhook)`, `blacklist(user, ip, server)`, `errors`
- webhook logs on success / vpn fail / opt-out, all keyed per server
- the `REPLACE INTO members` upsert keyed `(userid, server)`

**Do not copy:**
- tokens stored plaintext, no encryption key
- `/auth/index.php` sets `state=guildId` with no nonce, no CSRF protection
- `HTTP_CF_CONNECTING_IP` with no tunnel toggle
- 429 handling is `Thread.Sleep(retryAfter)` inside a recursive call (`Utilities.cs:65-74`) which can deadlock the pull loop on a global limit
- `catch (Exception e) { }` swallowing (`Utilities.cs:98-106`)
- `Task.Delay(60)` fixed per member with no jitter, no per-account daily counter
- guild-level `ActiveDiscordServers` HashSet is static and non-persistent, so a restart mid-pull silently orphans the pull
- `vpncheck` is a 0/1 int with proxycheck.io hardcoded and a broken url (`verify/index.php` has `?key=...?vpn=1` with a literal `?` mid-query)
- `strings.Map` resource file for credentials (`Properties/Resources`) — compiled secrets
- the PHP site is riddled with `mysqli_query` string interpolation (SQL injection)
- `Pull.cs:78-93` — on join failure it refreshes the token, and if the refresh also fails it just `continue`s with no status recorded, so the member disappears from all counts
- `RefreshUserToken` returns `BadRequest` for any non-429 failure, including expired refresh tokens, which then also just `continue`s

### androz `discord-backup` 3.4.0 (`references/discord-backup-androz/`) — the backup schema to extend

1395 lines, discord.js v14, the most complete backup engine of the set. `create.ts`, `load.ts`, `util.ts`, 20 type files.

**Port the data model** (`types/BackupData.ts` and friends), with the additions in §4.

**Port from `util.ts`:**
- `fetchChannelMessages` cursor pagination with `before=lastMessageId`, `limit: min(100, messageCount)` (`util.ts:118-218`)
- `withRetry` with exponential backoff, immediate bail on 50013/50035/50001, `retry_after` honored on 429 (`util.ts:40-76`)
- `MaxBitratePerTier` downgrade on voice channel restore (`util.ts:35-40`, `load.ts` equivalent)
- `loadMessages`: one `MessagesBackup` webhook per channel, `username` + `avatarURL` per message, `allowedMentions: {parse: []}`, re-pin
- emoji tier cap: 50/100/150/250 by `premiumTier` (`load.ts:131-132`)

**The five real bugs in androz that fix the ordering in §6:**
1. `Promise.all([loadRoles, loadChannels])` runs concurrently while `util.ts:225-233` resolves overwrites by `guild.roles.cache.find(r => r.name === perm.roleName)`. Any role not yet created silently drops its overwrites. **Snapback phases strictly, roles fully done before channels.**
2. role `position` is captured but never restored, so hierarchy order is whatever `Promise.all` resolves to. **Snapback restores top-to-bottom and then repositions.**
3. no `messageReference` captured, reply chains come back flat. **Snapback captures the reference and does a second pass.**
4. `sentAt` captured, never used; webhook messages get now() and there is no way to backdate. Say this in the docs.
5. `maxMessagesPerChannel` overshoots by a page (`util.ts:160-166`: the `messages.length >= messageCount` check runs inside `Promise.all` per page, all 100 push before any check lands), and load defaults to 10 with no user control. **Snapback counts as it appends, outside the parallel map.**

Also: overwrites are role-name keyed only (`util.ts:82-99`), member overwrites are dropped entirely. Snapback keeps both, keyed by id with name fallback. And `getRoles` filters `!role.managed`, dropping managed bot roles permanently — Snapback records them as metadata so a restore can at least report them.

### restorecord-new (`references/restorecord-new/`) — Next.js 13 pages + Prisma + MySQL + Redis

60 api routes, 20 dashboard pages, 422-line prisma schema.

**Port:**
- `addMember`: bot token header, user access token in body, roles array, `guildId === roleId` sentinel meaning "no role" (`src/Migrate.ts:20-38`)
- `exchange(code, redirectUri, clientId, clientSecret, scope)` defaulting scope to `identify+guilds.join`, `POST /oauth2/token` as `application/x-www-form-urlencoded` (`src/Migrate.ts:182-200`)
- the `servers` toggle set worth having: `vpncheck`, `blockAlts`, `blockWireless`, `ipLogging`, `captcha`, `minAccountAge`, `authorizeOnly`, `pullTimeout` (cooldown), `pulling` (in-progress lock), `redirectUrl`, `webhook`
- `makeXTrack()` client attributes: os, browser, system_locale, browser_user_agent, browser_version, referrer, referring_domain, device_aspect_ratio, screen, hardwareConcurrency, sent as a base64 `x-track` header (`src/getIPAddress.ts:27-62`)
- snowflake account age check via `snowflakeToDate()` against `servers.minAccountAge`
- `members` capture: ip, isp, state, city, country, vpn flag, referrer, avatar fallback `(discriminator % 5).toString()`

**Do not copy:**
- `state` is the raw guild id, validated only by regex `/^\d{16,19}$/` (`pages/api/callback.ts:34-41`). No nonce, no expiry, single-use, or CSRF.
- `redirect_uri` built from `req.headers.host` (`callback.ts:95`), attacker-controlled unless the ingress rewrites it.
- the whitelist of three hardcoded Discord IDs that turn off IP logging (`callback.ts:11-15, 126-129`). If you need a staff bypass, DB flag + audit row.
- `"unauthorized"` string stuffed into `accessToken` as a status sentinel (`src/Migrate.ts:109-123`), plus a second `"unauth"` sentinel in `admin/reset.ts` that corrupts the first filter. Never happened-to-set `unauthorized` boolean column. **Snapback uses a real `status` enum.**
- `accessToken` printed to stdout with the full refresh token on every refresh (`src/Migrate.ts:100`).
- errors transported through unencoded cookies (`callback.ts:330-346`), parseable with `;` and space corruption.
- no deauth handling at all: no `APPLICATION_DEAUTHORIZED` listener, no revoke job, no retention sweep. Revoked rows keep refresh tokens forever.
- `skip_verify` button (`interaction.ts:318-343`) calls `PUT /guilds/{g}/members/{u}/roles/{role}` directly with no DB write, no log, no captcha, no blacklist check, and no verification at all. **Not building this.** If owner asks for it, it becomes an explicit open-invite button labeled as such, logged.
- `admin/deploy.ts` runs `exec("cd … && git pull && npm i && npm run build && pm2 restart all")` off a GET param.
- rate limiter is an in-process LRU under PM2 `instances: "max"`, so the effective limit is per-worker.
- `x-track` as a hard requirement that returns 400 to any non-browser client, on an unvalidated unbounded header.
- the "fingerprint" endpoint is an HMAC of a timestamp, not a device fingerprint (`src/functions.tsx:42-49`), cookie set with no HttpOnly/Secure/SameSite.

### Discord-Auth-Bot

Selfbot-credential harvester, not an OAuth app. `accounts.json` holds user emails/passwords/AI tokens/IPs (`data/accounts.json:3`); `cmd-lookup.js` DMs whoever runs `,auth`. The only idea worth keeping is the *shape* of the "capture on verify, check later" loop, which RestoreCord already implements properly. Nothing else ports. See `notes-oauth-vaultcord.md` for the full walkthrough.

### Oauth-Bot

discord.js v12, `discord-buttons`, 19 `+command` handlers, five of 30 deps actually used. The single real asset is `config.js:2` building the authorize URL from scopes `identify guilds.join email`. Framing problem: the README groups `+nsfw`, `+nitro1`, `+roblox`, `+gift`, `+captcha` under "Grab Commands", and `+nitro1`'s embed (`index.js:104-123`) is a fake reward lure pointing at an `identify+email+guilds.join` URL. That is a phishing funnel. Snapback takes the button/embed mechanics and drops the framing entirely. No reward lures, no fake "you won" copy, no grabbing.

### vaultcord-site

Single static page, the oauth config pulled from `GET /servers/profile/{hostname}` so `client_id` never appears in HTML and scopes derive from server flags. Port that pattern. Also port `loadEmojis`/emoji-sidecar thinking: it keeps emoji ids inside the `<:name:id>` string, which androz loses.

### ItsChasa Discord-Backup (python)

User-token selfbot, full account backup (guilds, DMs, group chats, relationships, settings-proto). `client_info.py` has the complete `X-Super-Properties` / client-build-number / `tls_client` chrome_113 impersonation stack. Not needed: bot tokens don't require super properties. The one genuinely useful line is `build_headers`'s deterministic header ordering. Skip the whole file.

### Discord-Backup-Bot (Alyetama, python)

Prefix `!backup`, administrator-only, message-only, gzip jsonl written per channel from a history backfill. 45 files, 1 py. Confirms message backup alone is not the product.

### Discord-Backup-Tool-V2

`index.js` is a 470-line CLI wrapper around `discord-backup@3.2.1` with `discord.js-selfbot-v13`. Transport unusable for a bot. Full engine and bug list in the androz section.

---

## 3. Runtime layout

```
src/index.ts              # wiring only: env -> db -> bot -> web -> cron
src/bot/client.ts         # oceanic client, single interactionCreate router
src/bot/commands/*.ts     # one file per command, definition + run
src/bot/gates.ts          # requireOwner, requireAdmin, requireGuild
src/bot/ui/kit.ts         # container/section/textdisplay/separator/actionrow builders
src/bot/ui/color.ts       # accent from guild config, fallback 0x5865F2
src/bot/autocomplete.ts   # backup, guild, user, member pickers
src/bot/setup/*.ts        # one file per wizard page + the router
src/backup/capture.ts     # guild -> BackupData
src/backup/store.ts       # save, list, prune, export, checksum
src/restore/plan.ts       # BackupData + options -> op list + diff preview
src/restore/execute.ts    # phased executor, live message edits, cancel
src/restore/messages.ts   # webhook senders, reply pass, pin pass
src/pull/engine.ts        # join loop, counters, cooldowns
src/pull/errors.ts        # discord error body parser
src/pull/tokens.ts        # encrypt/decrypt, refresh
src/web/server.ts         # Bun.serve, routes, static
src/web/verify.ts         # /v/{slug}
src/web/callback.ts       # /oauth/callback
src/web/geo.ts            # mmdb country/asn, hosting flag
src/web/fingerprint.ts    # nonce mint/verify + x-track store
src/db/client.ts          # duckdb | postgres switch
src/db/schema.duckdb.sql
src/db/schema.postgres.sql
src/db/*.ts               # one module per table, no inline sql elsewhere
src/util/errors.ts        # (http, code) -> action + user text
src/util/ratelimit.ts     # route buckets, Retry-After honor
src/util/log.ts           # log channel + rotating file, redaction
src/util/jobs.ts          # in-process queue, resumable rows
src/util/snowflake.ts     # id -> creation date
docs/
data/                     # duckdb file, *.mmdb, exports (gitignored)
```

---

## 4. Backup format (schema version 1)

Root object. Stored as one JSON column in `backups.data` and as `data/backups/{id}.json` for export.

```ts
BackupData {
  version: 1
  id: string                    // snowflake-ish, also the filename
  guildId: string
  guildName: string
  createdAt: string             // ISO
  createdBy: string             // user id
  trigger: "manual" | "auto" | "prerestore"
  sizeBytes: number

  guild: {
    name, description, iconUrl, iconBase64?, splashUrl, splashBase64?,
    bannerUrl, bannerBase64?, discoverySplashUrl, discoverySplashBase64?,
    preferredLocale, features: string[],
    verificationLevel, explicitContentFilter, defaultMessageNotifications,
    mfaLevel, premiumTier, premiumProgressBarEnabled,
    afk: { channelName: string | null, channelId: string | null, timeout },
    systemChannel: { id: string | null, name: string | null, flags: string[] },
    rulesChannelId, publicUpdatesChannelId,
    safetyAlertsChannelId, widgetEnabled, widgetChannelId,
    vanityCode: string | null
  }

  roles: Role[]                 // top-to-bottom by position
  categories: Category[]
  others: Channel[]             // channels with no category
  members: Member[]
  bans: Ban[]
  emojis: Emoji[]
  stickers: Sticker[]
  onboarding: Onboarding | null
  welcomeScreen: WelcomeScreen | null
  automod: AutoModRule[]        // summary, not full rule reconstruction
  invites: Invite[]             // vanity + anything fetchable, no secrets
  scheduledEvents: ScheduledEvent[]
  managedRoles: { id, name, botId, integrationType }[]   // informational only
  counts: { channels, categories, threads, messages, members, roles, bans, emojis, stickers }
  skipped: { field: string, reason: string }[]            // every deliberate omit
}
```

```ts
Role {
  id, name, color: `#${string}`, hoist, permissions: string,  // decimal bitfield
  mentionable, position, isEveryone,
  iconUrl?, iconBase64?, unicodeEmoji?,
  tags?: { botId?, integrationId?, premiumSubscriberRole?, availableForPurchase?, guildLinkedRole? },
  managed: boolean
}

Category { id, name, position, overwrites: Overwrite[] }

Channel {                       // one of the three below
  id, type, name, position,
  parentId?: string | null,     // id, name kept in a parallel map
  overwrites: Overwrite[]
}                               // text adds:
  // topic, nsfw, rateLimitPerUser, isAnnouncement, defaultAutoArchiveDuration,
  // defaultThreadRateLimitPerUser, lastMessageId?, messages: Message[]
  // forum adds: availableTags[{id,name,emojiId,emojiName,moderated}], defaultReactionEmoji,
  //             defaultSortOrder, defaultThreadRateLimitPerUser, defaultLayout
  // voice adds: bitrate, userLimit, rtcRegion, videoQualityMode
  // stage adds: stageInstance?: { topic, privacyLevel, scheduledStart }
  threads: Thread[]

Thread { id, name, type, archived, locked, invitable?, autoArchiveDuration,
         rateLimitPerUser, appliedTags?: string[], messages: Message[] }

Overwrite { id, type: "role" | "member", allow: string, deny: string, name: string }

Message {
  id, channelId, authorId, authorBot: boolean,
  username, globalName?, discriminator, avatarUrl, bannerUrl?, accentColor?,
  nickname?,                      // member nick in this guild at backup time
  type: number, flags: string[],
  content, cleanContent,          // cleanContent has mentions resolved
  createdAt, editedAt?, sentAt: string,
  pinned: boolean,
  tts: boolean, referenced?: { messageId, channelId, guildId? },
  embeds: Embed[],
  components?: Component[] | null, // raw v2 json if present
  attachments: Attachment[],
  stickers: { id, name, formatType }[],
  reactions: { emojiId?, emojiName?, count, me?: boolean }[]  // top 5 by count
}

Attachment { id, name, url, contentType?, size?, width?, height?, duration?: number,
             waveform?: string, isEphemeral?: boolean, base64?: string }

Ban { userId, reason }

Emoji { id, name, animated, url, base64?, roles: string[], available: boolean }

Sticker { id, name, description, tags: string, formatType, url, base64? }

Onboarding { enabled, mode, prompts: [{ id, title, singleSelect, required, inOnboarding,
                                       options: [{ id, channelIds, roleId, title, description,
                                                   emojiId, emojiName }] }],
             defaultChannelIds: string[], belowRequirements: boolean }

WelcomeScreen { enabled, description, welcomeChannels: [{ channelId, description,
                                                          emojiId, emojiName }] }

AutoModRule { id, name, eventType, triggerType, triggerMetadata, actions,
              enabled, exemptRoles: string[], exemptChannels: string[] }

Invite { code, channelId?, inviterId?, maxAge, maxUses, temporary, uses,
         createdAt, expiresAt?, targetType?, targetUserId?, targetApplicationId? }

ScheduledEvent { id, name, description, channelId?, entityId?, privacyLevel,
                 entityType, status, scheduledStart, scheduledEnd?,
                 recurrenceRule?, entityMetadata?: { location } }

Member {
  userId, username, globalName?, discriminator, avatarUrl, bannerUrl?, accentColor?,
  bot: boolean, system?: boolean,
  nickname?, roles: string[],       // ids, excluding @everyone
  joinedTimestamp?, premiumSince?, communicationDisabledUntil?: string | null,
  pending?: boolean, flags: string[], avatarDecorationUrl?,
  guildAvatarUrl?                    // per-guild avatar
}
```

Deliberate omissions (each recorded in `skipped[]`, never silent): `guild.icon` is fetched as base64 only under a size cap; member overwrites are captured by id but a member who left the guild cannot be resolved by name on restore, so they are recorded and warned; `onboarding` prompts cannot be fully reconstructed through the API, only recreated best-effort; audit log is snapshotted as a count only; integrations and app connections are not captured (they hold credentials); webhooks are not captured (they hold tokens); `automod` trigger metadata is captured but keyword presets cannot be recreated.

---

## 5. Database

Both dialects, no ORM, hand-written schema kept in sync. Snowflakes are `TEXT`. JSON is `JSON` in postgres and `JSON` in duckdb (duckdb needs `CAST(? AS JSON)` on write).

```sql
bot_config(key TEXT PRIMARY KEY, value JSON NOT NULL)

guilds(
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  backup_enabled BOOLEAN DEFAULT TRUE,
  auto_backup_interval_h INTEGER DEFAULT 0,      -- 0 = off
  auto_restore_on_join BOOLEAN DEFAULT FALSE,    -- owner opt-in
  log_channel_id TEXT,
  verify_channel_id TEXT,
  verify_message_id TEXT,
  verify_slug TEXT UNIQUE,                        -- /v/{slug}
  verify_config JSON,                             -- embed fields + scopes + redirect
  accent_color INTEGER DEFAULT 5793266,
  ephemeral_default BOOLEAN DEFAULT TRUE,
  backup_default_msgs INTEGER DEFAULT 1000,
  restore_default_msgs INTEGER DEFAULT 100,
  backup_max_msgs INTEGER DEFAULT 10000,          -- hard cap, not editable
  retention_max_age_days INTEGER DEFAULT 0,
  retention_max_count INTEGER DEFAULT 0,
  pull_daily_limit INTEGER DEFAULT 200,
  pull_delay_ms INTEGER DEFAULT 750,
  pull_cooldown_days INTEGER DEFAULT 1,
  restore_with_backup_roles BOOLEAN DEFAULT FALSE,
  clear_guild_before_restore_default BOOLEAN DEFAULT FALSE,
  save_images_base64 BOOLEAN DEFAULT FALSE,
  webhook_name TEXT DEFAULT 'Snapback Restore',
  added_at TIMESTAMP DEFAULT now()
)

backups(
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT now(),
  created_by TEXT NOT NULL,
  trigger TEXT DEFAULT 'manual',
  size_bytes BIGINT DEFAULT 0,
  checksum TEXT,
  counts JSON,
  data JSON NOT NULL
)
CREATE INDEX backups_guild_created ON backups(guild_id, created_at DESC)

oauth_records(
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  username TEXT, global_name TEXT, discriminator TEXT, avatar TEXT,
  email TEXT, banner TEXT, accent_color INTEGER, locale TEXT, mfa_enabled BOOLEAN,
  premium_type INTEGER, avatar_decoration TEXT,
  scopes TEXT,                       -- space-delimited, mirrors authorize url
  connections JSON,                  -- [{type, name, verified, visibility}] if scope
  friends_count INTEGER,
  guilds_count INTEGER,
  access_enc TEXT, refresh_enc TEXT,
  access_expires_at TIMESTAMP,
  ip_first TEXT, ip_last TEXT,
  geo JSON,                          -- country/region/city/asn/asName
  vpn BOOLEAN DEFAULT FALSE, hosting BOOLEAN DEFAULT FALSE,
  user_agent TEXT, time_zone TEXT, screen TEXT, hardware_concurrency INTEGER,
  browser JSON, audio_devices INTEGER, do_not_track TEXT,
  fingerprint TEXT,                  -- sha256 of the assembled payload
  account_created_at TIMESTAMP,       -- from snowflake
  referrer TEXT, source TEXT,         -- source: verify page, invite link
  status TEXT DEFAULT 'active',       -- active | stale | revoked | cooldown | blacklisted
  cooldown_until TIMESTAMP,
  joins_today INTEGER DEFAULT 0,
  joins_date TEXT,                   -- YYYY-MM-DD bucket
  verified_at TIMESTAMP,
  last_checked_at TIMESTAMP,
  notes TEXT,
  PRIMARY KEY (user_id, guild_id)
)
CREATE INDEX oauth_guild_status ON oauth_records(guild_id, status)
CREATE INDEX oauth_cooldown ON oauth_records(guild_id, cooldown_until)

pull_runs(
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  started_by TEXT,
  started_at TIMESTAMP DEFAULT now(),
  finished_at TIMESTAMP,
  status TEXT DEFAULT 'running',     -- running | done | cancelled | failed
  total INTEGER DEFAULT 0, added INTEGER DEFAULT 0, already INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0, refreshed INTEGER DEFAULT 0,
  skipped_cooldown INTEGER DEFAULT 0, revoked_found INTEGER DEFAULT 0,
  detail JSON,                       -- per-user outcomes, capped at 500 entries
  error TEXT
)

audit_log(
  id TEXT PRIMARY KEY,
  at TIMESTAMP DEFAULT now(),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSON
)

setup_state(
  user_id TEXT, guild_id TEXT, page TEXT,
  data JSON, updated_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, guild_id)
)

setup_checklist(
  user_id TEXT, guild_id TEXT, item_id TEXT, done BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (user_id, guild_id, item_id)
)

oauth_states(
  nonce TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  consumed_at TIMESTAMP
)

member_history(                       -- append-only, never deleted by refresh
  id TEXT PRIMARY KEY,
  user_id TEXT, guild_id TEXT,
  at TIMESTAMP DEFAULT now(),
  event TEXT,                          -- verified | status_change | refreshed | deleted | cooldown
  detail JSON
)
```

Postgres-only extras: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` is not needed, but `TIMESTAMPTZ` instead of `TIMESTAMP` and `JSONB` instead of `JSON` are worth using when the driver is postgres. Both schemas ship; `src/db/client.ts` picks and applies the right file on boot.

Snowflake conversion helper at the boundary: duckdb returns `BigInt` for `BIGINT`, postgres returns `string` for `BIGINT`. `src/db/rows.ts` normalizes both to `string` so nothing downstream branches on driver.

Token encryption: `aes-256-gcm` with `ENCRYPTION_KEY` (32 bytes hex), iv per record, ciphertext `base64`. Decryption happens only in `src/pull/tokens.ts` and `src/web/callback.ts`'s refresh path. No command ever returns plaintext tokens. The `/members export` command can, because it is owner-only and writes an audit row saying it did.

---

## 6. Commands

All commands: guild-only, `defer()` first thing, Components V2 only, ephemeral per `guilds.ephemeral_default`. Custom ids `snap:<cmd>:<action>:<id>`, parsed by `src/bot/ui/ids.ts`.

Custom id namespace, fixed:

```
snap:setup:page:<pageName>
snap:setup:save
snap:setup:back
snap:setup:cancel
snap:backup:start
snap:backup:list:<page>
snap:backup:info:<id>
snap:backup:delete:<id>
snap:backup:export:<id>
snap:backup:restore:<id>
snap:backup:diff:<idA>:<idB>
snap:backup:prune
snap:restore:guild:<backupId>
snap:restore:scope:<backupId>:<field>
snap:restore:opts:<backupId>
snap:restore:dryrun:<backupId>
snap:restore:confirm:<backupId>
snap:restore:cancel
snap:pull:start
snap:pull:guild:<id>
snap:pull:cancel:<runId>
snap:members:lookup
snap:members:refresh:<userId>
snap:members:delete:<userId>
snap:members:confirm:<userId>
snap:members:export
snap:verify:setup
snap:verify:send
snap:verify:test
snap:verify:redeploy
snap:config:get:<key>
snap:config:set:<key>
snap:config:reset
snap:config:export
snap:config:import
snap:admins:add
snap:admins:remove:<userId>
snap:status:refresh
snap:docs:<topic>
```

### `/setup`
Owner or admin. Nine pages. State in `setup_state`, so a half-finished wizard survives restart. `DefineOptionType` string select for page choice, buttons back/save/cancel, modals for text fields, file upload modal for avatar/banner.

| page | what it writes | widgets |
|---|---|---|
| `checklist` | `setup_checklist` rows | string select per item + done button, "test redirect" button does `fetch(BASE_URL + /health)` |
| `identity` | `bot_config.status_text`, `status_kind`; calls `client.editStatus` + `client.users[@me]` | modal (text + activity select: playing/watching/listening/competing) |
| `avatar` | pfp/banner | file upload modal (1 file each), size + animated check, `client.editSelf` |
| `admins` | `bot_config.admin_ids` | user select multi-add, user select remove, list container with remove buttons |
| `logging` | `guilds.log_channel_id` | channel select (text only) + test ping |
| `backups` | `guilds.backup_default_msgs`, `save_images_base64`, `retention_*`, `auto_backup_interval_h` | modal numbers + toggles + guild select for auto |
| `restore` | `guilds.restore_default_msgs`, `clear_guild_before_restore_default`, `restore_with_backup_roles`, `webhook_name` | modal + toggles |
| `pulls` | `guilds.pull_daily_limit`, `pull_delay_ms`, `pull_cooldown_days` | modal numbers |
| `verify` | `guilds.verify_*` + `verify_config` | channel select + modal (title/desc/color/thumbnail/image/buttonText/slug/redirectUrl) + scope checkboxes |
| `messages` | `guilds.accent_color`, `ephemeral_default` | color picker via modal hex + toggle |

Every save: `audit_log` row with actor, page, changed keys, before/after values. Colors validate hex. Numbers clamp: `backup_default_msgs` 0..backup_max_msgs, `restore_default_msgs` 0..1000, `pull_delay_ms` 0..10000, `pull_daily_limit` 1..2000.

Verify scope checkboxes, `identify` locked on:
```
[ ] email
[ ] guilds                       -- /users/@me/guilds list
[ ] guilds.join                  -- required for pulls, flagged if off
[ ] guilds.members.read          -- read this guild's member object
[ ] connections                  -- discord flags "requires approval"
[ ] relationships.read           -- social sdk, flagged "approval"
```
If `guilds.join` is off, the page shows a warning container: pulls disabled. The authorize url is built by exactly one function, `src/web/oauth-url.ts`, from the stored scope list.

### `/backup`
Subcommands or one command with a select? One command plus a select-driven flow, since the ask is one smooth flow.

`/backup [guild:<autocomplete>] [messages:<int, 1..10000>]`.
1. If no guild passed, string select of every guild the bot is in (paginated 24 per page, prev/next buttons).
2. Options modal: messages per channel (prefilled from config), toggles for capture sections (members, bans, emojis, stickers, onboarding, welcome, automod, invites, events), `save_images_base64`.
3. `defer()` then run. Progress edits every phase: roles, channels, threads, messages per channel count, members, bans, extras. Message fetch happens channel by channel with a live counter.
4. Result container: counts, size, id, duration, anything in `skipped[]`. Buttons: save-as-export, restore, diff.

`/backup list <guild>`: select menu of backups by date with counts, paged. Selecting one opens a detail container with buttons info/export/delete/restore/diff.

`/backup delete <backup>`: owner or admin, confirm with danger button naming the backup id, audit row.

`/backup diff <a> <b>`: compares two backups of the same guild, shows added/removed/renamed channels, role changes, member count delta, message count delta. Read-only.

`/backup prune`: applies the retention policy immediately (age and count), reports what was deleted, audit rows.

### `/restore`
Flow: backup select → target guild select → scope checkboxes → options modal → dry-run preview → confirm → execute.

Target guild select: every guild the bot is in, plus "create a new guild" if the app is in under 10 guilds. Default is the source guild from the backup.

Scopes (checkbox group, all off by default except a preset):
```
presets: [full] [structure only] [settings only] [messages only] [members only]
[ ] guild settings      -- name, icon, banner, splash, locale, verification, notifications
[ ] roles               -- create + permissions + hierarchy + managed-role warnings
[ ] channel structure   -- categories, channels, threads, positions
[ ] channel permissions -- overwrites via role/member id map
[ ] messages            -- webhook restore
[ ] replies             -- second pass, needs messages
[ ] reactions           -- after messages
[ ] pins                -- after messages
[ ] members             -- roles, nicknames, timeouts (needs Manage Roles + Moderate)
[ ] bans                -- needs Ban
[ ] emojis              -- needs Manage Emojis, tier-capped
[ ] stickers            -- tier-capped
[ ] onboarding          -- best effort
[ ] welcome screen      -- needs Community + Manage Guild
[ ] invites             -- recreate configured invites
[ ] automod             -- best effort
[ ] scheduled events    -- best effort
[ ] verify message      -- repost the verify embed
```

Options modal: max messages to write per channel (0 = all, capped 1000), webhook name, mention suppression on/off, dry-run on/off, clear-before-restore on/off.

Dry-run container: op counts per phase, the first 20 channel names it would create, roles it would create vs edit, overwrites that will drop (id not found and name not found), members it would touch, plus a "these will be destroyed" line when clear-before-restore is on with a typed confirm required.

Execution: one live message, edited per phase with a progress bar and counts. Cancel button. Writes a `pull_runs`-style row into `backups` audit (use `audit_log` with action `restore.start/finish`). On completion: summary container with per-phase results and a "rollback impossible" line for clear-before-restore.

### `/pull`
Owner or admin. `/pull <guild:<autocomplete>> [dry-run] [limit:<int>]`.
1. Guild-level `pulling` lock in `bot_config` (key `pull_lock:{guildId}`) so two pulls cannot overlap; if locked, report who started it and when.
2. Build the candidate list from `oauth_records` where `guild_id` matches and `status = 'active'` and (`cooldown_until` null or past).
3. Options: dry-run (no writes), limit (default all), `restore_with_backup_roles` (pull roles from latest backup instead of the verify role), stop-on codes.
4. Loop, `pull_delay_ms + random(0, 250)` between joins:
   - `201` → added, `joins_today++`
   - `204` → already, no counter
   - `403` with `Missing Permissions` → stop the run, report the fix, set lock free
   - `403` other → refresh token once, retry join once; failed → `stale`, continue
   - `401` on refresh (`invalid_grant`) → `revoked`, keep row, `join_runs.revoked_found++`
   - `429` → sleep exact `retry_after` (respect `X-RateLimit-Precision`), resume same user
   - `400` banned-from-guild code → mark `blacklisted`, no retry
   - `400` maximum guilds code → mark `stale` with reason, continue
   - network error → retry 3 times with backoff, then `failed`, continue
5. When `joins_today >= pull_daily_limit`, set `cooldown_until = now + pull_cooldown_days` on that record and skip the rest for that user.
6. Live edits every 25 users or every 5 seconds, whichever first. Cancel button writes `pull_runs.status = 'cancelled'`.

### `/members`
`/members lookup <user:<autocomplete>>` — container with the record, thumbnail avatar, everything stored, buttons refresh/delete/export-one.

`/members refresh [guild]` — validity sweep, no joins. For each record: `GET /users/@me` with the access token; on 401 refresh once and re-check; on second failure `revoked`; success updates `last_checked_at` and any changed fields (username, avatar, email, banner, accent color, premium_type). Live-edits one summary: `checked / active / stale / revoked / cooldown`, then an expandable list of revoked user ids. **Never deletes.** Captured ip, email, geo, fingerprint stay.

`/members delete <user>` — owner only, confirm dialog with typed user id, deletes `oauth_records` + `member_history`, audit row naming actor and target. Warns that this is the only path that drops captured ip/email/geo.

`/members export [guild]` — owner only. Sends the full record set as a json attachment plus a summary line. Confirm + audit row.

`/members blacklist <user> [reason]` — marks `status='blacklisted'`, excluded from pulls and verify.

`/members note <user> <text>` — admin note on the record.

### `/verify`
`/verify setup` — channel select + the full embed modal + scope checkboxes + slug. Posts a preview to the channel (or edits the existing `verify_message_id`). Button url is `${BASE_URL}/v/{slug}`.

`/verify send` — reposts without editing config. `/verify test` — ephemeral, sends the owner the exact authorize url the page will build. `/verify redeploy` — edit existing message in place.

Verify embed (v2): container, thumbnail = server icon, textdisplay with title/body, section with a link button. Never a plain embed.

### `/config`
`/config get <key>` — string autocomplete over the full key list, shows the value with secret masking. `/config set <key> <value>` — modal, typed coercion by key (bool/int/string/list/json), clamped. `/config reset` — select key → confirm → restore default. `/config export` — json attachment of every config value. `/config import` — accepts a pasted json in a modal, diff preview, confirm apply.

### `/admins`
`/admins add <user>`, `/admins remove <user>`, `/admins list` — owner only for add/remove. Denial message states the required role.

### `/status`
Container: uptime, db driver + row counts, backups count + total size, pull counters today per guild, pending/locked jobs, error count last 24h, cloudflare mode, mmdb loaded or not, last auto-backup per guild. Buttons: refresh, run pending jobs.

### `/docs`
`/docs <topic>` — string autocomplete over doc files, replies with the path and a link, or the first 100 lines inline if the deployment has no hosted docs.

---

## 7. Restore engine

Strictly phased. Phase N+1 does not start until phase N is fully resolved, which is the fix for androz's concurrent-roles race.

**Phase 0, resolve.** Load backup, validate `version`, compute the op list, build `roleOldId → newId` (empty until phase 2), `channelOldId → newId`, `threadOldId → newId`. Emit the dry-run preview from this.

**Phase 1, guild settings.** Name, icon, banner, splash, description, discovery splash, locale, verification level, notification default, explicit filter (only if the target has Community), AFK channel (after channels exist, so it is deferred to phase 6), system/rules/update channels (also deferred). MFA level requires Manage Guild + owner 2FA. Feature-gated changes are logged as skipped with the feature that was missing.

**Phase 2, roles.** Edit `@everyone` (permissions, mentionable, color). Create the rest top-to-bottom by stored `position`, skipping `managed: true` (recorded to `managedRoles` and reported at the end). Then a second pass setting `position` on every created role, walking bottom-up so a position never pushes another role's slot before it is set. Build the id map as roles are created, keyed on stored id, with a name+color+position fallback for records whose id already exists in the target (re-restore into an already-restored guild). Bot roles cannot be created by the app; a bot in the target with a matching name gets linked in the map so overwrites still resolve.

**Phase 3, categories.** Created by stored `position`, then overwrites applied through the id map. Member overwrites whose member is not in the target are recorded as dropped with the reason.

**Phase 4, channels.** By `position`, parents first. Text/announcement/forum/voice/stage created with all settings. Bitrate capped to the target's tier (`MaxBitratePerTier`). Forum `availableTags` created before threads. Threads created after their parent channel, then archived/locked/rateLimit applied in a second pass because a thread cannot be created archived.

**Phase 5, channel permissions.** Applied after phases 3 and 4 so every role id is resolvable. Overwrite resolution order: stored id → id map → exact name match → case-insensitive name match → dropped and logged.

**Phase 6, channel references on the guild.** AFK channel and timeout, system channel with flags, rules channel, public updates channel, widget. All by resolved id.

**Phase 7, emojis then stickers.** Tier-capped counts, 500 ms gap, roles attached, name truncated to 32. Animated preserved through the stored url.

**Phase 8, messages.** Per text channel, in chronological order. See §8.

**Phase 9, replies.** Second pass. For each stored message with `referenced.messageId` that was actually sent, edit the restored message to point at the restored reference. Webhook edits cannot change the message author, only `message_reference`, so this is a per-message `PATCH`.

**Phase 10, reactions.** `PUT /channels/{c}/messages/{m}/reactions/{emoji}/@me` for the top 5 stored reactions, one request each, after the messages settle.

**Phase 11, pins.** Pin up to 50 per channel. The 51st are logged as dropped with the count.

**Phase 12, members.** Requires Manage Roles + Moderate Members. For each stored member present in the target: roles through the map minus `@everyone` minus managed roles the app cannot assign, then nickname, then `communication_disabled_until` (timeout). Members absent from the target are recorded in a "not in target" list, which is the bridge to `/pull`. Never kicked.

**Phase 13, bans.** `guild.members.ban(userId, {reason})`, 1 s gap, `deleteMessageSeconds` from config (default 1 hour), reasons preserved.

**Phase 14, onboarding, welcome screen, invites, automod, scheduled events.** Best-effort with per-item warning lines. Onboarding prompt option `roleId`/`channelIds` mapped. Welcome screen needs Community.

**Phase 15, verify message.** Repost the verify embed into the configured channel if the scope is on.

**Phase 16, report.** Summary container: per-phase ok/warn/fail counts, the dropped list (overwrites, pins, emojis over cap, members not in target, managed roles), duration, backup id, and a line stating the operation is not reversible.

**Cancel.** A cancel button sets a flag checked between every item in every phase. The current phase finishes its item, then the executor writes a partial result container and stops. Partial restores are recorded in `audit_log` with the phase it stopped at so a re-run can resume.

**Clear before restore.** Off by default. When on, requires typing the target guild name, and deletes only what the backup has (channels and roles by id map, not a blanket wipe like androz's `clearGuild`). Deletes are awaited, not fire-and-forget.

---

## 8. Message restore

One webhook per target channel, name from `guilds.webhook_name`, created with `getToken` from the bot's own application (the `applications.commands` + `webhook.incoming` flow is not needed, channel webhooks are enough), and reused across a channel and its threads.

Per message, in order:
```ts
webhook.send({
  content: m.content.slice(0, 2000) || undefined,
  username: m.nickname || m.globalName || m.username,   // ≤80 chars
  avatarURL: m.avatarUrl,                                // fetched/stored, not default-missing
  embeds: m.embeds.slice(0, 10),
  components: m.components ?? [],
  files: attachments.map(a => toFile(a)),                // from base64 or re-fetch url
  allowedMentions: suppressions ? { parse: [] } : undefined,
  threadId: channel.isThread() ? channel.id : undefined,
})
```
Empty messages (no content, embed, component, or file) are skipped and counted. Pinned flag held for the pin pass. `enforceNonce` off. A message that fails is retried twice, then skipped with a reason in the dropped list; the pass continues.

Avatar resolution: stored `avatarUrl` is the CDN url with hash and extension, so animated avatars survive. If a message author has since deleted their account, the url 404s and the message falls back to `username` with no `avatarURL`, logged as a warning. A local disk cache of fetched avatars (configurable on/off) avoids re-fetching the same avatar 400 times in a busy channel.

Webhook rate limit is 5 sends/sec per webhook, tracked by `src/util/ratelimit.ts` as a token bucket with the `X-RateLimit-Remaining`/`X-RateLimit-Reset` headers honored first and a 200 ms floor between sends second. A single channel's send loop is sequential. Different channels run sequentially too (a restore is already a long job; parallelism buys nothing and risks global limits).

`maxMessagesPerChannel` on restore defaults to 100 and is capped at 1000 per the ask, with a warning shown when the backup has more than the cap.

---

## 9. Pull engine detail

State machine per record:

```
active ──join ok──> active (joins_today++)
active ──join 204──> active
active ──join 403 ─ refresh ok ─ retry ok ─> active
active ──join 403 ─ refresh fails ─> revoked   (row + all captures kept)
active ──join 400 banned ─> blacklisted
active ──join 400 maxguilds ─> stale (reason)
active ──join 401 refresh invalid_grant ─> revoked
active ──join 429 ─> sleep retry_after, same state
active ──network ─> 3 retries with backoff, then failed (state kept)
active ──joins_today >= limit──> cooldown (cooldown_until set)
```

`joins_date` is a `YYYY-MM-DD` bucket compared against today; a new day resets `joins_today` to 0 and clears an expired `cooldown_until`. That is the whole per-account daily-limit feature the ask called for, and it is per *verified member*, not per target guild.

Restore-with-backup-roles: when `guilds.restore_with_backup_roles` is on, roles passed to the join come from the latest backup's `Member.roles` mapped through the just-completed restore's id map. The user-facing effect is the RestoreCord-style "pull everyone back with their roles". When off, the verify-configured role is used.

Concurrency: strictly sequential with jitter. A config knob exists but defaults to 1, and the docs say why (global rate limit, account-looking traffic).

Progress message edits: every 25 users or 5 s. Fields shown: `done/total`, `added`, `already`, `failed`, `refreshed`, `skipped cooldown`, `revoked found`, current user id, elapsed, ETA from the rolling average.

Stopping conditions recorded in `pull_runs.status`: `done`, `cancelled`, `failed` (with `error`), `stopped_perms` (403 permissions).

---

## 10. Website

`Bun.serve` on `PORT`, bound to `0.0.0.0` (tunnel-facing) with `TRUST_PROXY` controlling whether forwarded headers are read.

| route | method | body/params | response |
|---|---|---|---|
| `/` | GET | — | status html: bot name, guilds managed, docs links |
| `/v/{slug}` | GET | slug | verify page html |
| `/oauth/callback` | GET | `code`, `state` | 302 to `verify_config.redirectUrl` or `/done` |
| `/x-track` | POST | json attributes + `X-FP-Nonce` | 204 |
| `/api/geo` | POST | `{ip}` | `{country, region, city, asn, asName, hosting}` |
| `/health` | GET | — | `{ok, db, mmdb}` 200/503 |
| `/privacy`, `/terms` | GET | — | static md rendered |

`/v/{slug}` server-side:
1. resolve slug → guild; unknown slug = 404 with a generic page (no orphan error leaking guild data)
2. guild `verify_config`: embed title, description, color, thumbnail, image, button text, oauth scopes, redirect url, captcha on/off, min account age, block vpn/hosting, block alts
3. mint `X-FP-Nonce` = hmac(secret, timestamp + random), 10-minute expiry, stored in memory with the guild id, set as `HttpOnly; Secure; SameSite=Lax`
4. render: container-equivalent html card with server name and pic, the scope list in plain words, a verify button linking to the authorize url, a turnstile widget if enabled, and a small script that collects x-track attributes and posts them with the nonce

Verify page checks before joining (all server-side, after callback):
- nonce present, unexpired, and not consumed (CSRF, single use)
- `state` nonce matches guild and was not consumed
- account age ≥ `min_account_age` using snowflake→date
- vpn/hosting block from local geo, not a paid api
- captcha verified if on
- blacklist check on user id, ip, asn, country (all optional toggles)

Then: exchange → `/users/@me` (+ email, guilds, guilds.members.read, connections per scope) → upsert `oauth_records` (encrypted tokens, all captures, `verified_at`, `last_checked_at`) → immediate join attempt with the configured role → 302.

On a join failure inside the callback, the record is still stored (the member can be pulled later); the failure is reported on the redirect page.

Deauthorization: subscribe to `APPLICATION_DEAUTHORIZED` via the events webhook field in the dev portal if the owner sets it; otherwise `/members refresh` catches revoked tokens within a day. Either way the row stays.

---

## 11. Fingerprint and geo

`x-track` collected client-side (no library): userAgent, language, timezone, screen, hardwareConcurrency, deviceMemory, platform, doNotTrack, touch support, a canvas hash, and an audio-device count. Posted with the nonce. Server stores it on the oauth record and computes a sha256 `fingerprint` of the assembled payload so repeat verifications can be correlated across ip changes.

The nonce binds the fingerprint to the same session that exchanged the code, which is what restorecord-new never did (its fingerprint endpoint mints an unbound hmac timestamp).

ip resolution order: `CF-Connecting-IP` when cloudflare mode is on, else the first untrusted-proxy entry in `X-Forwarded-For` when `TRUST_PROXY`, else the socket address. The mode is stored per guild in config and mirrored in `/setup` so a cloudflare tunnel user turns it on in the wizard instead of only in `.env`.

geo: db-ip lite `dbip-city-lite.mmdb` → country, region, city, asn, asName. ipverse as-metadata → `hosting` bool. Both local files in `data/`, loaded once at boot into an `mmdb-lib` reader. Missing file = geo skipped with a `/status` warning and `geo` left null, never a crash. `vpn` = hosting or asn on the vpn list in `data/vpn-asns.txt` (editable, empty by default).

Nothing is sent to a third party for geo or fingerprinting. This is the one place where the references went wrong (proxycheck.io, ipinfo.io, a residential proxy for every discord call, and three dev ids bypassing ip logging) and the plan is firm: local data only, no bypass list, no per-user whitelist that changes logging.

---

## 12. Error catalog

Parsed from the discord JSON body, never guessed. `src/util/errors.ts` maps `(status, code)` to `{ action, userText, retryable }`.

| status | code | meaning | action | user text |
|---|---|---|---|---|
| 400 | 10007 | unknown member | drop from candidates | "member no longer exists, skipped" |
| 400 | 10011 | unknown role | drop that role from the join | "role missing, joined without it" |
| 400 | 30001 | max guilds (100) | mark `stale`, skip | "member is in 100 servers already" |
| 400 | 50035 | invalid form body | log `errors` field verbatim | "discord rejected the payload, logged" |
| 400 | 30032 | banned from guild (join) | mark `blacklisted`, no retry | "member is banned from this server" |
| 400 | 30037 | user not authorized for join | refresh once then skip | "member needs to re-verify" |
| 401 | 40001 | unauthorized (bad bot token) | stop the run, alert owner | "bot token is invalid, check BOT_TOKEN" |
| 401 | invalid_grant (oauth2) | refresh token dead | mark `revoked`, keep row | "member revoked access, record kept" |
| 403 | 50001 | missing access | check guild membership + channel visibility | "bot cannot see this, check permissions" |
| 403 | 50013 | missing permissions | stop the run, name the permission | "bot needs Manage Roles (or similar)" |
| 404 | 10003 | unknown channel | skip the channel | "channel gone, skipped" |
| 404 | 10004 | unknown guild | skip the whole run | "bot is not in that server" |
| 409 | 30002 | already in guild (join race) | count as `already` | — |
| 429 | — | rate limited | sleep exact `retry_after`, honor `X-RateLimit-Precision`, resume | "slowed down for rate limit" |
| 500/2xx/network | — | transient | 3 retries, exponential backoff, then `failed` | "temporary failure, will retry" |
| any | anything else | unknown | show discord's own message, log full body | discord's message text |

OAuth-specific: `invalid_client` (wrong secret) → owner alert; `invalid_grant` on code exchange → "verification link expired, verify again"; `unsupported_grant_type` → config bug, owner alert.

Webhook restore: `403` on `createWebhook` → cannot manage webhooks, skip the channel's messages; `40015` (empty message) → skipped and counted; `20028` (max webhooks) → reuse an existing webhook whose name matches `webhook_name`, else skip and report.

Auth/session: 404 on `/users/@me` with a token → treat as revoked. 401 with `code: 0` on a bot-token route → token invalid.

Every error carries: at, guild id, actor id, command, status, code, message, `retry_after`, and a redacted stack. Log channel gets the row; file gets the body.

---

## 13. Jobs, retention, exports

In-process job runner (`src/util/jobs.ts`), no redis, rows in memory with DB persistence for long ones. Kinds: `backup`, `restore`, `pull`, `refresh`, `prune`, `export`. Concurrency 1 per kind per guild; a queued job reports its place. A job that dies with the process is picked up on boot if it has a row (restore/pull write a row as they start and can resume from the recorded phase, or restart cleanly).

Duplicate protection: only one `backup` per guild per 60 s, only one `pull` per guild ever, only one `restore` per target guild.

Retention (`/backup prune` runs on boot, then hourly):
- delete backups older than `retention_max_age_days` (0 = off)
- keep only the newest `retention_max_count` per guild (0 = off)
- never delete the most recent backup, even if it is over both limits
- before deleting, if `retention_export_first` is on, write a copy to `data/backups/archive/{id}.json.gz`
- every deletion is an `audit_log` row with the backup id and trigger

Exports:
- `/backup export <id>` → `data/backups/{id}.json` (or the stored gz), posted as an attachment, checksum line
- `/members export [guild]` → json attachment of the full record set including decrypted tokens. Owner only, confirm + audit row, and the file is deleted from the message after 5 minutes is not possible, so instead it is sent ephemeral and the owner is told to treat it as a secret
- `/config export` → every config value as json

Import path: `/config import` only. Backup import is not built (a restore is always from a stored backup) but the schema is stable enough that dragging a `.json` into `data/backups/` and running `/backup list` shows it, if `path` is set to that directory in config.

---

## 14. Config keys

Everything `/setup` writes, with type and clamp. All of these live in `guilds` or `bot_config` per §5.

| key | type | default | clamp | notes |
|---|---|---|---|---|
| `bot_config.owner_ids` | list | env `OWNER_ID` | — | additive, cannot remove the env owner |
| `bot_config.admin_ids` | list | [] | — | added by `/admins add` |
| `bot_config.status_text` | string | "snapback" | ≤128 | presence |
| `bot_config.status_kind` | enum | playing | playing/watching/listening/competing | |
| `bot_config.log_channel_id` | snowflake | null | — | global fallback |
| `bot_config.ephemeral_default` | bool | true | — | per-command opt-out possible |
| `bot_config.backup_dir` | path | data/backups | — | |
| `guilds.backup_default_msgs` | int | 1000 | 0..10000 | 0 = no messages |
| `guilds.backup_max_msgs` | int | 10000 | 100..10000 | hard cap, editable but bounded |
| `guilds.restore_default_msgs` | int | 100 | 0..1000 | |
| `guilds.save_images_base64` | bool | false | — | icons/emoji/sticker/attachment inline |
| `guilds.attachment_max_bytes` | int | 8388608 | 0..26214400 | 8 MB default |
| `guilds.retention_max_age_days` | int | 0 | 0..3650 | 0 = off |
| `guilds.retention_max_count` | int | 0 | 0..500 | 0 = off |
| `guilds.retention_export_first` | bool | true | — | archive before delete |
| `guilds.auto_backup_interval_h` | int | 0 | 0..8760 | 0 = off |
| `guilds.auto_restore_on_join` | bool | false | — | owner opt-in, warns loudly |
| `guilds.clear_guild_before_restore_default` | bool | false | — | |
| `guilds.restore_with_backup_roles` | bool | false | — | pull using backup roles |
| `guilds.webhook_name` | string | Snapback Restore | ≤80 | |
| `guilds.suppress_mentions` | bool | true | — | `parse: []` on restore |
| `guilds.pull_daily_limit` | int | 200 | 1..2000 | per member per day |
| `guilds.pull_delay_ms` | int | 750 | 0..10000 | plus 0..250 jitter |
| `guilds.pull_cooldown_days` | int | 1 | 0..365 | days locked out at the limit |
| `guilds.accent_color` | int | 5793266 | any hex | 0x5865F2 blurple |
| `guilds.log_channel_id` | snowflake | null | — | overrides global |
| `guilds.verify_channel_id` | snowflake | null | — | |
| `guilds.verify_slug` | string | generated | 4..64 url-safe | `/v/{slug}` |
| `guilds.verify_config.embed.*` | json | — | — | title/desc/color/thumbnail/image |
| `guilds.verify_config.button_text` | string | Verify | ≤80 | |
| `guilds.verify_config.redirect_url` | url | null | — | after success |
| `guilds.verify_config.scopes` | list | identify guilds.join | — | see `/setup` list |
| `guilds.verify_config.min_account_age_days` | int | 0 | 0..3650 | |
| `guilds.verify_config.block_vpn` | bool | false | — | local geo |
| `guilds.verify_config.block_hosting` | bool | false | — | ipverse |
| `guilds.verify_config.captcha` | bool | false | — | needs turnstile keys |
| `guilds.base_url` | string | env `BASE_URL` | — | set once in `/setup` checklist |
| `bot_config.use_cloudflare` | bool | env | — | trust `CF-Connecting-IP` |
| `bot_config.trust_proxy` | bool | env | — | honor `X-Forwarded-For` |

---

## 15. `.env`

```
BOT_TOKEN=            # required, refuses to boot without it
OWNER_ID=             # required, refuses to boot without it
ENCRYPTION_KEY=       # 64 hex chars; missing = pulls disabled with a /status banner
DATABASE_URL=         # empty = duckdb at data/snapback.duckdb
BASE_URL=             # https://verify.example.com, no trailing slash
PORT=3000
USE_CLOUDFLARE=false  # true = trust CF-Connecting-IP
TRUST_PROXY=false     # true = honor X-Forwarded-For
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET=
LOG_CHANNEL_ID=       # optional fast path, /setup wins after
DATA_DIR=data
BACKUP_DIR=data/backups
```

Validation on boot names every missing required key and exits non-zero. Optional-but-recommended keys warn once and continue.

---

## 16. Setup checklist (what the wizard enforces)

The wizard's checklist page makes the owner confirm the dev-panel side, which is where these bots die:

1. application created at discord.com/developers/applications
2. bot added, **Server Members Intent** on, **Message Content Intent** on only if they want message content beyond what the bot could see (needed for full message backup)
3. bot invited with `applications.commands bot` scopes and the permissions the matrix needs: Manage Roles, Manage Channels, Manage Guild, Manage Emojis and Stickers, Manage Webhooks, Moderate Members, Ban Members, View Audit Log, Manage Events, View Channels, Send Messages
4. OAuth2 → redirects → add `${BASE_URL}/oauth/callback` exactly (scheme, host, port, path, no trailing slash)
5. OAuth2 scopes on the app side: `identify` + `email`/`guilds`/`guilds.join` as enabled in `/setup`
6. `BASE_URL` set and reachable: the checklist page has a **test** button that fetches `/health` from the configured base url, not localhost
7. tunnel, if used: cloudflare tunnel how-to in `docs/redirect-and-tunnel.md`, plus the cloudflare toggle so ip capture reads `CF-Connecting-IP`
8. invite permissions calculator link that pre-fills the computed integer
9. test verify click on the owner's own alt account before telling members

Items 4 and 7 are the two that generate support requests. The docs page spells out the tunnel path: install `cloudflared`, `cloudflared tunnel login`, `cloudflared tunnel create snapback`, `cloudflared tunnel route dns snapback verify.example.com`, config.yml with `ingress: - hostname: verify.example.com / service: http://localhost:3000` and a `- service: http_status:404` catch-all, then `cloudflared tunnel run snapback`. When that is in use, `USE_CLOUDFLARE=true`.

---

## 17. Docs

```
docs/making-the-bot.md       portal click path, intents, token, permissions matrix
docs/redirect-and-tunnel.md  oauth redirect + cloudflare tunnel + header toggle
docs/commands.md             every command with examples and screenshots
docs/self-host.md            bun, env, duckdb→postgres switch, mmdb files, systemd/docker
docs/backup-schema.md        the field list in §4, versioned
docs/troubleshooting.md      error catalog + fixes
docs/data-and-privacy.md     what is captured, why, retention, how to delete
README.md                    two-line intro, then the AGENTIC AI line on line two
```

`README.md` line two is the required banner, already present:
```
> THIS PROJECT WAS MADE PARTIALLY USING AGENTIC AI CODING TOOLS
```
Every feature PR updates its doc in the same diff. `docs/commands.md` is generated from the command definitions if the definitions carry a `docs` field, otherwise hand-written once per command and checked by a test that asserts every registered command appears in the file.

---

## 18. Build order

Each step ends with its check. Do not start a step until the previous check passes.

| # | step | verify |
|---|---|---|
| 1 | scaffold: package.json (`oceanic.js`, `@duckdb/node-api`), tsconfig strict, .env.example, dirs, `bun run check` | `bun run check` exits 0 on an empty src that still typechecks |
| 2 | `src/db` both schemas, `rows.ts` bigint→string, one query module per table | `bun test` inserts/selects/updates every table on duckdb, asserts `typeof id === "string"`, then repeats with a postgres container |
| 3 | bot shell: client, gates, ui kit, `/status`, `/docs` | a container with a section, a separator, and a button renders in a real guild; `bun run check` |
| 4 | `/setup` all pages, `setup_state`, audit rows | full pass saves; re-running shows prefilled values; audit rows exist |
| 5 | backup capture + store + list/export/delete + prune + retention | backup of a scratch guild reports the same counts as a manual recount; a channel with more messages than the cap clamps and says so |
| 6 | restore executor + dry-run + phase ordering | scratch guild restore: roles keep hierarchy, no overwrite silently dropped, replies thread, pins set, dropped list non-empty and correct |
| 7 | web + oauth + verify + x-track + geo | end-to-end verify with a test app: record row complete, join happens, revoking then `/members refresh` flips status and keeps the row |
| 8 | pull engine + counters + cooldowns + `pull_runs` | mixed valid/expired/banned set produces exactly the expected counts; a mocked 429 sleeps the exact `retry_after` |
| 9 | logging, exports, docs, README | `bun test`, `bun run check`, docs mention every command |
| 10 | docker/systemd, postgres migration path | fresh clone → `.env` → run → `/setup` works on postgres |

Order is a dependency chain: restore depends on the backup schema being frozen, pull depends on oauth storage being encrypted, and the docs pass depends on commands being final. Do not reorder to chase a feature.

---

## 19. Test plan

Unit: `src/pull/errors.ts` against the full catalog table; `src/util/ratelimit.ts` retry-after math with `X-RateLimit-Precision: millisecond`; `src/db/rows.ts` bigint handling; config coercion and clamps; `src/backup/capture.ts` field mapping off a recorded guild fixture.

Integration (against a test app and a scratch guild, skipped without env): backup → dry-run → restore → message count compare; pull with three accounts (valid, revoked, banned); oauth callback end to end including a bad `state`.

Property-ish: restore is idempotent when run twice into the same guild (second run's dropped list is the only diff); a backup of an empty guild round-trips.

Manual checklist before merging anything: click every button in `/setup`, verify the deny message when an admin runs an owner-only command, confirm the log channel shows every expected row.

---

## 20. Open questions

1. postgres is confirmed by `Bun.sql` but the two schema files are hand-maintained; a CI job should `diff` the column lists so they cannot drift. Worth a generator instead?
2. `scheduled events` restore creates future events only. Past ones cannot be backdated. Accept dropping them with a `skipped[]` entry?
3. message attachments larger than `attachment_max_bytes` fall back to url-only. If the url 404s at restore time the attachment is lost. Should the restore hard-fail that message or send it without the file?
4. onboarding restore is best-effort per the API. If the owner opts into that scope, what should the report line say when it partially fails?
