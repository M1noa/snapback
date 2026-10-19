# Backup format

The backup JSON is the contract. A backup JSON plus the asset directory beside it is a complete, engine-independent record of one guild at one moment, and another tool can read it without knowing anything about Snapback.

`src/services/export/json.ts` writes it. `src/db/schema.sql` and `src/db/types.ts` define the rows it carries. The golden file `tests/fixtures/golden-backup.json` pins the bytes, and `tests/services/export/json.test.ts` compares against it.

## The bundle

`/backup export` runs the export as a job. The job writes `backup.json` into `EXPORT_DIR/<guild_id>/` and copies the backup's asset tree alongside it. The file lives on disk with an expiry; the export job records it in `pending_exports` with `expires_at` 24 hours out, and the scheduler sweep deletes it after that.

The top level has four things:

| Key | Type | What it is |
|---|---|---|
| `schema_version` | number | the version of the captured payload, from `backups.schema_version`. Currently `1`, the constant `BACKUP_SCHEMA_VERSION` in `src/services/backup/types.ts`. It is bumped when the shape of a captured row changes in a way a restore has to know about, never because the code changed. |
| `exported_at` | string | when the bundle was written, ISO-8601. The only field that changes between two exports of the same backup. |
| `backup` | object | the one row from the `backups` table: the guild's name and images, the owner, the four counts, the size on disk, the guild settings, the onboarding, the welcome screen, the widget, the afk pair, the self-check, and the created timestamp. |
| the twelve child arrays | array | the captured rows. Each entry is one row of one table, in the column order of the schema. |

The twelve arrays, and what each one holds:

| Array | Table | What it holds |
|---|---|---|
| `roles` | `backup_roles` | every role in the guild, `@everyone` included. The permission bitfield is a decimal string. `is_everyone` is true for the role whose id equals the guild id. |
| `channels` | `backup_channels` | every guild channel, categories included. `parent_source_id` is the source id of the category, never a local one. |
| `overwrites` | `backup_channel_overwrites` | per-channel permission overwrites. `target_type` is `role` or `member`, `target_name` is the name captured for that target, and `allow` and `deny` are decimal strings. |
| `threads` | `backup_threads` | the threads of the captured channels, with their archived and locked state. |
| `members` | `backup_members` | every member, with their role ids and the names of those roles resolved at capture time into `source_role_names_json`. |
| `messages` | `backup_messages` | the captured messages, with embeds, attachments, stickers, components, reactions, and the reply reference. |
| `bans` | `backup_bans` | the ban list, with the reason the moderator typed. |
| `emojis` | `backup_emojis` | the custom emoji, with the roles allowed to use them. |
| `stickers` | `backup_stickers` | the stickers, with `format_type` deciding whether the bytes are a png, an apng, a gif, or a lottie json. |
| `sounds` | `backup_sounds` | the soundboard sounds. |
| `automod` | `backup_automod` | the auto-moderation rules, with the trigger metadata and the actions left as json so their shape can change without a migration. |
| `events` | `backup_events` | the scheduled events, with the entity metadata left as json for the same reason. |

`backup_tags` is not in the bundle. Tags are restore-time filters over rows the bundle already holds, so carrying them would be carrying a second copy of the same information.

Nothing in the bundle is a secret. A backup row and its children carry ids, names, urls, and bitfield strings. No token, no email, no IP address. The serialiser has nothing to redact, so there is no redaction header and no filter that someone can later forget to update.

## Row order

Every child list is read through its own query module, and each of those queries ends in an `ORDER BY` over the row's own id. That is what makes the same backup serialise byte for byte identically no matter what order the rows were written in, and it is what the golden-file test depends on.

| Array | Order |
|---|---|
| `roles` | `position`, then `source_role_id` |
| `channels` | `position`, then `source_channel_id` |
| `overwrites` | `source_channel_id`, then `target_type`, then `source_target_id` |
| `threads` | `source_parent_id`, then `source_thread_id` |
| `members` | `user_id` |
| `messages` | `created_at`, then `message_id` |
| `bans` | `user_id` |
| `emojis` | `source_emoji_id` |
| `stickers` | `source_sticker_id` |
| `sounds` | `source_sound_id` |
| `automod` | `source_rule_id` |
| `events` | `source_event_id` |

