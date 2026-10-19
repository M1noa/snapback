// the category and channel phases (D4PLAN 12.2 steps 4 and 5, D4TODO phase 6).
//
// categories go first, so a channel's parent is already in the id map by the
// time the channel phase runs. a parent that is not in the map means the
// channel is created at the top level, with a note (12.8).
//
// a name is sanitised before the create rather than after a refusal: the rules
// are discord's own, so the create is more likely to be accepted first time,
// and the note says which characters went (12.8). a bitrate is clamped into the
// target guild's boost tier instead of a hardcoded number (12.4), and a channel
// the target already has under the same parent is edited rather than duplicated.

import { listBackupChannelsByBackup } from "../../db/queries/backup-channels.ts";
import type { BackupChannelRow } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { type PhaseResult, phaseOk, type RestoreContext, type RestorePhase } from "./types.ts";

const GUILD_TEXT = 0;
const GUILD_VOICE = 2;
const GUILD_CATEGORY = 4;
const GUILD_ANNOUNCEMENT = 5;
const GUILD_STAGE = 13;
const GUILD_FORUM = 15;
const GUILD_MEDIA = 16;

/** the guild channel types the restore creates. threads are not guild channels. */
const CREATABLE_TYPES: readonly number[] = [
  GUILD_TEXT,
  GUILD_VOICE,
  GUILD_ANNOUNCEMENT,
  GUILD_STAGE,
  GUILD_FORUM,
  GUILD_MEDIA,
];

/** the types that carry an nsfw flag. the others always answer false. */
const NSFW_TYPES: readonly number[] = [GUILD_TEXT, GUILD_VOICE, GUILD_ANNOUNCEMENT, GUILD_STAGE];

/** the types that carry a slowmode. */
const SLOWMODE_TYPES: readonly number[] = [
  GUILD_TEXT,
  GUILD_ANNOUNCEMENT,
  GUILD_STAGE,
  GUILD_FORUM,
  GUILD_MEDIA,
];

/** the types whose threads carry an auto-archive duration. */
const AUTO_ARCHIVE_TYPES: readonly number[] = [
  GUILD_TEXT,
  GUILD_ANNOUNCEMENT,
  GUILD_FORUM,
  GUILD_MEDIA,
];

/** the voice bitrate ceiling, by the target guild's boost tier (12.4). */
const BITRATE_CEILINGS = [64000, 128000, 256000, 384000] as const;

/** discord's own floor for a voice channel. */
const MIN_BITRATE = 8000;

/**
 * the characters discord reserves in a name: # and : open a link, @ opens a
 * mention, and / \ | are path separators.
 */
const RESERVED_CHARS = new Set(["@", "#", ":", "`", "/", "\\", "|"]);

/** what a channel looks like in the target guild, as far as the restore reads it. */
interface TargetChannel {
  id: string;
  name?: string | null;
  type?: number;
  parent_id?: string | null;
}

interface SanitisedName {
  readonly name: string;
  /** what went, in the operator's words. */
  readonly changes: readonly string[];
}

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

/** the boost tier index of a guild, 0 to 3. */
function tierOf(premiumTier: number): number {
  if (premiumTier >= 3) return 3;
  if (premiumTier === 2) return 2;
  if (premiumTier === 1) return 1;
  return 0;
}

/** the bitrate a voice channel may carry in a guild at this boost tier (12.4). */
function clampBitrate(bitrate: number, tier: number): number {
  const ceiling = BITRATE_CEILINGS[tier] ?? BITRATE_CEILINGS[0];
  return Math.min(Math.max(bitrate, MIN_BITRATE), ceiling);
}

/**
 * the user limit for the channel type. a voice channel takes 0 for no limit and
 * up to 99; a stage channel tops out at 50 (12.4).
 */
function clampUserLimit(type: number, value: number): number {
  if (type === GUILD_STAGE) return Math.min(Math.max(value, 0), 50);
  return Math.min(Math.max(value, 0), 99);
}

