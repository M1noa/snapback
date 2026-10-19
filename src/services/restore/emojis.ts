// the emoji, sticker and soundboard phase (D4PLAN 12.2 step 2). it runs before
// the roles, because a role icon and an automod action reference an emoji id.
//
// a guild's emoji slots are tier-capped, and a guild without the tier gets
// fewer: the cap is read from the target guild, not assumed.

import { listBackupEmojisByBackup } from "../../db/queries/backup-emojis.ts";
import { listBackupSoundsByBackup } from "../../db/queries/backup-sounds.ts";
import { listBackupStickersByBackup } from "../../db/queries/backup-stickers.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestorePhase } from "./types.ts";

/** how many static emoji a guild may hold, by boost tier. */
const EMOJI_SLOTS = [50, 100, 150, 250] as const;
const STICKER_SLOTS = [0, 5, 15, 30] as const;

/** the tier index of a target guild, from its premium tier. */
function tierOf(premiumTier: number): number {
  if (premiumTier >= 3) return 3;
  if (premiumTier === 2) return 2;
  if (premiumTier === 1) return 1;
  return 0;
}

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

export const restoreEmojis: RestorePhase = async (ctx) => {
  const emojis = await listBackupEmojisByBackup(ctx.db, ctx.backupId);
  const stickers = await listBackupStickersByBackup(ctx.db, ctx.backupId);
  const sounds = await listBackupSoundsByBackup(ctx.db, ctx.backupId);
  if (emojis.length === 0 && stickers.length === 0 && sounds.length === 0) {
    return phaseOk(0);
  }

  const target = await ctx.client.request<{ premium_tier?: number }>({
    method: "GET",
    route: `/guilds/${ctx.targetGuildId}`,
  });
  const tier = tierOf(target.premium_tier ?? 0);

  let count = 0;
  const notes: { what: string; why: string }[] = [];

  if (ctx.options.emojis) {
    const room = EMOJI_SLOTS[tier] ?? EMOJI_SLOTS[0];
    for (const emoji of emojis.slice(0, room)) {
      try {
        const created = await ctx.client.request<{ id: string }>({
          method: "POST",
          route: `/guilds/${ctx.targetGuildId}/emojis`,
          body: { name: emoji.name, image: emoji.url },
        });
        ctx.maps.emojis.set(emoji.source_emoji_id, created.id);
        count += 1;
      } catch (error) {
        // a name that is taken or a slot that is full: a note, and the rest go.
        notes.push({ what: `emoji ${emoji.name}`, why: why(error) });
      }
    }
    if (emojis.length > room) {
      notes.push({
        what: `${emojis.length - room} emoji(s)`,
        why: `the target guild has ${room} emoji slot(s) at its boost tier`,
      });
    }
  }

  if (ctx.options.stickers) {
    const room = STICKER_SLOTS[tier] ?? 0;
    for (const sticker of stickers.slice(0, room)) {
      try {
        await ctx.client.request({
          method: "POST",
          route: `/guilds/${ctx.targetGuildId}/stickers`,
          body: {
            name: sticker.name,
            description: sticker.description ?? "",
            tags: sticker.tags ?? "",
            file: sticker.url,
          },
        });
        count += 1;
      } catch (error) {
        notes.push({ what: `sticker ${sticker.name}`, why: why(error) });
      }
    }
    if (stickers.length > room) {
      notes.push({
        what: `${stickers.length - room} sticker(s)`,
        why: `the target guild has ${room} sticker slot(s) at its boost tier`,
      });
    }
  }

  if (ctx.options.sounds) {
    for (const sound of sounds) {
      try {
        await ctx.client.request({
          method: "POST",
          route: `/guilds/${ctx.targetGuildId}/soundboard-sounds`,
          body: { name: sound.name, sound: sound.url, volume: sound.volume ?? 1 },
        });
        count += 1;
      } catch (error) {
        notes.push({ what: `sound ${sound.name}`, why: why(error) });
      }
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
};