Messages come out oldest first. The capture reads Discord newest-first, because that is what the API returns, but the bundle is sorted by the time the message was sent, so a reader walking the array walks the conversation in order.

The keys of the object are written in the order the `ExportBundle` interface declares them, and `JSON.stringify` keeps that order. The file ends with one newline so a diff stays clean.

## Types that cross the boundary

Two rules hold everywhere in the bundle, and both come from the database layer. The serialiser does not touch either.

Every id, snowflake, and uuid is a **string**. A snowflake is 64 bits of information in a 19-digit number, which is past the point where a JavaScript number is exact. A consumer that parses one with `Number()` and compares it to another number has already lost the id.

Every 64-bit permission bitfield is a **decimal string**. `permissions`, `allow`, and `deny` are all bitfields, and a bitfield above 2^53 loses digits the moment it becomes a number. The widest value Discord uses is `9223372036854775807`.

Timestamps are ISO-8601 strings. json columns are parsed objects, not escaped strings: `embeds_json`, `attachments_json`, `role_ids_json` and the rest hold real json, so a reader does not have to parse a string inside a string.

## The asset directory

`backup.json` holds urls. The bytes live on disk, in the tree beside it:

```
<export dir>/
  backup.json
  assets/
    guild/      the icon, banner, splash, and discovery splash
    role/       one file per role icon
    emoji/      one file per custom emoji
    sticker/    one file per sticker
    sound/      one file per soundboard sound
    attachment/ one file per message attachment
```

The urls are signed and expire. A backup that stores bare urls restores blank icons six months later, so the capture downloads the bytes at capture time and stores the path next to the url. An attachment row carries both: `url` is the CDN url the bytes came from, `path` is where they landed, relative to the backup's own directory.

A file that was over the ceiling, already gone, or not a CDN url is not an error. The row keeps its url, `path` is null, and the capture records a skip so the backup says which attachment it could not preserve instead of dropping it in silence. The ceiling is `MAX_ASSET_BYTES`, 8 MiB by default. Setting it to `0` records every asset and downloads none.

## Known-lossy

Stated plainly, so nobody discovers it during a recovery. Three lists: what is never captured, what is captured but never put back, and what is captured but comes back different.

### Never captured

- **Voice and stage states.** Who is connected to which voice channel, and the state of a stage instance. Ephemeral by nature, and the capture reads no voice state endpoint.
- **Presences, typing, and read states.** Discord does not expose them.
- **Guild features.** Verified, partnered, vanity URL, discovery. The capture reads the vanity URL and throws it away, and a bot cannot set any of these on the target.
- **Invites.** There is no invite step in the capture. The invite list is not in the bundle.
- **The guild's audit log.** No capture step reads it.
- **Snapback's own settings for the guild.** The include set, the auto-backup schedule, the log channel, and the admin list live in `guilds.settings_json` and are not in the bundle. The bundle carries the guild's Discord-side settings, not the bot's configuration.

### Captured, but not restored

- **Member avatars.** `avatar_url` holds the CDN url and the bytes are downloaded, but the member phase only patches roles, nickname, and timeout. No avatar is uploaded on restore. A member's default avatar is not stored at all: the capture writes `null` rather than guessing Discord's default, and Discord computes it from the user id.
- **Reactions.** `reactions_json` holds them. The webhook payload the restore posts carries content, embeds, attachments, the display name, and the avatar, and no reactions.
- **Pins.** `pinned` is a column on the message row. The restore does not pin anything.
- **Message stickers and components.** `stickers_json` and `components_json` are captured and stored, and the restore does not send them. A bot cannot re-attach a sticker to a message it posts, and the components of a captured interactive message are not replayed.
- **The widget.** `widget_json` is captured. The restore does not enable a widget on the target.
- **A ban's message-deletion window.** The ban row holds the user, the name, and the reason. The reason is restored. `delete_message_seconds` is always sent as `0`, because the source's window is not captured.

### Restored, but changed

