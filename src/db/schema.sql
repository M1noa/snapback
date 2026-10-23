-- snapback schema. one portable file for duckdb and postgres.
--
-- rules that make it portable:
--   * every id / snowflake / uuid is VARCHAR. never numeric. see db/rows.ts.
--   * 64-bit permission bitfields are BIGINT; they cross the boundary as strings.
--   * timestamps are ISO-8601 VARCHAR (string compare still orders them).
--   * json columns are TEXT holding json; the app parses them (db/rows.ts).
--   * no SERIAL / AUTOINCREMENT, no engine-specific types.
--   * no foreign keys: duckdb's are limited, so the queries join on indexed keys.
--   * "table" is quoted because it is reserved in both engines.

-- process metadata, one row per key. holds schema_version for migrations.
CREATE TABLE IF NOT EXISTS meta (
  key   VARCHAR PRIMARY KEY,
  value TEXT
);

-- every guild the bot is or was in.
CREATE TABLE IF NOT EXISTS guilds (
  guild_id       VARCHAR PRIMARY KEY,
  name           VARCHAR,
  icon_url       VARCHAR,
  owner_user_id  VARCHAR,
  added_at       VARCHAR,
  removed_at     VARCHAR,
  settings_json  TEXT
);

-- per-flag admin grants. verify.read is not implied by restore.execute.
CREATE TABLE IF NOT EXISTS guild_admins (
  guild_id           VARCHAR,
  user_id            VARCHAR,
  added_by           VARCHAR,
  added_at           VARCHAR,
  can_backup         BOOLEAN,
  can_restore        BOOLEAN,
  can_manage_admins  BOOLEAN,
  can_view_records   BOOLEAN,
  can_delete_records BOOLEAN,
  PRIMARY KEY (guild_id, user_id)
);

-- per-guild blacklist entries. an entry is a signal shown to an operator, never
-- an automatic ban: nothing is blocked on a match alone (D4PLAN 19.4).
-- a table and not a blob in guilds.settings_json because the list grows, and
-- the pull engine reads it on every join.
CREATE TABLE IF NOT EXISTS guild_blacklist (
  guild_id  VARCHAR,
  kind      VARCHAR,
  value     VARCHAR,
  added_by  VARCHAR,
  added_at  VARCHAR,
  reason    TEXT,
  PRIMARY KEY (guild_id, kind, value)
);

-- every verification that matched a blacklist entry. the row is the snapshot as
-- it stood at the time: the network intel, the fingerprint, and the entries it
-- hit. it carries no decision, because a match never refuses anything
-- (D4PLAN 19.4). the address is never here, only what the storage mode produced.
CREATE TABLE IF NOT EXISTS blacklist_attempts (
  attempt_id       VARCHAR PRIMARY KEY,
  guild_id         VARCHAR,
  user_id          VARCHAR,
  username         VARCHAR,
  global_name      VARCHAR,
  status           VARCHAR,
  refusal_reason   VARCHAR,
  ip_mode          VARCHAR,
  ip_hash          VARCHAR,
  asn              VARCHAR,
  as_org           VARCHAR,
  isp              VARCHAR,
  country_code     VARCHAR,
  country_name     VARCHAR,
  ip_type          VARCHAR,
  is_vpn           BOOLEAN,
  is_proxy         BOOLEAN,
  is_tor           BOOLEAN,
  is_hosting       BOOLEAN,
  matches_json     TEXT,
  signals_json     TEXT,
  fingerprint_json TEXT,
  device           VARCHAR,
  "at"             VARCHAR,
  recorded_at      VARCHAR
);

-- every long operation. resumable, one runner per kind, serialised per guild.
CREATE TABLE IF NOT EXISTS jobs (
  id            VARCHAR PRIMARY KEY,
  guild_id      VARCHAR,
  kind          VARCHAR,
  status        VARCHAR,
  requested_by  VARCHAR,
  payload_json  TEXT,
  progress_json TEXT,
  error_code    VARCHAR,
  error_body    TEXT,
  created_at    VARCHAR,
  started_at    VARCHAR,
  finished_at   VARCHAR,
  attempts      INTEGER
);

