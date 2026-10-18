// tests/services/export/json.test.ts
// the export bundle is a contract: the committed golden file and the round-trip
// test both read it as data, so this suite pins the bytes, the ordering, and the
// two properties the feature rests on (no secrets, 64-bit values as strings).
//
// the fixture helpers live in tests/fixtures/db.ts (openFixtureDb, closeFixtureDb,
// insertFixtureBackup); this file imports them by those names.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { insertBackupAutomod } from "../../../src/db/queries/backup-automod.ts";
import { insertBackupBan } from "../../../src/db/queries/backup-bans.ts";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { insertBackupEmojis } from "../../../src/db/queries/backup-emojis.ts";
import { insertBackupEvents } from "../../../src/db/queries/backup-events.ts";
import { insertBackupMembers } from "../../../src/db/queries/backup-members.ts";
import { insertBackupMessages } from "../../../src/db/queries/backup-messages.ts";
import { insertBackupChannelOverwrites } from "../../../src/db/queries/backup-overwrites.ts";
import { insertBackupRole, insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import { insertBackupSounds } from "../../../src/db/queries/backup-sounds.ts";
import { insertBackupStickers } from "../../../src/db/queries/backup-stickers.ts";
import { insertBackupThreads } from "../../../src/db/queries/backup-threads.ts";
import { insertBackup } from "../../../src/db/queries/backups.ts";
import type { BackupRoleRow, BackupRow, Database } from "../../../src/db/types.ts";
import {
  buildExport,
  bundleToJson,
  type ExportBundle,
  ExportError,
  readExport,
  writeExport,
} from "../../../src/services/export/json.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";

const GOLDEN_PATH = fileURLToPath(new URL("../../fixtures/golden-backup.json", import.meta.url));
// the one normalisation the golden test allows: exported_at is injected, so a
// clock change never shows up as a diff. the fixture owns every other value.
const NOW = "2024-06-01T00:00:00.000Z";
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

const SNOWFLAKE = "144102483157850112"; // 18 digits, above 2^53
const MAX_BITS = "9223372036854775807"; // 2^63-1, the widest a permission bitfield gets

// [.] instead of an escaped dot keeps the literal free of backslashes.
const SECRET_KEY = /token|secret|password|email|_ip$/i;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,}[.][A-Za-z0-9_-]{6}[.][A-Za-z0-9_-]{27,}$/;

let db: Database;
let bundle: ExportBundle;

