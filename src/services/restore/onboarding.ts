// the onboarding and welcome screen phase (D4PLAN 12.2 step 8). both reference
// channels, so they run after the channels exist.
//
// a target guild that is not a Community guild has no onboarding at all, and
// asking for it is a 404: that is a note, not a failure.

import { getBackup } from "../../db/queries/backups.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestorePhase } from "./types.ts";

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

export const restoreOnboarding: RestorePhase = async (ctx) => {
  if (!ctx.options.onboarding) return phaseOk(0);
  const backup = await getBackup(ctx.db, ctx.backupId);
  if (backup === null) return phaseOk(0);
  const notes: { what: string; why: string }[] = [];

  const onboarding = backup.onboarding_json as {
    prompts?: unknown[];
    default_channel_ids?: string[];
    mode?: number;
    enabled?: boolean;
  } | null;
  if (onboarding !== null && onboarding !== undefined) {
    // the default channels are source ids: they are resolved through the map, and
    // one that is not in the target is dropped with a note.
    const defaultChannels: string[] = [];
    for (const source of onboarding.default_channel_ids ?? []) {
      const target = ctx.maps.channels.get(String(source));
      if (target === undefined) {
        notes.push({
          what: `a default channel (${String(source)})`,
          why: "it is not in the target",
        });
        continue;
      }
      defaultChannels.push(target);
    }
    try {
      await ctx.client.request({
        method: "PUT",
        route: `/guilds/${ctx.targetGuildId}/onboarding`,
        body: {
          prompts: onboarding.prompts ?? [],
          default_channel_ids: defaultChannels,
          mode: onboarding.mode ?? 0,
          enabled: onboarding.enabled === true,
        },
      });
    } catch (error) {
      notes.push({ what: "the onboarding prompts", why: why(error) });
    }
  }

  const welcome = backup.welcome_screen_json as {
    description?: string;
    welcome_channels?: { channel_id?: string; description?: string }[];
  } | null;
  if (welcome !== null && welcome !== undefined) {
    const channels = [];
    for (const entry of welcome.welcome_channels ?? []) {
      const target = ctx.maps.channels.get(String(entry.channel_id ?? ""));
      if (target === undefined) {
        notes.push({ what: "a welcome channel", why: "it is not in the target" });
        continue;
      }
      channels.push({ channel_id: target, description: entry.description ?? "" });
    }
    try {
      await ctx.client.request({
        method: "PATCH",
        route: `/guilds/${ctx.targetGuildId}/welcome-screen`,
        body: { enabled: true, welcome_channels: channels, description: welcome.description ?? "" },
      });
    } catch (error) {
      // a guild that is not a Community guild has no welcome screen: a note.
      notes.push({ what: "the welcome screen", why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(1, notes);
};