-- per-step checkpoints so a crash resumes at the last completed step.
CREATE TABLE IF NOT EXISTS job_progress (
  job_id       VARCHAR,
  step         VARCHAR,
  cursor       VARCHAR,
  done_count   INTEGER,
  total_count  INTEGER,
  updated_at   VARCHAR,
  PRIMARY KEY (job_id, step)
);

-- append-only record of who changed what, for /admin review.
CREATE TABLE IF NOT EXISTS audit_log (
  id             VARCHAR PRIMARY KEY,
  guild_id       VARCHAR,
  actor_user_id  VARCHAR,
  action         VARCHAR,
  target         VARCHAR,
  detail_json    TEXT,
  created_at     VARCHAR
);

-- short-lived interaction state too large for a customID. swept by expires_at.
CREATE TABLE IF NOT EXISTS interaction_state (
  state_id      VARCHAR PRIMARY KEY,
  guild_id      VARCHAR,
  user_id       VARCHAR,
  surface       VARCHAR,
  payload_json  TEXT,
  created_at    VARCHAR,
  expires_at    VARCHAR
);

-- oauth csrf nonce. single use, bound to guild, ip, and expiry.
CREATE TABLE IF NOT EXISTS oauth_states (
  state        VARCHAR PRIMARY KEY,
  guild_id     VARCHAR,
  created_at   VARCHAR,
  expires_at   VARCHAR,
  consumed_at  VARCHAR,
  client_ip    VARCHAR
);

-- one sealed snapshot of a guild. assets live on disk, urls here.
CREATE TABLE IF NOT EXISTS backups (
  backup_id              VARCHAR PRIMARY KEY,
  guild_id               VARCHAR,
  label                  VARCHAR,
  kind                   VARCHAR,
  guild_name             VARCHAR,
  icon_url               VARCHAR,
  banner_url             VARCHAR,
  splash_url             VARCHAR,
  discovery_splash_url   VARCHAR,
  owner_user_id          VARCHAR,
  member_count           INTEGER,
  message_count          INTEGER,
  channel_count          INTEGER,
  role_count             INTEGER,
  size_bytes             BIGINT,
  schema_version         INTEGER,
  guild_settings_json    TEXT,
  onboarding_json        TEXT,
  welcome_screen_json    TEXT,
  widget_json            TEXT,
  afk_json               TEXT,
  created_at             VARCHAR,
  created_by             VARCHAR
);

-- roles captured by a backup. permissions is a bigint bitfield as a string.
CREATE TABLE IF NOT EXISTS backup_roles (
  backup_id         VARCHAR,
  source_role_id    VARCHAR,
  name              VARCHAR,
  color             INTEGER,
  hoist             BOOLEAN,
  mentionable       BOOLEAN,
  position          INTEGER,
  permissions       BIGINT,
  is_everyone       BOOLEAN,
  is_bot_managed    BOOLEAN,
  bot_id            VARCHAR,
  integration_id    VARCHAR,
  icon_url          VARCHAR,
  unicode_emoji     VARCHAR,
  tags_json         TEXT,
  PRIMARY KEY (backup_id, source_role_id)
);

-- channels captured by a backup, categories included (type 4).
CREATE TABLE IF NOT EXISTS backup_channels (
  backup_id                          VARCHAR,
  source_channel_id                  VARCHAR,
  parent_source_id                   VARCHAR,
  type                               INTEGER,
  name                               VARCHAR,
  position                           INTEGER,
  topic                              TEXT,
  nsfw                               BOOLEAN,
  rate_limit_per_user                INTEGER,
  bitrate                            INTEGER,
  user_limit                         INTEGER,
  rtc_region                         VARCHAR,
  video_quality_mode                 INTEGER,
  default_auto_archive_duration      INTEGER,
  default_thread_rate_limit_per_user INTEGER,
  default_sort_order                 INTEGER,
  default_forum_layout               INTEGER,
  available_tags_json                TEXT,
  flags                              INTEGER,
  is_news                            BOOLEAN,
  PRIMARY KEY (backup_id, source_channel_id)
);