beforeAll(async () => {
  db = await openFixtureDb();
  // one backup with a row in every child table, so the golden file is a real
  // contract: a column added to any captured table shows up as a diff here.
  const seeded = await insertFixtureBackup(db);
  await seedChildren(db, seeded.backup_id);
  bundle = await buildExport(db, seeded.backup_id, { now: () => NOW });
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// a row in every child table, so the golden bundle is a contract over the whole
// export rather than over three tables that happened to be easy to seed.
async function seedChildren(db: Database, backupId: string): Promise<void> {
  const at = "2024-01-01T00:00:00.000Z";
  await insertBackupRoles(db, [
    {
      ...makeRole(backupId, SNOWFLAKE, 0),
      name: "@everyone",
      is_everyone: true,
      permissions: MAX_BITS,
    },
    { ...makeRole(backupId, "300", 1), name: "mods", color: 16711680, hoist: true },
  ]);
  await insertBackupChannels(db, [
    {
      backup_id: backupId,
      source_channel_id: "10",
      parent_source_id: null,
      type: 4,
      name: "a category",
      position: 0,
      topic: null,
      nsfw: false,
      rate_limit_per_user: null,
      bitrate: null,
      user_limit: null,
      rtc_region: null,
      video_quality_mode: null,
      default_auto_archive_duration: null,
      default_thread_rate_limit_per_user: null,
      default_sort_order: null,
      default_forum_layout: null,
      available_tags_json: null,
      flags: null,
      is_news: false,
    },
    {
      backup_id: backupId,
      source_channel_id: "20",
      parent_source_id: "10",
      type: 0,
      name: "general",
      position: 0,
      topic: "the channel",
      nsfw: false,
      rate_limit_per_user: 5,
      bitrate: null,
      user_limit: null,
      rtc_region: null,
      video_quality_mode: null,
      default_auto_archive_duration: 1440,
      default_thread_rate_limit_per_user: null,
      default_sort_order: null,
      default_forum_layout: null,
      available_tags_json: null,
      flags: 0,
      is_news: false,
    },
  ]);
  await insertBackupChannelOverwrites(db, [
    {
      backup_id: backupId,
      source_channel_id: "20",
      target_type: "role",
      source_target_id: "300",
      target_name: "mods",
      allow: "1024",
      deny: MAX_BITS,
    },
  ]);
  await insertBackupThreads(db, [
    {
      backup_id: backupId,
      source_thread_id: "30",
      source_parent_id: "20",
      type: 11,
      name: "a thread",
      archived: false,
      locked: false,
      auto_archive_duration: 1440,
      rate_limit_per_user: 0,
      applied_tags_json: null,
    },
  ]);
  await insertBackupMembers(db, [
    {
      backup_id: backupId,
      user_id: SNOWFLAKE,
      username: "someone",
      global_name: "Some One",
      discriminator: "0",
      nickname: "nick",
      avatar_url: `https://cdn.discordapp.com/avatars/${SNOWFLAKE}/hash.png`,
      joined_at: at,
      is_bot: false,
      role_ids_json: ["300"],
      pending: false,
      timed_out_until: null,
      premium_since: null,
      flags: 0,
      source_role_names_json: ["mods"],
    },
  ]);
  await insertBackupMessages(db, [
    {
      backup_id: backupId,
      channel_source_id: "20",
      message_id: "50",
      author_id: SNOWFLAKE,
      author_username: "someone",
      author_global_name: "Some One",
      author_nickname: "nick",
      author_avatar_url: null,
      author_is_bot: false,
      author_webhook_id: null,
      content: "a message that was posted",
      embeds_json: [],
      attachments_json: [
        { url: null, path: null, size: 4096, contentType: "image/png", filename: "shot.png" },
      ],
      stickers_json: [],
      components_json: [],
      reactions_json: [{ emoji: { id: null, name: "\u{1F44D}" }, count: 2 }],
      reference_json: null,
      thread_source_id: null,
      flags: 0,
      pinned: false,
      type: 0,
      created_at: at,
      edited_at: null,
    },
  ]);
  await insertBackupBan(db, {
    backup_id: backupId,
    user_id: "223456789012345678",
    username: "banned",
    global_name: null,
    reason: "spam",
  });
  await insertBackupEmojis(db, [
    {
      backup_id: backupId,
      source_emoji_id: "60",
      name: "party",
      animated: false,
      managed: false,
      available: true,
      roles_json: [],
      url: "https://cdn.discordapp.com/emojis/60.png",
    },
  ]);
  await insertBackupStickers(db, [
    {
      backup_id: backupId,
      source_sticker_id: "70",
      name: "wave",
      description: null,
      tags: "wave",
      format_type: 1,
      url: "https://cdn.discordapp.com/stickers/70.png",
    },
  ]);
  await insertBackupSounds(db, [
    {
      backup_id: backupId,
      source_sound_id: "80",
      name: "boop",
      volume: 1,
      emoji_name: "party",
      emoji_id: "60",
      url: "https://cdn.discordapp.com/soundboard-sounds/80",
    },
  ]);
  await insertBackupAutomod(db, {
    backup_id: backupId,
    source_rule_id: "90",
    name: "no invites",
    event_type: 1,
    trigger_type: 1,
    trigger_metadata_json: { keyword_filter: ["discord.gg"] },
    actions_json: [{ type: 1 }],
    enabled: true,
    exempt_roles_json: ["300"],
    exempt_channels_json: [],
  });
  await insertBackupEvents(db, [
    {
      backup_id: backupId,
      source_event_id: "95",
      name: "an event",
      description: null,
      scheduled_start: at,
      scheduled_end: null,
      privacy_level: 2,
      entity_type: 3,
      entity_metadata_json: { location: "somewhere" },
      status: 1,
      cover_url: null,
    },
  ]);
}

// a backup row and a role row built here, for the cases that must not lean on
// whatever the fixture happens to contain.
function makeBackup(backupId: string): BackupRow {
  return {
    backup_id: backupId,
    guild_id: SNOWFLAKE,
    label: null,
    kind: "manual",
    guild_name: "empty",
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: null,
    member_count: 0,
    message_count: 0,
    channel_count: 0,
    role_count: 0,
    size_bytes: 0,
    schema_version: 2,
    guild_settings_json: null,
    onboarding_json: null,
    welcome_screen_json: null,
    widget_json: null,
    afk_json: null,
    self_check_json: null,
    created_at: "2024-01-01T00:00:00.000Z",
    created_by: "223456789012345678",
  };
}

function makeRole(backupId: string, id: string, position: number): BackupRoleRow {
  return {
    backup_id: backupId,
    source_role_id: id,
    name: `role ${position}`,
    color: 0,
    hoist: false,
    mentionable: false,
    position,
    permissions: "0",
    is_everyone: false,
    is_bot_managed: false,
    bot_id: null,
    integration_id: null,
    icon_url: null,
    unicode_emoji: null,
    tags_json: null,
  };
}

// visit every key/value pair in the parsed bundle, arrays and nested objects
// included. the object is plain JSON, so no cycles and no reflection surprises.
type Visitor = (key: string | null, value: unknown) => void;

function walk(value: unknown, visit: Visitor, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, null);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey);
  }
}