- **Message timestamps.** Discord stamps a webhook message when it is posted, and a webhook's timestamp cannot be forged. The original times are in `created_at`, and the optional `restore_message_timestamp_suffix` appends a relative-timestamp line to the content instead. It is off by default because it changes the message.
- **Reply chains.** A reply points at a message whose id changed, so it cannot be rethreaded. The relationship is in `reference_json` and the message type is 19, so a reader can see it, and the restore posts the reply as a plain message and says so in the report.
- **Message ids.** Every restored message has a new id. Nothing that referenced an old id can be rewired.
- **Message authors.** The messages are posted by a webhook named `Snapback`. It carries the author's nickname, display name, or username, and the author's avatar, but hovering shows the webhook.
- **Mentions.** Every replayed message is posted with `allowed_mentions: { parse: [] }`. A restored message never pings anybody, including the person it was addressed to.
- **Expired attachment urls.** An attachment over the size ceiling, or one whose signed url had already expired at capture time, is stored with a url and no path. The restore reports it as not re-uploaded and posts the message without it.
- **Guild features and several guild settings.** The restore applies the verification level, the explicit content filter, the default notification setting, the preferred locale, the system channel flags, and the afk channel with its timeout. The other captured settings are not sent: the system channel, the rules channel, the public updates channel, the safety alerts channel, and the premium tier.
- **Bot-managed roles.** A role an integration owns cannot be created or deleted by a bot. The capture records it with `is_bot_managed`, `bot_id`, and `integration_id`. The restore re-links it to the managed role in the target that has the same name and the same application, and reports it as not restorable when there is no match.
- **Members the target guild does not have.** A bot cannot add a member. Every member who is not already in the target is counted and named in the report and left out. Adding one needs a `guilds.join` token the person granted, which is the pull engine and a separate consent flow.
- **Member roles.** A role is matched by name, because a name is the only thing two guilds can share. A role the target does not have is dropped, with a note. In sync mode the member ends with exactly the backup's roles and the roles the backup does not know about are taken away; in the other two modes those roles stay.
- **Member nicknames.** Only applied in modes 2 and 3, and truncated to Discord's 32 characters.
- **Member timeouts.** A timeout whose stored time is in the past is not sent, because sending it would clear the timeout rather than set one. A timeout longer than 28 days is clamped to 28 days.
- **Channel names.** A name is lowercased, its spaces become dashes, and the reserved characters are removed before the create: `@`, `#`, `:`, a backtick, `/`, `\`, and `|`. The restore says which characters went.
- **Channel positions.** The position is sent in the create body, so the final order is Discord's to keep.
- **Voice channel bitrate.** Clamped to the target guild's boost tier: 64, 128, 256, or 384 kbps. The user limit is clamped to 99, and a stage channel's to 50.
- **Threads.** An announcement thread is skipped, because its first message would have to exist before the thread does and the messages phase runs last. An auto-archive duration that is not one of 60, 1440, 4320, or 10080 minutes is snapped to the nearest. An archived thread is re-archived, but the archive timestamp is the restore time, because Discord does not accept an old one.
- **Emoji and sticker slots.** Capped by the target's boost tier: 50, 100, 150, or 250 emoji, and 0, 5, 15, or 30 stickers. A guild with no boost tier gets no sticker slots at all.
- **Role icons.** Applied only when the target guild has the `ROLE_ICONS` feature.
- **Automod rules.** Exempt roles and channels are remapped to the target's ids, and a rule whose exempt role or channel is not in the target is created without it.
- **Scheduled events.** The event is recreated with its name, description, times, privacy level, and entity type. The status is not restored, because a recreated event is a new event. The entity metadata is captured whole, but the restore sends only the type and the channel, so a recurring event's recurrence rule and its location are dropped.
- **Onboarding and the welcome screen.** The default channels and the welcome channels are remapped to the target's ids, and one that is not in the target is dropped. A target that is not a Community guild has no onboarding, and the request is refused with a note.
- **Guild and role images.** Applied only when the bytes are in the backup's asset directory. A file that is not there is a note, never a failed restore.
- **The afk channel.** Resolved through the channel map. A channel that is not in the target leaves the target's own afk channel alone.
- **Message types.** Only the types in `backup_message_types` are captured. The default is the three that are conversation: 0, 19, and 20. A join, a boost, or a thread-created message is filtered out on purpose, so it is not a skip.

### What a restore cannot undo

A restore replaces the target's contents with the backup's. It is not reversible. The target guild holds what the backup held, and the members it could not add are still missing.