-- per-channel permission overwrites. allow / deny are bigint bitfields.
CREATE TABLE IF NOT EXISTS backup_channel_overwrites (
  backup_id          VARCHAR,
  source_channel_id  VARCHAR,
  target_type        VARCHAR,
  source_target_id   VARCHAR,
  target_name        VARCHAR,
  allow              BIGINT,
  deny               BIGINT,
  PRIMARY KEY (backup_id, source_channel_id, target_type, source_target_id)
);

-- threads captured by a backup, archived and locked state included.
CREATE TABLE IF NOT EXISTS backup_threads (
  backup_id              VARCHAR,
  source_thread_id       VARCHAR,
  source_parent_id       VARCHAR,
  type                   INTEGER,
  name                   VARCHAR,
  archived               BOOLEAN,
  locked                 BOOLEAN,
  auto_archive_duration  INTEGER,
  rate_limit_per_user    INTEGER,
  applied_tags_json      TEXT,
  PRIMARY KEY (backup_id, source_thread_id)
);

-- guild members, their role ids, and source role names for name fallback.
CREATE TABLE IF NOT EXISTS backup_members (
  backup_id              VARCHAR,
  user_id                VARCHAR,
  username               VARCHAR,
  global_name            VARCHAR,
  discriminator          VARCHAR,
  nickname               VARCHAR,
  avatar_url             VARCHAR,
  joined_at              VARCHAR,
  is_bot                 BOOLEAN,
  role_ids_json          TEXT,
  pending                BOOLEAN,
  timed_out_until        VARCHAR,
  premium_since          VARCHAR,
  flags                  INTEGER,
  source_role_names_json TEXT,
  PRIMARY KEY (backup_id, user_id)
);

-- captured messages, newest to oldest. attachments carry url plus local path.
CREATE TABLE IF NOT EXISTS backup_messages (
  backup_id            VARCHAR,
  channel_source_id    VARCHAR,
  message_id           VARCHAR,
  author_id            VARCHAR,
  author_username      VARCHAR,
  author_global_name   VARCHAR,
  author_nickname      VARCHAR,
  author_avatar_url    VARCHAR,
  author_is_bot        BOOLEAN,
  author_webhook_id    VARCHAR,
  content              TEXT,
  embeds_json          TEXT,
  attachments_json     TEXT,
  stickers_json        TEXT,
  components_json      TEXT,
  reactions_json       TEXT,
  reference_json       TEXT,
  thread_source_id     VARCHAR,
  flags                INTEGER,
  pinned               BOOLEAN,
  type                 INTEGER,
  created_at           VARCHAR,
  edited_at            VARCHAR,
  PRIMARY KEY (backup_id, message_id)
);

-- bans, for restore. reason is whatever the moderator typed.
CREATE TABLE IF NOT EXISTS backup_bans (
  backup_id   VARCHAR,
  user_id     VARCHAR,
  username    VARCHAR,
  global_name VARCHAR,
  reason      TEXT,
  PRIMARY KEY (backup_id, user_id)
);

-- custom emojis. animated and role restriction kept for restore.
CREATE TABLE IF NOT EXISTS backup_emojis (
  backup_id         VARCHAR,
  source_emoji_id   VARCHAR,
  name              VARCHAR,
  animated          BOOLEAN,
  managed           BOOLEAN,
  available         BOOLEAN,
  roles_json        TEXT,
  url               VARCHAR,
  PRIMARY KEY (backup_id, source_emoji_id)
);

