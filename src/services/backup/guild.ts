// services/backup/guild.ts. D4PLAN 11 steps 1 and 2, plus the welcome screen
// (step 10): the guild's own settings and images.
//
// the welcome screen lives here rather than in a step of its own because it
// depends on nothing another step writes, and one request is cheaper than one
// module. services/backup/index.ts keeps the plan's order everywhere it matters.

import { getBackup, updateBackup } from "../../db/queries/backups.ts";
import type { BackupRow, JsonObject } from "../../db/types.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import type { BackupContext, Capture } from "./types.ts";
import { skipFor } from "./types.ts";

interface RawGuild {
  id: string;
  name: string;
  icon?: string | null;
  banner?: string | null;
  splash?: string | null;
  discovery_splash?: string | null;
  owner_id?: string | null;
  afk_channel_id?: string | null;
  afk_timeout?: number | null;
  features?: string[];
  // the behaviour settings a restore puts back (D4PLAN 11 step 1).
  verification_level?: number;
  explicit_content_filter?: number;
  default_message_notifications?: number;
  preferred_locale?: string | null;
  system_channel_id?: string | null;
  system_channel_flags?: number;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
  safety_alerts_channel_id?: string | null;
  premium_tier?: number;
}

interface RawWidget {
  enabled?: boolean;
  channel_id?: string | null;
}

// a hash with no segment is no asset: discord omits the field rather than sending
// an empty one, and a guild simply not having a banner is not a skip.
function guildAsset(id: string, hash: string | null, segment: string): string | null {
  if (hash === null || hash === "") return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/${segment}/${id}/${hash}.${ext}`;
}

// the guild-side values the plan lists for step 1, kept exactly as discord sent
// them. the bot's own per-guild settings are a different thing and live in
// guilds.settings_json; this column is what a restore re-applies to a new guild.
function guildSettings(raw: RawGuild): JsonObject {
  return {
    verification_level: raw.verification_level ?? null,
    explicit_content_filter: raw.explicit_content_filter ?? null,
    default_message_notifications: raw.default_message_notifications ?? null,
    preferred_locale: raw.preferred_locale ?? null,
    system_channel_id: raw.system_channel_id ?? null,
    system_channel_flags: raw.system_channel_flags ?? null,
    rules_channel_id: raw.rules_channel_id ?? null,
    public_updates_channel_id: raw.public_updates_channel_id ?? null,
    safety_alerts_channel_id: raw.safety_alerts_channel_id ?? null,
    premium_tier: raw.premium_tier ?? null,
  };
}

export const captureGuild: Capture = async (ctx) => {
  const guild = await ctx.client.request<RawGuild>({
    method: "GET",
    route: `/guilds/${ctx.guildId}`,
  });

  const existing = await getBackup(ctx.db, ctx.backupId);
  if (existing === null) {
    // the pipeline inserts the row before the first step, so this only happens if
    // something deleted it mid-capture. that is fatal, and it is ours, not discord's.
    throw new Error(`SB_BACKUP_MISSING: no backup row ${ctx.backupId} to write the guild into`);
  }

  const icon = guildAsset(guild.id, guild.icon ?? null, "icons");
  const banner = guildAsset(guild.id, guild.banner ?? null, "banners");
  const splash = guildAsset(guild.id, guild.splash ?? null, "splashes");
  const discovery = guildAsset(guild.id, guild.discovery_splash ?? null, "discovery-splashes");

  const row: BackupRow = {
    ...existing,
    guild_name: guild.name,
    icon_url: icon,
    banner_url: banner,
    splash_url: splash,
    discovery_splash_url: discovery,
    owner_user_id: guild.owner_id ?? null,
    guild_settings_json: guildSettings(guild),
    // afk is the guild object's own pair of fields, not a request of its own.
    afk_json: {
      afk_channel_id: guild.afk_channel_id ?? null,
      afk_timeout: guild.afk_timeout ?? null,
    } as unknown as JsonObject,
  };

  // the widget endpoint needs no permission beyond being in the guild.
  const widget = await optional<RawWidget>(ctx, `/guilds/${ctx.guildId}/widget`, "widget");
  if (widget !== null) row.widget_json = widget as unknown as JsonObject;

  // [v] discord errors rather than returning null for a guild with no welcome
  // screen, so a failure here means "this guild has no welcome screen": one skip,
  // never a reason to fail the capture (D4PLAN 11 step 10).
  const welcome = await optional<Record<string, unknown>>(
    ctx,
    `/guilds/${ctx.guildId}/welcome-screen`,
    "welcome screen",
  );
  if (welcome !== null) {
    row.welcome_screen_json = {
      ...welcome,
      // the flag decides whether the screen shows at all and the endpoint does not
      // carry it, so it is captured alongside.
      welcome_screen_enabled: (guild.features ?? []).includes("WELCOME_SCREEN_ENABLED"),
    } as unknown as JsonObject;
  }

  // the vanity url and the guild features are read for the record only: discord
  // will not let a bot set either, and the schema has no column for them (11.1).
  await optional<Record<string, unknown>>(ctx, `/guilds/${ctx.guildId}/vanity-url`, "vanity url");

  await updateBackup(ctx.db, row);

  // store every row first, then the bytes: a failed download leaves the url on the
  // row, which a restore reports, rather than a row that never landed (5.1).
  await saveAsset(ctx, "icon", icon);
  await saveAsset(ctx, "banner", banner);
  await saveAsset(ctx, "splash", splash);
  await saveAsset(ctx, "discovery_splash", discovery);

  await ctx.checkpoint("guild", { done: 1, total: 1 });
  return { written: 1 };
};

async function saveAsset(ctx: BackupContext, name: string, url: string | null): Promise<void> {
  if (url !== null) await ctx.assets.save("guild", name, url);
}

// a read that is allowed to fail: the skip carries discord's own words and the
// step carries on. none of these endpoints is worth losing a backup over, and
// none of them is a bug of ours either, so a non-discord error still throws.
async function optional<T>(ctx: BackupContext, route: string, what: string): Promise<T | null> {
  try {
    return await ctx.client.request<T>({ method: "GET", route });
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    ctx.skips.add(skipFor("guild", what, error));
    return null;
  }
}