/** lowercase, spaces to dashes, the reserved characters out (12.8). */
function sanitiseName(raw: string): SanitisedName {
  const lowered = raw.toLowerCase();
  const removed: string[] = [];

  let name = lowered.replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  name = [...name].filter((char) => !RESERVED_CHARS.has(char)).join("");
  for (const char of lowered) {
    if (RESERVED_CHARS.has(char) && !removed.includes(char)) removed.push(char);
  }

  const changes: string[] = [];
  if (/\s/.test(lowered)) changes.push("spaces were replaced with dashes");
  if (raw !== lowered) changes.push("the name was lowercased");
  for (const char of removed) changes.push(`the reserved character ${char} was removed`);
  return { name, changes };
}

/** the body discord takes for a create or an edit of this channel. */
function buildBody(
  row: BackupChannelRow,
  name: string,
  parentId: string | null,
  tier: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name, position: row.position, parent_id: parentId };

  if (row.topic !== null) body.topic = row.topic;
  if (NSFW_TYPES.includes(row.type)) body.nsfw = row.nsfw;

  if (SLOWMODE_TYPES.includes(row.type) && row.rate_limit_per_user !== null) {
    body.rate_limit_per_user = row.rate_limit_per_user;
  }

  if (row.type === GUILD_VOICE || row.type === GUILD_STAGE) {
    if (row.bitrate !== null) body.bitrate = clampBitrate(row.bitrate, tier);
    if (row.user_limit !== null) body.user_limit = clampUserLimit(row.type, row.user_limit);
  }
  if (row.type === GUILD_VOICE) {
    if (row.rtc_region !== null) body.rtc_region = row.rtc_region;
    if (row.video_quality_mode !== null) body.video_quality_mode = row.video_quality_mode;
  }

  if (AUTO_ARCHIVE_TYPES.includes(row.type) && row.default_auto_archive_duration !== null) {
    body.default_auto_archive_duration = row.default_auto_archive_duration;
  }

  if (row.type === GUILD_FORUM || row.type === GUILD_MEDIA) {
    if (row.default_thread_rate_limit_per_user !== null) {
      body.default_thread_rate_limit_per_user = row.default_thread_rate_limit_per_user;
    }
    if (row.default_sort_order !== null) body.default_sort_order = row.default_sort_order;
    if (row.available_tags_json !== null && row.available_tags_json.length > 0) {
      // the tag ids travel as they are: the thread phase applies tags by id,
      // and a new id would break that reference.
      body.available_tags = row.available_tags_json;
    }
  }
  if (row.type === GUILD_FORUM && row.default_forum_layout !== null) {
    body.default_forum_layout = row.default_forum_layout;
  }

  return body;
}

/** the target guild's own channels, for the same-name reuse. */
async function targetChannels(
  ctx: RestoreContext,
  notes: { what: string; why: string }[],
): Promise<TargetChannel[]> {
  try {
    return await ctx.client.request<TargetChannel[]>({
      method: "GET",
      route: `/guilds/${ctx.targetGuildId}/channels`,
    });
  } catch (error) {
    // without the list the restore cannot tell a new channel from an existing
    // one, so it creates and lets discord refuse a duplicate.
    notes.push({ what: "the target guild's channels", why: why(error) });
    return [];
  }
}

/** the boost tier of the target guild, read once. */
async function targetTier(
  ctx: RestoreContext,
  notes: { what: string; why: string }[],
): Promise<number> {
  try {
    const guild = await ctx.client.request<{ premium_tier?: number }>({
      method: "GET",
      route: `/guilds/${ctx.targetGuildId}`,
    });
    return tierOf(guild.premium_tier ?? 0);
  } catch (error) {
    // the lowest tier is the safe guess: a lower ceiling never sends a bitrate
    // the target cannot carry.
    notes.push({ what: "the target guild", why: why(error) });
    return 0;
  }
}

/** a channel that carries a bitrate, so the tier matters. */
function carriesBitrate(row: BackupChannelRow): boolean {
  if (row.bitrate === null) return false;
  return row.type === GUILD_VOICE || row.type === GUILD_STAGE;
}