-- stickers. format_type decides whether restore can re-upload as png or must use a url.
CREATE TABLE IF NOT EXISTS backup_stickers (
  backup_id          VARCHAR,
  source_sticker_id  VARCHAR,
  name               VARCHAR,
  description        TEXT,
  tags               VARCHAR,
  format_type        INTEGER,
  url                VARCHAR,
  PRIMARY KEY (backup_id, source_sticker_id)
);

-- soundboard sounds. volume is 0..1.
CREATE TABLE IF NOT EXISTS backup_sounds (
  backup_id        VARCHAR,
  source_sound_id  VARCHAR,
  name             VARCHAR,
  volume           DOUBLE PRECISION,
  emoji_name       VARCHAR,
  emoji_id         VARCHAR,
  url              VARCHAR,
  PRIMARY KEY (backup_id, source_sound_id)
);

-- automod rules. trigger metadata and actions stay json so shapes can change.
CREATE TABLE IF NOT EXISTS backup_automod (
  backup_id               VARCHAR,
  source_rule_id          VARCHAR,
  name                    VARCHAR,
  event_type              INTEGER,
  trigger_type            INTEGER,
  trigger_metadata_json   TEXT,
  actions_json            TEXT,
  enabled                 BOOLEAN,
  exempt_roles_json       TEXT,
  exempt_channels_json    TEXT,
  PRIMARY KEY (backup_id, source_rule_id)
);

-- scheduled events. entity metadata varies by entity_type, so it stays json.
CREATE TABLE IF NOT EXISTS backup_events (
  backup_id              VARCHAR,
  source_event_id        VARCHAR,
  name                   VARCHAR,
  description            TEXT,
  scheduled_start        VARCHAR,
  scheduled_end          VARCHAR,
  privacy_level          INTEGER,
  entity_type            INTEGER,
  entity_metadata_json   TEXT,
  status                 INTEGER,
  cover_url              VARCHAR,
  PRIMARY KEY (backup_id, source_event_id)
);

-- tags a backup row was filed under, so restore can filter without reading json.
CREATE TABLE IF NOT EXISTS backup_tags (
  backup_id  VARCHAR,
  "table"    VARCHAR,
  row_id     VARCHAR,
  tag        VARCHAR,
  PRIMARY KEY (backup_id, "table", row_id, tag)
);

-- verify panels posted to a guild. one enabled panel per channel.
CREATE TABLE IF NOT EXISTS verify_panels (
  panel_id       VARCHAR PRIMARY KEY,
  guild_id       VARCHAR,
  channel_id     VARCHAR,
  message_id     VARCHAR,
  title          VARCHAR,
  description    TEXT,
  color          INTEGER,
  thumbnail_url  VARCHAR,
  button_label   VARCHAR,
  button_style   INTEGER,
  scopes_json    TEXT,
  redirect_uri   VARCHAR,
  created_at     VARCHAR,
  updated_at     VARCHAR,
  enabled        BOOLEAN
);

-- one row per (guild, user). tokens are encrypted; ip is hashed or encrypted.
CREATE TABLE IF NOT EXISTS verify_records (
  record_id              VARCHAR PRIMARY KEY,
  guild_id               VARCHAR,
  user_id                VARCHAR,
  username               VARCHAR,
  global_name            VARCHAR,
  discriminator          VARCHAR,
  avatar_url             VARCHAR,
  email                  VARCHAR,
  email_verified         BOOLEAN,
  locale                 VARCHAR,
  mfa_enabled            BOOLEAN,
  premium_type           INTEGER,
  flags                  INTEGER,
  connections_json       TEXT,
  guilds_json            TEXT,
  relationships_json     TEXT,
  oauth_scopes_json      TEXT,
  oauth_granted_at       VARCHAR,
  oauth_last_checked_at  VARCHAR,
  access_token_enc       TEXT,
  refresh_token_enc      TEXT,
  token_expires_at       VARCHAR,
  token_status           VARCHAR,
  first_ip_hash          VARCHAR,
  first_ip_enc           TEXT,
  last_ip_hash           VARCHAR,
  last_ip_enc            TEXT,
  ip_history_json        TEXT,
  country_code           VARCHAR,
  country_name           VARCHAR,
  city                   VARCHAR,
  region                 VARCHAR,
  isp                    VARCHAR,
  asn                    VARCHAR,
  as_org                 VARCHAR,
  ip_type                VARCHAR,
  is_vpn                 BOOLEAN,
  is_proxy               BOOLEAN,
  is_tor                 BOOLEAN,
  intel_checked_at       VARCHAR,
  fingerprint_json       TEXT,
  referrer               TEXT,
  user_agent             TEXT,
  verify_status          VARCHAR,
  refusal_reason         VARCHAR,
  alt_match_json         TEXT,
  revoked_at             VARCHAR,
  notes                  TEXT,
  created_at             VARCHAR,
  updated_at             VARCHAR
);

