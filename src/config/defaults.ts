// defaults for the values an owner edits from Discord. they live in
// guilds.settings_json, not in .env, so /setup can change them without a redeploy.

// keys stay snake_case: this object is persisted verbatim and read by hand in
// SQL, next to snake_case columns. a mapping layer would buy nothing.
export interface GuildSettings {
  ephemeral_default: boolean;
  log_channel_id: string | null;
  auto_backup_enabled: boolean;
  auto_backup_interval_hours: number;
  auto_backup_message_count: number;
  auto_restore_enabled: boolean;
  restore_clear_before: boolean;
  restore_message_timestamp_suffix: boolean;
  notify_on_join: boolean;
}

export const DEFAULT_GUILD_SETTINGS: Readonly<GuildSettings> = Object.freeze({
  ephemeral_default: true,
  log_channel_id: null,
  auto_backup_enabled: false,
  auto_backup_interval_hours: 24,
  auto_backup_message_count: 1000,
  auto_restore_enabled: false,
  restore_clear_before: false,
  restore_message_timestamp_suffix: false,
  notify_on_join: false,
});

// a null default means the field holds a string when set, so it is the one case
// typeof alone cannot decide.
function accepts(fallback: unknown, value: unknown): boolean {
  if (fallback === null) return typeof value === "string";
  return typeof value === typeof fallback;
}

// a stored row may predate a key, or carry one we dropped. unknown keys are
// kept so a downgrade does not silently delete an owner's settings.
export function readGuildSettings(stored: unknown): GuildSettings {
  const base: GuildSettings = { ...DEFAULT_GUILD_SETTINGS };
  if (typeof stored !== "object" || stored === null) return base;
  const record = stored as Record<string, unknown>;

  for (const [key, fallback] of Object.entries(DEFAULT_GUILD_SETTINGS)) {
    const value = record[key];
    if (accepts(fallback, value)) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return base;
}