/** the type this restore creates, or null when no phase can create it. */
function creatableType(type: number): number | null {
  if (type === GUILD_CATEGORY) return GUILD_CATEGORY;
  if (CREATABLE_TYPES.includes(type)) return type;
  return null;
}

async function runChannelPhase(
  ctx: RestoreContext,
  types: readonly number[],
): Promise<PhaseResult> {
  const rows = await listBackupChannelsByBackup(ctx.db, ctx.backupId);
  const wanted = rows.filter((row) => types.includes(row.type));
  if (wanted.length === 0) return phaseOk(0);

  const notes: { what: string; why: string }[] = [];
  let count = 0;

  const existing = await targetChannels(ctx, notes);
  let tier: Promise<number> | null = null;
  const boostTier = (): Promise<number> => {
    tier ??= targetTier(ctx, notes);
    return tier;
  };

  for (const row of rows) {
    if (types.includes(row.type) === false) {
      // another phase has this one, or no phase can create it.
      if (creatableType(row.type) === null) {
        notes.push({
          what: `the channel "${row.name ?? row.source_channel_id}"`,
          why: `discord has no guild channel of type ${row.type}, so it was not created`,
        });
      }
      continue;
    }

    const label = row.type === GUILD_CATEGORY ? "category" : "channel";
    const rawName = row.name ?? "";
    const what = `the ${label} "${rawName}"`;
    const name = sanitiseName(rawName);

    if (name.name === "") {
      // nothing usable came out of the sanitiser, so the original goes and
      // discord says what it thinks of it.
      notes.push({
        what,
        why: "the name could not be sanitised into anything discord accepts, so it was sent as it was",
      });
    } else if (name.changes.length > 0) {
      notes.push({
        what,
        why: `the name was sent as "${name.name}": ${name.changes.join(", ")}`,
      });
    }
    const sentName = name.name === "" ? rawName : name.name;

    // the parent. a category is always at the top level.
    let parentId: string | null = null;
    if (row.parent_source_id !== null && row.type !== GUILD_CATEGORY) {
      const mapped = ctx.maps.channels.get(row.parent_source_id);
      if (mapped === undefined) {
        notes.push({
          what,
          why: "its parent category was not created in the target, so it was created at the top level",
        });
      } else {
        parentId = mapped;
      }
    }

    const tierNow = carriesBitrate(row) ? await boostTier() : 0;
    const body = buildBody(row, sentName, parentId, tierNow);

    // a channel the target already has under the same parent is edited, not
    // duplicated (12.1 says the operator chose to overwrite same-name channels).
    const reuse =
      sentName === ""
        ? undefined
        : existing.find(
            (channel) =>
              (channel.parent_id ?? null) === parentId &&
              sanitiseName(channel.name ?? "").name === sentName,
          );

    if (reuse !== undefined) {
      try {
        await ctx.client.request({
          method: "PATCH",
          route: `/channels/${reuse.id}`,
          body,
        });
        ctx.maps.channels.set(row.source_channel_id, reuse.id);
        count += 1;
        notes.push({
          what,
          why: "the target already had a channel with that name under the same parent, so it was edited instead of a second one being created",
        });
      } catch (error) {
        notes.push({ what, why: why(error) });
      }
      continue;
    }

    try {
      const created = await ctx.client.request<{ id: string }>({
        method: "POST",
        route: `/guilds/${ctx.targetGuildId}/channels`,
        body: { ...body, type: row.type },
      });
      ctx.maps.channels.set(row.source_channel_id, created.id);
      count += 1;
      existing.push({ id: created.id, name: sentName, parent_id: parentId });
    } catch (error) {
      notes.push({ what, why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
}

/** the category phase (12.2 step 4). it runs before the channels. */
export const restoreCategories: RestorePhase = async (ctx) => {
  if (!ctx.options.channels) return phaseOk(0);
  return await runChannelPhase(ctx, [GUILD_CATEGORY]);
};

/** the non-category channel phase (12.2 step 5). */
export const restoreChannels: RestorePhase = async (ctx) => {
  if (!ctx.options.channels) return phaseOk(0);
  return await runChannelPhase(ctx, CREATABLE_TYPES);
};
