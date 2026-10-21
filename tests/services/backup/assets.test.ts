// tests/services/backup/assets.test.ts
//
// the asset store and the three asset categories (D4PLAN 11 steps 2, 4, 5, 6;
// 5.1). the store is driven with a real temp directory and an injected
// `fetchImpl`, so a test sees the bytes written but nothing touches the network.
// the emoji, sticker and sound captures run against a real duckdb and the fixture
// guild, and their rows are read back through the query modules.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteBackupEmojisByBackup,
  listBackupEmojisByBackup,
} from "../../../src/db/queries/backup-emojis.ts";
import {
  deleteBackupSoundsByBackup,
  listBackupSoundsByBackup,
} from "../../../src/db/queries/backup-sounds.ts";
import {
  deleteBackupStickersByBackup,
  listBackupStickersByBackup,
} from "../../../src/db/queries/backup-stickers.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import type { CdnOptions, CdnResponse } from "../../../src/lib/http.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  captureEmojis,
  captureSounds,
  captureStickers,
  createAssetStore,
} from "../../../src/services/backup/assets.ts";
import {
  type AssetKind,
  type AssetStore,
  type BackupContext,
  createSkipList,
} from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  type FixtureGuild,
  makeContext,
  makeGuild,
  makeSettings,
  restStub,
} from "../../fixtures/guild.ts";

const T0 = "2024-01-01T00:00:00.000Z";
const MAX_BYTES = 1024;

let db: Database;
const dirs: string[] = [];

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await deleteBackupEmojisByBackup(db, FIXTURE_BACKUP_ID);
  await deleteBackupStickersByBackup(db, FIXTURE_BACKUP_ID);
  await deleteBackupSoundsByBackup(db, FIXTURE_BACKUP_ID);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapback-assets-"));
  dirs.push(dir);
  return dir;
}

// the injected seam is fetchCdn's type: known bytes come back, nothing hits the net.
type FetchImpl = (url: string, options?: CdnOptions) => Promise<CdnResponse>;

interface FetchCall {
  url: string;
  options: CdnOptions | undefined;
}

function fetchStub(
  bytes: Uint8Array,
  contentType = "image/png",
): { impl: FetchImpl; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl: FetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { bytes, contentType, size: bytes.byteLength };
  };
  return { impl, calls };
}

// 20-digit, constant-width ids, above 2^53 and distinct per n.
function snowflake(n: number): string {
  return `1000000000000000${String(n).padStart(4, "0")}`;
}

function contextWithStub(
  guild: FixtureGuild,
  assets: AssetStore,
): { ctx: BackupContext; stub: ReturnType<typeof restStub> } {
  const stub = restStub(guild);
  const ctx: BackupContext = {
    db,
    client: stub.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: FIXTURE_BACKUP_ID,
    guildId: String(guild.guild.id),
    settings: makeSettings(),
    assets,
    skips: createSkipList(),
    checkpoint: async () => {},
    now: () => T0,
  };
  return { ctx, stub };
}

function cd(relative: string): string {
  return `https://cdn.discordapp.com/${relative}`;
}

