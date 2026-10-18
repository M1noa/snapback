// services/backup/assets.ts (D4PLAN 11 steps 2, 4, 5, 6; D4PLAN 5.1).
//
// two things live here: the store that downloads a cdn url into this backup's
// assets/ directory, and the three optional asset categories (emojis, stickers,
// sounds). an endpoint that 403s, a url that expired, a file over the ceiling:
// none of those fail the backup. each becomes a recorded limitation and the run
// continues, so a partial backup is visibly partial rather than silently so
// (types.ts, D4PLAN 11.6).

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { insertBackupEmojis } from "../../db/queries/backup-emojis.ts";
import { insertBackupSounds } from "../../db/queries/backup-sounds.ts";
import { insertBackupStickers } from "../../db/queries/backup-stickers.ts";
import type { BackupEmojiRow, BackupSoundRow, BackupStickerRow, Skip } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { fetchCdn } from "../../lib/http.ts";
import type { Logger } from "../../lib/log.ts";
import {
  type AssetKind,
  type AssetStore,
  type BackupContext,
  type Capture,
  included,
  type StoredAsset,
} from "./types.ts";

const CDN_HOST = "cdn.discordapp.com";
const DEFAULT_EXT = ".bin";

// the one non-api fetch in the codebase is fetchCdn (AGENTS.md rule 6); the
// injectable seam is that function's type, so a test drives the store with
// known bytes and never touches the network.
export function createAssetStore(options: {
  dir: string;
  maxBytes: number;
  log?: Logger;
  fetchImpl?: typeof fetchCdn;
}): AssetStore {
  const dir = options.dir;
  const maxBytes = options.maxBytes;
  const log = options.log;
  const fetchImpl = options.fetchImpl ?? fetchCdn;

  // pure and deterministic: a row that stores only a url can still find the file
  // on disk, so save() and pathFor() must agree to the byte. there is no path
  // column on the asset tables (schema.sql, D4PLAN 5.1), only the url.
  function pathFor(kind: AssetKind, name: string, url: string): string {
    return `assets/${kind}/${name}${extensionFor(url)}`;
  }

  async function save(
    kind: AssetKind,
    name: string,
    url: string | null,
  ): Promise<StoredAsset | null> {
    // a null here is a recorded limitation, not an error: the caller's row keeps
    // the url, the blob is simply absent. the store never throws.
    try {
      if (url === null) return null;
      // 0 means record every asset and download none (parse-env MAX_ASSET_BYTES).
      if (maxBytes === 0) return null;
      if (!isCdnUrl(url)) return null;
      if (!isSafeName(name)) {
        // an asset name comes from a discord id; a separator or ".." would let it
        // escape the backup directory, which is a traversal.
        log?.warn("asset name rejected", { kind, name });
        return null;
      }

      const relative = pathFor(kind, name, url);
      const absolute = join(dir, relative);

      const response = await fetchImpl(url, { maxBytes });
      if (response.bytes.byteLength > maxBytes) return null;

      // write to a temp name in the same directory, then rename. a crash
      // mid-download leaves the temp file, never a half file that a restore
      // would upload as if it were complete.
      const temp = `${absolute}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(temp, response.bytes);
        renameSync(temp, absolute);
      } catch (error) {
        try {
          rmSync(temp, { force: true });
        } catch {
          // nothing to clean up; the temp write never landed.
        }
        log?.warn("asset write failed", { kind, name, reason: errorMessage(error) });
        return null;
      }

      return { url, path: relative, bytes: response.bytes.byteLength };
    } catch (error) {
      // a 404, a non-cdn host, an over-size body, or the fetch itself rejecting.
      log?.debug("asset download skipped", { kind, name, reason: errorMessage(error) });
      return null;
    }
  }

  return { dir, save, pathFor };
}

function extensionFor(url: string): string {
  let pathname: string;
  try {
    // .pathname already excludes the query string and the hash.
    pathname = new URL(url).pathname;
  } catch {
    return DEFAULT_EXT;
  }
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  // no dot, or a dot with nothing after it, is not an extension.
  return dot > 0 && dot < last.length - 1 ? last.slice(dot) : DEFAULT_EXT;
}

function isCdnUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // https only, and exactly the cdn host fetchCdn accepts.
    return parsed.protocol === "https:" && parsed.hostname === CDN_HOST;
  } catch {
    return false;
  }
}

function isSafeName(name: string): boolean {
  if (name === "") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return !name.includes("..");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// the skip's "why" is discord's own words, never a paraphrase (AGENTS.md rule 5).
function skipWhy(error: unknown): string {
  return error instanceof DiscordApiError ? formatDiscordError(error).said : errorMessage(error);
}

function skip(category: string, what: string, error: unknown): Skip {
  return { category, what, why: skipWhy(error) };
}

// --- emojis (D4PLAN 11 step 4) -------------------------------------------------

interface EmojiPayload {
  id: string;
  name: string;
  animated?: boolean;
  managed?: boolean;
  available?: boolean | null;
  roles?: string[];
}

export const captureEmojis: Capture = async (ctx: BackupContext) => {
  if (!included(ctx, "emojis")) return { written: 0 };

  let payload: EmojiPayload[];
  try {
    payload = await ctx.client.request<EmojiPayload[]>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/emojis`,
    });
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    ctx.skips.add(skip("emojis", "all custom emojis", error));
    return { written: 0 };
  }

  const rows: BackupEmojiRow[] = (Array.isArray(payload) ? payload : []).map((emoji) => ({
    backup_id: ctx.backupId,
    source_emoji_id: emoji.id,
    name: emoji.name,
    animated: emoji.animated === true,
    managed: emoji.managed === true,
    available: emoji.available ?? null,
    roles_json: emoji.roles ?? [],
    // .gif when animated, .png otherwise. the extension carries the format.
    url: emojiUrl(emoji.id, emoji.animated === true),
  }));

  // store every row first, then the bytes, one batch per table.
  await insertBackupEmojis(ctx.db, rows);
  for (const row of rows) {
    await ctx.assets.save("emoji", row.source_emoji_id, row.url);
  }
  return { written: rows.length };
};

function emojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`;
}

// --- stickers (D4PLAN 11 step 5) -----------------------------------------------

interface StickerPayload {
  id: string;
  name: string;
  description?: string | null;
  tags?: string | null;
  format_type: number;
}

// format_type decides both the derived url's extension and whether restore can
// re-upload the bytes as an image. 3 is a LOTTIE json, not an image.
const STICKER_EXTENSION: Readonly<Record<number, string>> = Object.freeze({
  1: "png",
  2: "apng",
  3: "json",
  4: "gif",
});

export const captureStickers: Capture = async (ctx: BackupContext) => {
  if (!included(ctx, "stickers")) return { written: 0 };

  let payload: StickerPayload[];
  try {
    payload = await ctx.client.request<StickerPayload[]>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/stickers`,
    });
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    ctx.skips.add(skip("stickers", "all stickers", error));
    return { written: 0 };
  }

  const rows: BackupStickerRow[] = (Array.isArray(payload) ? payload : []).map((sticker) => ({
    backup_id: ctx.backupId,
    source_sticker_id: sticker.id,
    name: sticker.name,
    description: sticker.description ?? null,
    tags: sticker.tags ?? null,
    format_type: sticker.format_type,
    // discord's sticker payload carries no url, so it is derived from the id and
    // format_type. there is nothing in the object to read it off.
    url: stickerUrl(sticker.id, sticker.format_type),
  }));

  await insertBackupStickers(ctx.db, rows);
  for (const row of rows) {
    await ctx.assets.save("sticker", row.source_sticker_id, row.url);
  }
  return { written: rows.length };
};

function stickerUrl(id: string, formatType: number): string {
  const ext = STICKER_EXTENSION[formatType] ?? "png";
  return `https://cdn.discordapp.com/stickers/${id}.${ext}`;
}

// --- soundboard sounds (D4PLAN 11 step 6) --------------------------------------

interface SoundPayload {
  sound_id: string;
  name: string;
  volume?: number | null;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

interface SoundListPayload {
  items?: SoundPayload[];
}

// there is no soundboard key in the include set (defaults.ts) and D4PLAN does not
// list it as a skip category, so sounds always capture. adding a setting nobody
// asked for would be the invention this avoids.
export const captureSounds: Capture = async (ctx: BackupContext) => {
  let payload: SoundListPayload;
  try {
    payload = await ctx.client.request<SoundListPayload>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/soundboard-sounds`,
    });
  } catch (error) {
    // a 403 here means the guild has soundboard sounds disabled. that is one
    // skip, not a failed backup.
    if (!(error instanceof DiscordApiError)) throw error;
    ctx.skips.add(skip("sounds", "all soundboard sounds", error));
    return { written: 0 };
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const rows: BackupSoundRow[] = items.map((sound) => ({
    backup_id: ctx.backupId,
    source_sound_id: sound.sound_id,
    name: sound.name,
    volume: sound.volume ?? null,
    emoji_name: sound.emoji_name ?? null,
    emoji_id: sound.emoji_id ?? null,
    // the sound object carries no url; the cdn path is the id with no extension.
    url: `https://cdn.discordapp.com/soundboard-sounds/${sound.sound_id}`,
  }));

  await insertBackupSounds(ctx.db, rows);
  for (const row of rows) {
    await ctx.assets.save("sound", row.source_sound_id, row.url);
  }
  return { written: rows.length };
};