describe("buildExport", () => {
  test("the bundle matches the golden file byte for byte", async () => {
    const json = bundleToJson(bundle);
    if (UPDATE_GOLDEN) {
      await mkdir(dirname(GOLDEN_PATH), { recursive: true });
      await writeFile(GOLDEN_PATH, json, "utf8");
    }
    expect(json).toBe(await readFile(GOLDEN_PATH, "utf8"));
  });

  test("the same rows inserted in a different order serialise identically", async () => {
    const first = await openFixtureDb();
    const second = await openFixtureDb();
    try {
      // two backups, the same rows, written in opposite order. the query modules
      // order by id, so the bytes cannot depend on insert order.
      const ascending = "0190a000-0000-7000-8000-0000000000a1";
      const descending = "0190a000-0000-7000-8000-0000000000a2";
      await insertBackup(first, makeBackup(ascending));
      await insertBackup(second, makeBackup(descending));

      // the rows themselves are identical; only the insert order differs.
      const rows = ["300", "100", "200"].map((id, position) => makeRole(ascending, id, position));
      for (const row of rows) await insertBackupRole(first, row);
      for (const row of [...rows].reverse()) {
        await insertBackupRole(second, { ...row, backup_id: descending });
      }

      const a = await buildExport(first, ascending, { now: () => NOW });
      const b = await buildExport(second, descending, { now: () => NOW });
      // the two backups carry different ids by construction, and every child row
      // repeats its parent's id. blank both, then the bytes must match exactly.
      const blank = (json: string) =>
        json.replaceAll(ascending, "replaced").replaceAll(descending, "replaced");
      expect(blank(bundleToJson(a))).toBe(blank(bundleToJson(b)));
    } finally {
      await closeFixtureDb(first);
      await closeFixtureDb(second);
    }
  });

  test("a backup with no children serialises empty arrays, never null", async () => {
    const id = "0190a000-0000-7000-8000-0000000000b0";
    await insertBackup(db, makeBackup(id));

    const empty = await buildExport(db, id, { now: () => NOW });
    expect(typeof empty.schema_version).toBe("number");
    for (const key of [
      "roles",
      "channels",
      "overwrites",
      "threads",
      "members",
      "messages",
      "bans",
      "emojis",
      "stickers",
      "sounds",
      "automod",
      "events",
    ] as const) {
      expect(empty[key]).toEqual([]);
    }
  });

  test("an unknown backup id is the fixed export error", async () => {
    await expect(buildExport(db, "0190a000-0000-7000-8000-0000000000ff")).rejects.toMatchObject({
      code: "SB_EXPORT_NO_BACKUP",
    });
  });
});

describe("no secrets", () => {
  test("no key names a secret and no value looks like a token", () => {
    walk(bundle, (key, value) => {
      if (key !== null) expect(SECRET_KEY.test(key)).toBe(false);
      if (typeof value === "string") expect(TOKEN_SHAPE.test(value)).toBe(false);
    });
  });
});

describe("64-bit values", () => {
  test("a permission bitfield and a snowflake above 2^53 survive as strings", async () => {
    const id = "0190a000-0000-7000-8000-0000000000c0";
    await insertBackup(db, makeBackup(id));
    await insertBackupRole(db, { ...makeRole(id, SNOWFLAKE, 1), permissions: MAX_BITS });

    const big = await buildExport(db, id, { now: () => NOW });
    expect(big.roles[0]?.permissions).toBe(MAX_BITS);
    expect(big.roles[0]?.source_role_id).toBe(SNOWFLAKE);
    expect(typeof big.roles[0]?.permissions).toBe("string");
    expect(String(Number(SNOWFLAKE))).not.toBe(SNOWFLAKE);

    // nothing anywhere in the bundle crossed into lossy territory
    walk(big, (_key, value) => {
      if (typeof value === "number") expect(value).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    });
  });
});

describe("writeExport and readExport", () => {
  test("writes the file with the right byte count and round-trips it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-export-"));
    try {
      const { path, bytes } = await writeExport(bundle, dir);
      expect(path).toBe(join(dir, "backup.json"));
      expect(bytes).toBe(Buffer.byteLength(bundleToJson(bundle), "utf8"));
      expect(await readExport(path)).toEqual(bundle);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("copies the asset tree beside the bundle when given the backup directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "snapback-export-assets-"));
    try {
      const backupDir = join(base, "backup");
      await mkdir(join(backupDir, "assets", "emojis"), { recursive: true });
      await writeFile(join(backupDir, "assets", "emojis", "blob.png"), "bytes");

      const out = join(base, "out");
      await writeExport(bundle, out, { backupDir });
      expect(await Bun.file(join(out, "assets", "emojis", "blob.png")).text()).toBe("bytes");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a backup directory with no asset tree is not an error", async () => {
    const base = await mkdtemp(join(tmpdir(), "snapback-export-noassets-"));
    try {
      const backupDir = join(base, "backup");
      await mkdir(backupDir, { recursive: true });

      const out = join(base, "out");
      const { bytes } = await writeExport(bundle, out, { backupDir });
      expect(bytes).toBeGreaterThan(0);
      expect(await Bun.file(join(out, "assets")).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a malformed file throws the fixed error, not half an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-export-bad-"));
    try {
      const badJson = join(dir, "bad.json");
      await writeFile(badJson, '{ "schema_version": ');
      await expect(readExport(badJson)).rejects.toThrow(ExportError);

      const badShape = join(dir, "bad-shape.json");
      await writeFile(
        badShape,
        JSON.stringify({ schema_version: 1, exported_at: "x", backup: {} }),
      );
      await expect(readExport(badShape)).rejects.toMatchObject({ code: "SB_EXPORT_MALFORMED" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