describe("createAssetStore", () => {
  test("save writes the bytes under the backup dir and returns the relative path", async () => {
    const dir = tempDir();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { impl, calls } = fetchStub(bytes);
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });

    const url = cd("emojis/12345.png");
    const stored = await store.save("emoji", "12345", url);

    expect(stored).not.toBeNull();
    expect(stored?.url).toBe(url);
    expect(stored?.path).toBe("assets/emoji/12345.png");
    expect(stored?.bytes).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(url);

    const onDisk = readFileSync(join(dir, stored?.path ?? ""));
    expect([...onDisk]).toEqual([...bytes]);
  });

  test("pathFor matches the path save produced, for every kind", async () => {
    const dir = tempDir();
    const { impl } = fetchStub(new Uint8Array([9]));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });

    const kinds: AssetKind[] = ["guild", "role", "emoji", "sticker", "sound", "attachment"];
    for (const kind of kinds) {
      const url = cd(`${kind}/file.png`);
      const stored = await store.save(kind, `${kind}-name`, url);
      if (stored === null) throw new Error(`${kind} was not stored`);
      expect(store.pathFor(kind, `${kind}-name`, url)).toBe(stored.path);
    }
  });

  test("the extension comes from the url path, query stripped, else .bin", () => {
    const store = createAssetStore({
      dir: tempDir(),
      maxBytes: MAX_BYTES,
      fetchImpl: fetchStub(new Uint8Array()).impl,
    });

    // the query string is stripped
    expect(store.pathFor("emoji", "123", cd("emojis/123.png?size=44&quality=lossless"))).toBe(
      "assets/emoji/123.png",
    );
    // the query string does not fake an extension
    expect(store.pathFor("emoji", "123", cd("emojis/123?size=44"))).toBe("assets/emoji/123.bin");
    // a soundboard url carries no extension
    expect(store.pathFor("sound", "80", cd("soundboard-sounds/80"))).toBe("assets/sound/80.bin");
    // a dot in an earlier segment is not the extension
    expect(store.pathFor("emoji", "x", cd("emojis.png/name"))).toBe("assets/emoji/x.bin");
  });

  test("a body over maxBytes is refused and leaves no file or .tmp behind", async () => {
    const dir = tempDir();
    const { impl } = fetchStub(new Uint8Array(MAX_BYTES + 1));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });

    const stored = await store.save("emoji", "123", cd("emojis/123.png"));

    expect(stored).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("maxBytes 0 records nothing and downloads nothing", async () => {
    const dir = tempDir();
    const { impl, calls } = fetchStub(new Uint8Array([1]));
    const store = createAssetStore({ dir, maxBytes: 0, fetchImpl: impl });

    expect(await store.save("emoji", "123", cd("emojis/123.png"))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a url that is not the https cdn is refused without a fetch", async () => {
    const dir = tempDir();
    const { impl, calls } = fetchStub(new Uint8Array([1]));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });

    for (const url of [
      "https://example.com/emojis/1.png",
      "http://cdn.discordapp.com/emojis/1.png",
      "https://cdn.discordapp.com.evil.example/emojis/1.png",
    ]) {
      expect(await store.save("emoji", "1", url)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test("a name with a separator or .. is refused, writing outside is impossible", async () => {
    const dir = tempDir();
    const { impl, calls } = fetchStub(new Uint8Array([1]));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });

    for (const name of ["a/b", "a\\b", "..", "a..b", ""]) {
      expect(await store.save("emoji", name, cd("emojis/1.png"))).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a 404 response is a null, not a throw", async () => {
    const dir = tempDir();
    const impl: FetchImpl = async () => {
      throw new Error("SB_CDN_STATUS: 404 for /emojis/1.png");
    };
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });

    await expect(store.save("emoji", "1", cd("emojis/1.png"))).resolves.toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("captureEmojis, captureStickers, captureSounds", () => {
  test("an emoji row carries an animated-aware url that was downloaded", async () => {
    const guild = makeGuild();
    const dir = tempDir();
    const { impl, calls } = fetchStub(new Uint8Array([1, 2, 3]));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });
    const ctx = makeContext({ db, guild, assets: store });

    const result = await captureEmojis(ctx);
    expect(result.written).toBe(2);

    const partyId = String(guild.emojis.find((e) => e.name === "party")?.id);
    const blobId = String(guild.emojis.find((e) => e.name === "blob")?.id);
    const rows = await listBackupEmojisByBackup(db, FIXTURE_BACKUP_ID);
    const party = rows.find((row) => row.name === "party");
    const blob = rows.find((row) => row.name === "blob");

    expect(party?.animated).toBe(false);
    expect(party?.url).toBe(cd(`emojis/${partyId}.png`));
    expect(blob?.animated).toBe(true);
    expect(blob?.url).toBe(cd(`emojis/${blobId}.gif`));

    // both urls were fetched, and the bytes landed under assets/emoji
    expect(calls.map((call) => call.url).sort()).toEqual(
      [cd(`emojis/${partyId}.png`), cd(`emojis/${blobId}.gif`)].sort(),
    );
    expect(existsSync(join(dir, "assets/emoji", `${partyId}.png`))).toBe(true);
    expect(existsSync(join(dir, "assets/emoji", `${blobId}.gif`))).toBe(true);
  });

  test("a sticker's url extension follows its format_type", async () => {
    const stickers = [1, 2, 3, 4].map((formatType) => ({
      id: snowflake(formatType),
      name: `sticker${formatType}`,
      description: null,
      tags: null,
      format_type: formatType,
    }));
    const guild = makeGuild({ stickers });
    const dir = tempDir();
    const { impl } = fetchStub(new Uint8Array([1]));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });
    const ctx = makeContext({ db, guild, assets: store });

    const result = await captureStickers(ctx);
    expect(result.written).toBe(4);

    const rows = await listBackupStickersByBackup(db, FIXTURE_BACKUP_ID);
    const urlFor = (formatType: number) => rows.find((row) => row.format_type === formatType)?.url;
    expect(urlFor(1)).toBe(cd(`stickers/${snowflake(1)}.png`));
    expect(urlFor(2)).toBe(cd(`stickers/${snowflake(2)}.apng`));
    expect(urlFor(3)).toBe(cd(`stickers/${snowflake(3)}.json`));
    expect(urlFor(4)).toBe(cd(`stickers/${snowflake(4)}.gif`));
  });

  test("a sound row keeps volume and emoji, and always captures", async () => {
    const guild = makeGuild();
    const dir = tempDir();
    const { impl } = fetchStub(new Uint8Array([1]));
    const store = createAssetStore({ dir, maxBytes: MAX_BYTES, fetchImpl: impl });
    const ctx = makeContext({ db, guild, assets: store });

    const result = await captureSounds(ctx);
    expect(result.written).toBe(1);

    const soundId = String(guild.sounds.find((s) => s.name === "boop")?.sound_id);
    const emojiId = String(guild.sounds.find((s) => s.name === "boop")?.emoji_id);
    const rows = await listBackupSoundsByBackup(db, FIXTURE_BACKUP_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("boop");
    expect(rows[0]?.volume).toBe(1);
    expect(rows[0]?.emoji_name).toBe("party");
    expect(rows[0]?.emoji_id).toBe(emojiId);
    expect(rows[0]?.url).toBe(cd(`soundboard-sounds/${soundId}`));
  });

  test("a 403 on /soundboard-sounds is one skip and a zero result", async () => {
    const guild = makeGuild();
    const { impl, calls } = fetchStub(new Uint8Array([1]));
    const store = createAssetStore({ dir: tempDir(), maxBytes: MAX_BYTES, fetchImpl: impl });
    const { ctx, stub } = contextWithStub(guild, store);
    // fail the route the capture reads: a 403 means the guild has sounds disabled.
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/soundboard-sounds`,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/soundboard-sounds`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );

    const result = await captureSounds(ctx);

    expect(result).toEqual({ written: 0 });
    expect(ctx.skips.all()).toEqual([
      { category: "sounds", what: "all soundboard sounds", why: "50013 Missing Permissions" },
    ]);
    expect(await listBackupSoundsByBackup(db, FIXTURE_BACKUP_ID)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