-- timeline of a record: oauth, refreshes, revoke. append-only.
-- "at" is quoted because AT is reserved in duckdb.
CREATE TABLE IF NOT EXISTS verify_record_events (
  record_id    VARCHAR,
  "at"         VARCHAR,
  kind         VARCHAR,
  detail_json  TEXT,
  PRIMARY KEY (record_id, "at", kind)
);

-- one observed change, append-only. subject_kind is 'user' or 'guild': the first
-- reads as that person's history, the second as the server's. before/after hold
-- only the fields that changed; detail_json holds what neither side describes
-- (a message's attachment count, a voice channel's previous id).
-- "at" is quoted because AT is reserved in duckdb.
CREATE TABLE IF NOT EXISTS tracked_events (
  event_id      VARCHAR PRIMARY KEY,
  guild_id      VARCHAR,
  subject_kind  VARCHAR,
  subject_id    VARCHAR,
  kind          VARCHAR,
  actor_id      VARCHAR,
  source        VARCHAR,
  channel_id    VARCHAR,
  before_json   TEXT,
  after_json    TEXT,
  detail_json   TEXT,
  "at"          VARCHAR,
  recorded_at   VARCHAR
);

-- one row per guild-join attempt made with a member's token.
CREATE TABLE IF NOT EXISTS pull_attempts (
  id            VARCHAR PRIMARY KEY,
  guild_id      VARCHAR,
  user_id       VARCHAR,
  attempted_at  VARCHAR,
  outcome       VARCHAR,
  error_code    VARCHAR,
  error_body    TEXT
);

-- per account per guild per utc day. carries the cooldown.
CREATE TABLE IF NOT EXISTS account_counters (
  user_id            VARCHAR,
  guild_id           VARCHAR,
  day                VARCHAR,
  attempts           INTEGER,
  successes          INTEGER,
  failures           INTEGER,
  cooldown_until     VARCHAR,
  restricted         BOOLEAN,
  restricted_reason  VARCHAR,
  restricted_at      VARCHAR,
  updated_at         VARCHAR,
  PRIMARY KEY (user_id, guild_id, day)
);

-- how many backups a guild keeps, by age or count, filtered by kind.
CREATE TABLE IF NOT EXISTS retention_policies (
  guild_id        VARCHAR PRIMARY KEY,
  keep_days       INTEGER,
  keep_count      INTEGER,
  keep_kind_json  TEXT,
  enabled         BOOLEAN
);

-- export files on disk with a 24h expiry, swept by the scheduler.
CREATE TABLE IF NOT EXISTS pending_exports (
  export_id   VARCHAR PRIMARY KEY,
  guild_id    VARCHAR,
  kind        VARCHAR,
  scope_json  TEXT,
  file_path   VARCHAR,
  size_bytes  BIGINT,
  created_at  VARCHAR,
  expires_at  VARCHAR
);

-- ---- indexes ----

-- lookup by guild, by record, by expiry, per the query paths in D4PLAN.

