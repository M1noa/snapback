// the contract db/duckdb.ts and db/postgres.ts both satisfy, plus the row type
// for every table in D4PLAN 5.1. nothing in the app talks to a driver directly.
//
// field names mirror the snake_case columns on purpose: a row is the wire shape
// and a mapping layer to camelCase would be pure noise. snowflakes are strings,
// never numbers. 64-bit bitfields cross as strings too.

import type { GuildSettings } from "../config/defaults.ts";

/** a value a driver will bind as a parameter. undefined must become null first. */
export type SqlParam = string | number | bigint | boolean | null;

/** what every driver exposes. keep this small; both engines fit through it. */
export interface Database {
  readonly kind: "duckdb" | "postgres";
  query<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  run(sql: string, params?: SqlParam[]): Promise<void>;
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

// json columns come back parsed (db/rows.ts). shapes that vary run to run stay
// loose; a fixed shape gets a real type.
export type JsonObject = Record<string, unknown>;
export type JsonValue = JsonObject | unknown[] | string | number | boolean | null;

export type JobStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
export type JobKind = "backup" | "restore" | "pull" | "verify_refresh" | "export";
export type BackupKind = "manual" | "auto" | "pre_restore";
export type TokenStatus = "valid" | "unauthorized" | "revoked" | "refused" | "missing";
export type IpType =
  | "residential"
  | "hosting"
  | "mobile"
  | "business"
  | "education"
  | "government"
  | "unknown";
export type OverwriteTargetType = "role" | "member";
export type PullOutcome = "added" | "already_member" | "failed" | "skipped";
export type RecordEventKind =
  | "oauth"
  | "refresh"
  | "revoked"
  | "refreshed_ok"
  | "refreshed_fail"
  | "refused"
  | "note";

/** how a verification ended (D4PLAN 14.4). */
export type VerifyStatus = "verified" | "refused";

/** the signals one verification left behind, used to spot another account. */
export type VerifySignalKind = "device" | "ip" | "email" | "avatar" | "name";
export type ExportKind = "backup" | "records" | "all";

/** how many backups a guild keeps, by age or count, filtered by kind (17.2). */
export interface RetentionRow {
  guild_id: string;
  keep_days: number | null;
  keep_count: number | null;
  keep_kind_json: BackupKind[] | null;
  enabled: boolean;
}

/** process metadata. one row per key; holds schema_version for migrations. */
export interface MetaRow {
  key: string;
  value: string | null;
}

/** a guild the bot is or was in. */
export interface GuildRow {
  guild_id: string;
  name: string | null;
  icon_url: string | null;
  owner_user_id: string | null;
  added_at: string | null;
  removed_at: string | null;
  settings_json: GuildSettings | null;
}

/** what a blacklist entry names (D4PLAN 8). */
export type BlacklistKind = "user_id" | "ip_hash" | "asn";

/**
 * one per-guild blacklist entry. an entry is a signal shown to an operator.
 * nothing is blocked on a match alone (D4PLAN 19.4), so this row carries no
 * decision: it names something and says who put it there.
 */
export interface GuildBlacklistRow {
  guild_id: string;
  kind: BlacklistKind;
  value: string;
  added_by: string | null;
  added_at: string;
  reason: string | null;
}

/** per-flag admin grants. verify.read is not implied by restore.execute. */
export interface GuildAdminRow {
  guild_id: string;
  user_id: string;
  added_by: string | null;
  added_at: string | null;
  can_backup: boolean;
  can_restore: boolean;
  can_manage_admins: boolean;
  can_view_records: boolean;
  can_delete_records: boolean;
}

/** a long operation. resumable; one runner per kind, serialised per guild. */
export interface JobRow {
  id: string;
  guild_id: string;
  kind: JobKind;
  status: JobStatus;
  requested_by: string;
  payload_json: JsonObject | null;
  progress_json: JsonObject | null;
  error_code: string | null;
  error_body: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
}

/** per-step checkpoints so a crash resumes at the last completed step. */
export interface JobProgressRow {
  job_id: string;
  step: string;
  cursor: string | null;
  done_count: number;
  total_count: number;
  updated_at: string;
}

/** append-only record of who changed what. */
export interface AuditLogRow {
  id: string;
  guild_id: string;
  actor_user_id: string;
  action: string;
  target: string | null;
  detail_json: JsonObject | null;
  created_at: string;
}

/** short-lived interaction state too large for a customID. sweeps by expires_at. */
export interface InteractionStateRow {
  state_id: string;
  guild_id: string;
  user_id: string;
  surface: string;
  payload_json: JsonValue;
  created_at: string;
  expires_at: string;
}

/** oauth csrf nonce. single use, bound to guild, ip, and expiry. */
export interface OauthStateRow {
  state: string;
  guild_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  client_ip: string | null;
}

/** a backup's post-write self check (D4PLAN 11.6). null while the backup is open. */
export interface SelfCheck {
  /** false marks the backup incomplete; it still restores, with a warning. */
  ok: boolean;
  /** one line per broken invariant. */
  failures: string[];
  /** what the capture deliberately skipped, so "incomplete" is never a mystery. */
  skipped: Skip[];
}

/** one recorded skip, the shape services/backup/types.ts writes. declared here so
 *  the stored blob and the capture layer cannot drift. */
export interface Skip {
  category: string;
  what: string;
  why: string;
}

/** one sealed snapshot of a guild. assets live on disk; urls here. */
export interface BackupRow {
  backup_id: string;
  guild_id: string;
  label: string | null;
  kind: BackupKind;
  guild_name: string | null;
  icon_url: string | null;
  banner_url: string | null;
  splash_url: string | null;
  discovery_splash_url: string | null;
  owner_user_id: string | null;
  member_count: number;
  message_count: number;
  channel_count: number;
  role_count: number;
  size_bytes: number;
  schema_version: number;
  /**
   * the guild's own settings as discord returns them (D4PLAN 11 step 1), applied
   * on restore: verification level, content filter, notifications, locale, the
   * system channel pair. the bot's per-guild settings are a different thing and
   * live in guilds.settings_json.
   */
  guild_settings_json: JsonObject | null;
  onboarding_json: JsonObject | null;
  welcome_screen_json: JsonObject | null;
  widget_json: JsonObject | null;
  afk_json: JsonObject | null;
  self_check_json: SelfCheck | null;
  created_at: string;
  created_by: string;
}

/** roles captured by a backup. permissions is a bigint bitfield as a string. */
export interface BackupRoleRow {
  backup_id: string;
  source_role_id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  permissions: string;
  is_everyone: boolean;
  is_bot_managed: boolean;
  bot_id: string | null;
  integration_id: string | null;
  icon_url: string | null;
  unicode_emoji: string | null;
  tags_json: JsonObject | null;
}

/** channels captured by a backup, categories included (type 4). */
export interface BackupChannelRow {
  backup_id: string;
  source_channel_id: string;
  parent_source_id: string | null;
  type: number;
  name: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  rate_limit_per_user: number | null;
  bitrate: number | null;
  user_limit: number | null;
  rtc_region: string | null;
  video_quality_mode: number | null;
  default_auto_archive_duration: number | null;
  default_thread_rate_limit_per_user: number | null;
  default_sort_order: number | null;
  default_forum_layout: number | null;
  available_tags_json: JsonObject[] | null;
  flags: number | null;
  is_news: boolean | null;
}

/** per-channel permission overwrites. allow / deny are bigint bitfields. */
export interface BackupChannelOverwriteRow {
  backup_id: string;
  source_channel_id: string;
  target_type: OverwriteTargetType;
  source_target_id: string;
  target_name: string | null;
  allow: string;
  deny: string;
}

/** threads captured by a backup, archived and locked state included. */
export interface BackupThreadRow {
  backup_id: string;
  source_thread_id: string;
  source_parent_id: string;
  type: number;
  name: string;
  archived: boolean;
  locked: boolean;
  auto_archive_duration: number | null;
  rate_limit_per_user: number | null;
  applied_tags_json: string[] | null;
}

/** guild members, their role ids, and source role names for name fallback. */
export interface BackupMemberRow {
  backup_id: string;
  user_id: string;
  username: string;
  global_name: string | null;
  discriminator: string | null;
  nickname: string | null;
  avatar_url: string | null;
  joined_at: string | null;
  is_bot: boolean;
  role_ids_json: string[];
  pending: boolean;
  timed_out_until: string | null;
  premium_since: string | null;
  flags: number | null;
  source_role_names_json: string[];
}

/** captured messages, newest to oldest. attachments carry url plus local path. */
export interface BackupMessageRow {
  backup_id: string;
  channel_source_id: string;
  message_id: string;
  author_id: string;
  author_username: string;
  author_global_name: string | null;
  author_nickname: string | null;
  author_avatar_url: string | null;
  author_is_bot: boolean;
  author_webhook_id: string | null;
  content: string | null;
  embeds_json: JsonObject[] | null;
  attachments_json: JsonObject[] | null;
  stickers_json: JsonObject[] | null;
  components_json: JsonObject[] | null;
  reactions_json: JsonObject[] | null;
  reference_json: JsonObject | null;
  thread_source_id: string | null;
  flags: number | null;
  pinned: boolean;
  type: number;
  created_at: string;
  edited_at: string | null;
}

/** bans, for restore. */
export interface BackupBanRow {
  backup_id: string;
  user_id: string;
  username: string;
  global_name: string | null;
  reason: string | null;
}

/** custom emojis. */
export interface BackupEmojiRow {
  backup_id: string;
  source_emoji_id: string;
  name: string;
  animated: boolean;
  managed: boolean;
  available: boolean | null;
  roles_json: string[];
  url: string | null;
}

/** stickers. format_type decides whether restore can re-upload or must use a url. */
export interface BackupStickerRow {
  backup_id: string;
  source_sticker_id: string;
  name: string;
  description: string | null;
  tags: string | null;
  format_type: number;
  url: string | null;
}

/** soundboard sounds. volume is 0..1. */
export interface BackupSoundRow {
  backup_id: string;
  source_sound_id: string;
  name: string;
  volume: number | null;
  emoji_name: string | null;
  emoji_id: string | null;
  url: string | null;
}

/** automod rules. trigger metadata and actions stay json so shapes can change. */
export interface BackupAutomodRow {
  backup_id: string;
  source_rule_id: string;
  name: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata_json: JsonObject | null;
  actions_json: JsonObject[];
  enabled: boolean;
  exempt_roles_json: string[];
  exempt_channels_json: string[];
}

/** scheduled events. entity metadata varies by entity_type, so it stays json. */
export interface BackupEventRow {
  backup_id: string;
  source_event_id: string;
  name: string;
  description: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  privacy_level: number;
  entity_type: number;
  entity_metadata_json: JsonObject | null;
  status: number;
  cover_url: string | null;
}

/** tags a backup row was filed under, so restore can filter without reading json. */
export interface BackupTagRow {
  backup_id: string;
  table: string;
  row_id: string;
  tag: string;
}

/** verify panels posted to a guild. */
export interface VerifyPanelRow {
  panel_id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string | null;
  color: number;
  thumbnail_url: string | null;
  button_label: string;
  button_style: number;
  scopes_json: string[];
  redirect_uri: string;
  created_at: string;
  updated_at: string;
  enabled: boolean;
}

/** one row per (guild, user). tokens are encrypted; ip is hashed or encrypted. */
export interface VerifyRecordRow {
  record_id: string;
  guild_id: string;
  user_id: string;
  username: string | null;
  global_name: string | null;
  discriminator: string | null;
  avatar_url: string | null;
  email: string | null;
  email_verified: boolean | null;
  locale: string | null;
  mfa_enabled: boolean | null;
  premium_type: number | null;
  flags: number | null;
  connections_json: JsonObject[] | null;
  guilds_json: JsonObject[] | null;
  relationships_json: JsonObject[] | null;
  oauth_scopes_json: string[] | null;
  oauth_granted_at: string | null;
  oauth_last_checked_at: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  token_status: TokenStatus;
  first_ip_hash: string | null;
  first_ip_enc: string | null;
  last_ip_hash: string | null;
  last_ip_enc: string | null;
  ip_history_json: JsonObject[] | null;
  country_code: string | null;
  country_name: string | null;
  city: string | null;
  region: string | null;
  isp: string | null;
  asn: string | null;
  as_org: string | null;
  ip_type: IpType | null;
  is_vpn: boolean | null;
  is_proxy: boolean | null;
  is_tor: boolean | null;
  intel_checked_at: string | null;
  fingerprint_json: JsonObject | null;
  referrer: string | null;
  user_agent: string | null;
  /** how the last verification ended. */
  verify_status: VerifyStatus;
  /** why it was refused: "vpn" or "alt". */
  refusal_reason: string | null;
  /** the account it looks like, the confidence and the signals behind it. */
  alt_match_json: JsonObject | null;
  revoked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** one signal one verification left behind. */
export interface VerifySignalRow {
  signal_id: string;
  guild_id: string;
  user_id: string;
  kind: VerifySignalKind;
  value: string;
  created_at: string;
}

/** timeline of a record: oauth, refreshes, revoke. append-only. */
export interface VerifyRecordEventRow {
  record_id: string;
  at: string;
  kind: RecordEventKind;
  detail_json: JsonObject | null;
}

/** one row per guild-join attempt made with a member's token. */
export interface PullAttemptRow {
  id: string;
  guild_id: string;
  user_id: string;
  attempted_at: string;
  outcome: PullOutcome;
  error_code: string | null;
  error_body: string | null;
}

/** per account per guild per utc day. carries the cooldown. */
export interface AccountCounterRow {
  user_id: string;
  guild_id: string;
  day: string;
  attempts: number;
  successes: number;
  failures: number;
  cooldown_until: string | null;
  restricted: boolean;
  restricted_reason: string | null;
  restricted_at: string | null;
  updated_at: string;
}

/** how many backups a guild keeps, by age or count, filtered by kind. */
export interface RetentionPolicyRow {
  guild_id: string;
  keep_days: number | null;
  keep_count: number | null;
  keep_kind_json: string[] | null;
  enabled: boolean;
}

/** export files on disk with an expiry, swept by the scheduler. */
export interface PendingExportRow {
  export_id: string;
  guild_id: string;
  kind: ExportKind;
  scope_json: JsonObject | null;
  file_path: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}
