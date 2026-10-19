// the guild phase (D4PLAN 12.2 step 1). the guild's own settings and images go
// first, so an abort leaves a recognisable guild, and because the icon upload is
// the most likely thing to fail (12.8).
//
// the icon, the banner and the splash are data uris in the same patch as the
// rest, which is what discord accepts (12.3 says the same for a role icon).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBackup } from "../../db/queries/backups.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestoreContext, type RestorePhase } from "./types.ts";

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

/** the bytes of a stored asset as a data uri, or null when the file is gone. */
async function dataUri(ctx: RestoreContext, kind: string, name: string): Promise<string | null> {
  const directory = join(ctx.backupDir, ctx.backupId, "assets", kind);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    // the backup has no asset directory, or none for this kind.
    return null;
  }
  const file = files.find((entry) => entry.startsWith(name));
  if (file === undefined) return null;
  const bytes = await readFile(join(directory, file));
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const type = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  return `data:${type};base64,${bytes.toString("base64")}`;
}

export const restoreGuild: RestorePhase = async (ctx) => {
  const backup = await getBackup(ctx.db, ctx.backupId);
  if (backup === null) {
    return phaseOk(0, [{ what: "the guild settings", why: "the backup row is gone" }]);
  }
  if (!ctx.options.guild) return phaseOk(0);

  const settings = backup.guild_settings_json ?? {};
  const notes: { what: string; why: string }[] = [];

  // the afk and system channels are source ids: they are resolved through the
  // map, and one that is not in the target is left alone rather than guessed.
  const body: Record<string, unknown> = {};
  if (typeof settings.verification_level === "number")
    body.verification_level = settings.verification_level;
  if (typeof settings.explicit_content_filter === "number") {
    body.explicit_content_filter = settings.explicit_content_filter;
  }
  if (typeof settings.default_message_notifications === "number") {
    body.default_message_notifications = settings.default_message_notifications;
  }
  if (typeof settings.preferred_locale === "string")
    body.preferred_locale = settings.preferred_locale;
  if (typeof settings.system_channel_flags === "number")
    body.system_channel_flags = settings.system_channel_flags;

  const afk = backup.afk_json as {
    afk_channel_id?: string | null;
    afk_timeout?: number | null;
  } | null;
  const afkSource = afk?.afk_channel_id ?? null;
  if (afkSource !== null) {
    const target = ctx.maps.channels.get(afkSource);
    if (target !== undefined) {
      body.afk_channel_id = target;
      if (typeof afk?.afk_timeout === "number") body.afk_timeout = afk.afk_timeout;
    } else {
      notes.push({
        what: "the afk channel",
        why: "the channel it pointed at is not in the target",
      });
    }
  }

  try {
    await ctx.client.request({
      method: "PATCH",
      route: `/guilds/${ctx.targetGuildId}`,
      body,
    });
  } catch (error) {
    // a verification level the target does not allow, a locale it does not have:
    // a note, and the restore carries on (12.8).
    notes.push({ what: "the guild settings", why: why(error) });
  }

  // the images. each one is a note when it is missing, never a failed restore.
  for (const [name, key] of [
    ["icon", "icon"],
    ["banner", "banner"],
    ["splash", "splash"],
    ["discovery_splash", "discovery_splash"],
  ] as const) {
    const stored =
      backup[`${key}_url` as "icon_url" | "banner_url" | "splash_url" | "discovery_splash_url"];
    if (stored === null) continue;
    const uri = await dataUri(ctx, "guild", name);
    if (uri === null) {
      notes.push({
        what: `the guild ${name}`,
        why: "the file is not in the backup's asset directory",
      });
      continue;
    }
    try {
      await ctx.client.request({
        method: "PATCH",
        route: `/guilds/${ctx.targetGuildId}`,
        body: { [key]: uri },
      });
    } catch (error) {
      // an icon that is too large or an unsupported format: skip, note, continue.
      // never abort a whole restore for a banner (12.8).
      notes.push({ what: `the guild ${name}`, why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(1, notes);
};