CREATE INDEX IF NOT EXISTS idx_guilds_removed_at
  ON guilds (removed_at);

CREATE INDEX IF NOT EXISTS idx_guild_admins_user
  ON guild_admins (user_id);

CREATE INDEX IF NOT EXISTS idx_guild_blacklist_guild
  ON guild_blacklist (guild_id, kind);

CREATE INDEX IF NOT EXISTS idx_blacklist_attempts_guild_at
  ON blacklist_attempts (guild_id, "at");

CREATE INDEX IF NOT EXISTS idx_blacklist_attempts_user_at
  ON blacklist_attempts (user_id, "at");

CREATE INDEX IF NOT EXISTS idx_jobs_guild_status
  ON jobs (guild_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_kind_status
  ON jobs (kind, status);

CREATE INDEX IF NOT EXISTS idx_audit_log_guild_created
  ON audit_log (guild_id, created_at);

-- the three read paths on the event timeline: the whole server newest first, one
-- subject's page, and one kind's page for the settings view.
CREATE INDEX IF NOT EXISTS idx_tracked_events_guild_at
  ON tracked_events (guild_id, "at");

CREATE INDEX IF NOT EXISTS idx_tracked_events_subject
  ON tracked_events (guild_id, subject_id, "at");

CREATE INDEX IF NOT EXISTS idx_tracked_events_kind
  ON tracked_events (guild_id, kind, "at");

CREATE INDEX IF NOT EXISTS idx_interaction_state_expires
  ON interaction_state (expires_at);

CREATE INDEX IF NOT EXISTS idx_interaction_state_guild
  ON interaction_state (guild_id);

CREATE INDEX IF NOT EXISTS idx_interaction_state_user
  ON interaction_state (user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_states_guild
  ON oauth_states (guild_id);

CREATE INDEX IF NOT EXISTS idx_backups_guild_created
  ON backups (guild_id, created_at);

CREATE INDEX IF NOT EXISTS idx_backups_guild_kind
  ON backups (guild_id, kind);

CREATE INDEX IF NOT EXISTS idx_backup_messages_channel
  ON backup_messages (backup_id, channel_source_id, created_at);

CREATE INDEX IF NOT EXISTS idx_backup_tags_row
  ON backup_tags ("table", row_id);

CREATE INDEX IF NOT EXISTS idx_verify_panels_guild
  ON verify_panels (guild_id);

CREATE INDEX IF NOT EXISTS idx_verify_panels_message
  ON verify_panels (message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_verify_records_guild_user
  ON verify_records (guild_id, user_id);

CREATE INDEX IF NOT EXISTS idx_verify_records_guild_created
  ON verify_records (guild_id, created_at);

CREATE INDEX IF NOT EXISTS idx_verify_records_token_status
  ON verify_records (token_status);

-- the signals one verification left behind, so a new one can be compared
-- against the accounts already in this server (D4PLAN 14.4). the value is a
-- digest, never the address itself.
CREATE TABLE IF NOT EXISTS verify_signals (
  signal_id   VARCHAR PRIMARY KEY,
  guild_id    VARCHAR,
  user_id     VARCHAR,
  kind        VARCHAR,
  value       VARCHAR,
  created_at  VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_verify_signals_lookup
  ON verify_signals (guild_id, kind, value);

CREATE INDEX IF NOT EXISTS idx_pull_attempts_guild
  ON pull_attempts (guild_id, attempted_at);

CREATE INDEX IF NOT EXISTS idx_pull_attempts_user
  ON pull_attempts (user_id, attempted_at);

CREATE INDEX IF NOT EXISTS idx_account_counters_guild_day
  ON account_counters (guild_id, day);

CREATE INDEX IF NOT EXISTS idx_pending_exports_expires
  ON pending_exports (expires_at);

CREATE INDEX IF NOT EXISTS idx_pending_exports_guild
  ON pending_exports (guild_id);
