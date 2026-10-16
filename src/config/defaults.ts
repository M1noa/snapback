// the shape and the defaults of everything an owner edits from discord. these
// live in guilds.settings_json, not in .env, so /setup can change them without a
// redeploy (D4PLAN 6.1, 7.2, 10).
//
// one table describes each field: its default, and how to read a stored value
// back. a stored row may predate a key, carry one we dropped, or hold a value
// someone edited by hand, so every read goes through the field's own reader and
// a wrong shape falls back to the default rather than reaching the app.

import {
  boundedText,
  clampInt,
  normaliseHex,
  oneOf,
  type Range,
  snowflake,
} from "../lib/validate.ts";

/** one step of the setup wizard, as persisted. `at` is an iso timestamp. */
export interface WizardStepState {
  readonly done: boolean;
  readonly skipped: boolean;
  readonly at: string | null;
}

/** wizard progress, stored under `wizard` (D4PLAN 10). `current` is the step key
 *  the wizard opens at, so a partial setup resumes where it stopped. */
export interface WizardState {
  readonly version: number;
  readonly current: string;
  readonly steps: Readonly<Record<string, WizardStepState>>;
  readonly started_at: string | null;
  readonly done_at: string | null;
}

/** the verification panel the wizard builds (D4PLAN 10.3). `button_mode` is the
 *  one place a classic embed is still allowed (D4PLAN 9.5). */
export interface VerifyPanelSettings {
  readonly channel_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly colour: string; // #rrggbb
  readonly thumbnail_url: string | null;
  readonly button_label: string;
  readonly button_style: "link" | "primary";
  readonly button_url: string | null;
  readonly button_mode: "components" | "embed";
  readonly scopes: readonly string[];
  readonly redirect_target: string | null;
}

/** branding is applied to the bot user, not stored here. only the flags are,
 *  because the image bytes live on discord once applied and would bloat every
 *  guild read if they were kept in settings_json. */
export interface BrandingSettings {
  readonly display_name: string | null;
  readonly avatar_set: boolean;
  readonly banner_set: boolean;
}

export interface GuildSettings {
  ephemeral_default: boolean;
  log_channel_id: string | null;
  /** enabled log-channel families, from LOG_EVENT_FAMILIES (D4PLAN 16). */
  log_events: readonly string[];
  auto_backup_enabled: boolean;
  auto_backup_interval_hours: number;
  auto_backup_message_count: number;
  auto_restore_enabled: boolean;
  restore_clear_before: boolean;
  restore_message_timestamp_suffix: boolean;
  notify_on_join: boolean;
  wizard: WizardState;
  /** the panel is also the switch: no panel means verification is not in use, so
   *  the wizard does not ask for its three steps (D4PLAN 10.1). */
  verify_panel: VerifyPanelSettings | null;
  /** iso timestamp of the restricted-scope acknowledgement (D4PLAN 7.2). */
  acknowledged_restricted_scopes: string | null;
  /** the sentence the verify page shows about what is captured. null means the
   *  shipped default is used, so an operator never has to write it. */
  privacy_disclosure_text: string | null;
  branding: BrandingSettings;
}

// the numeric ranges /setup and /admin clamp to. the defaults above sit inside
// them, and a hand-edited row is clamped on read as well as on write.
export const LIMITS = Object.freeze({
  auto_backup_interval_hours: { min: 1, max: 168 } as Range,
  auto_backup_message_count: { min: 0, max: 10_000 } as Range,
});

export const DEFAULT_WIZARD: Readonly<WizardState> = Object.freeze({
  version: 1,
  current: "welcome",
  steps: Object.freeze({}),
  started_at: null,
  done_at: null,
});

export const DEFAULT_BRANDING: Readonly<BrandingSettings> = Object.freeze({
  display_name: null,
  avatar_set: false,
  banner_set: false,
});

export const DEFAULT_VERIFY_PANEL: Readonly<VerifyPanelSettings> = Object.freeze({
  channel_id: null,
  title: "verify to continue",
  description: "verify with discord to get access to this server.",
  colour: "#5865f2",
  thumbnail_url: null,
  button_label: "Verify",
  button_style: "primary",
  button_url: null,
  button_mode: "components",
  scopes: Object.freeze(["identify", "email", "guilds.join"]),
  redirect_target: null,
});

/** the log-channel families, each toggleable in /setup logs (D4PLAN 16). */
export const LOG_EVENT_FAMILIES = Object.freeze([
  "lifecycle",
  "backup",
  "restore",
  "verify",
  "pull",
  "admin",
  "error",
] as const);

export type LogEventFamily = (typeof LOG_EVENT_FAMILIES)[number];

/** the three ip storage modes, mirroring the IP_STORAGE env values (D4PLAN 14.5). */
export const IP_STORAGE_MODES = Object.freeze(["hash", "encrypted", "plaintext"] as const);

export interface Field<T> {
  readonly default: T;
  /** a stored value in the wrong shape becomes the default, never a coercion. */
  readonly read: (value: unknown) => T;
}

function bool(fallback: boolean): Field<boolean> {
  return { default: fallback, read: (v) => (typeof v === "boolean" ? v : fallback) };
}

// a snowflake or nothing. a number or a bigint here is the classic driver bug
// (AGENTS.md rule 3), so it is rejected rather than stringified.
function nullableId(): Field<string | null> {
  return { default: null, read: (v) => snowflake(v) };
}

function nullableIso(): Field<string | null> {
  return {
    default: null,
    read: (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null),
  };
}

function int(fallback: number, range: Range): Field<number> {
  return { default: fallback, read: (v) => clampInt(v, range) ?? fallback };
}

function textList(allowed: readonly string[]): Field<readonly string[]> {
  return {
    default: allowed,
    read: (v) => {
      if (!Array.isArray(v)) return allowed;
      const kept = v.filter(
        (item): item is string => typeof item === "string" && allowed.includes(item),
      );
      return Object.freeze([...new Set(kept)]);
    },
  };
}

function freeTextList(fallback: readonly string[]): Field<readonly string[]> {
  return {
    default: fallback,
    read: (v) => {
      if (!Array.isArray(v)) return fallback;
      const kept = v.filter((item): item is string => typeof item === "string");
      return Object.freeze([...new Set(kept)]);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readWizardState(stored: unknown): WizardState {
  if (!isRecord(stored)) return { ...DEFAULT_WIZARD, steps: {} };
  const rawSteps = isRecord(stored.steps) ? stored.steps : {};
  const steps: Record<string, WizardStepState> = {};
  for (const [key, value] of Object.entries(rawSteps)) {
    if (!isRecord(value)) continue;
    steps[key] = {
      done: value.done === true,
      skipped: value.skipped === true,
      at: typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) ? value.at : null,
    };
  }
  return {
    version: typeof stored.version === "number" ? stored.version : DEFAULT_WIZARD.version,
    current:
      typeof stored.current === "string" && stored.current !== "" ? stored.current : "welcome",
    steps,
    started_at: nullableIso().read(stored.started_at),
    done_at: nullableIso().read(stored.done_at),
  };
}

function readVerifyPanel(stored: unknown): VerifyPanelSettings | null {
  if (!isRecord(stored)) return null;
  const buttonStyle = oneOf(stored.button_style, ["link", "primary"] as const);
  const buttonMode = oneOf(stored.button_mode, ["components", "embed"] as const);
  return {
    ...DEFAULT_VERIFY_PANEL,
    channel_id: snowflake(stored.channel_id),
    title: boundedText(stored.title, 256) ?? DEFAULT_VERIFY_PANEL.title,
    description: boundedText(stored.description, 2000) ?? DEFAULT_VERIFY_PANEL.description,
    colour: normaliseHex(stored.colour) ?? DEFAULT_VERIFY_PANEL.colour,
    thumbnail_url: urlOrNull(stored.thumbnail_url),
    button_label: boundedText(stored.button_label, 80) ?? DEFAULT_VERIFY_PANEL.button_label,
    button_style: buttonStyle ?? DEFAULT_VERIFY_PANEL.button_style,
    button_url: urlOrNull(stored.button_url),
    button_mode: buttonMode ?? DEFAULT_VERIFY_PANEL.button_mode,
    scopes: freeTextList(DEFAULT_VERIFY_PANEL.scopes).read(stored.scopes),
    redirect_target: urlOrNull(stored.redirect_target),
  };
}

function readBranding(stored: unknown): BrandingSettings {
  if (!isRecord(stored)) return { ...DEFAULT_BRANDING };
  return {
    display_name: boundedText(stored.display_name, 32),
    avatar_set: stored.avatar_set === true,
    banner_set: stored.banner_set === true,
  };
}

function urlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https:\/\/\S+$/.test(trimmed) ? trimmed : null;
}

// one entry per field. typed against GuildSettings, so adding a field without a
// default is a type error rather than a silent hole in the stored row.
export const FIELDS: {
  readonly [K in keyof GuildSettings]: Field<GuildSettings[K]>;
} = {
  ephemeral_default: bool(true),
  log_channel_id: nullableId(),
  log_events: textList(LOG_EVENT_FAMILIES),
  auto_backup_enabled: bool(false),
  auto_backup_interval_hours: int(24, LIMITS.auto_backup_interval_hours),
  auto_backup_message_count: int(1000, LIMITS.auto_backup_message_count),
  auto_restore_enabled: bool(false),
  restore_clear_before: bool(false),
  restore_message_timestamp_suffix: bool(false),
  notify_on_join: bool(false),
  wizard: { default: DEFAULT_WIZARD, read: readWizardState },
  verify_panel: { default: null, read: readVerifyPanel },
  acknowledged_restricted_scopes: nullableIso(),
  privacy_disclosure_text: {
    default: null,
    read: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 2000) : null),
  },
  branding: { default: DEFAULT_BRANDING, read: readBranding },
};

export const DEFAULT_GUILD_SETTINGS: Readonly<GuildSettings> = Object.freeze(
  Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => [key, field.default]),
  ) as unknown as GuildSettings,
);

/** a stored row merged over the defaults. unknown keys are dropped: the wizard
 *  and the panel are declared fields, so nothing legitimate is stored outside
 *  this table, and keeping a dropped key forever is how a settings blob rots. */
export function readGuildSettings(stored: unknown): GuildSettings {
  const base = { ...DEFAULT_GUILD_SETTINGS } as GuildSettings;
  if (!isRecord(stored)) return base;
  const out = base as unknown as Record<string, unknown>;
  for (const [key, field] of Object.entries(FIELDS) as [keyof GuildSettings, Field<unknown>][]) {
    out[key] = field.read((stored as Record<string, unknown>)[key]);
  }
  return out as unknown as GuildSettings;
}

/** the stored row for a patch, with every field read back through its reader.
 *  one path in, so a clamped or rejected value can never bypass validation. */
export function mergeGuildSettings(
  current: GuildSettings,
  patch: Partial<GuildSettings>,
): GuildSettings {
  return readGuildSettings({ ...current, ...patch });
}
