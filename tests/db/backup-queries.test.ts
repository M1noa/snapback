import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../src/db/duckdb.ts";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/db/migrate.ts";
import * as automod from "../../src/db/queries/backup-automod.ts";
import * as bans from "../../src/db/queries/backup-bans.ts";
import * as channels from "../../src/db/queries/backup-channels.ts";
import * as emojis from "../../src/db/queries/backup-emojis.ts";
import * as events from "../../src/db/queries/backup-events.ts";
import * as members from "../../src/db/queries/backup-members.ts";
import * as messages from "../../src/db/queries/backup-messages.ts";
import * as overwrites from "../../src/db/queries/backup-overwrites.ts";
import * as roles from "../../src/db/queries/backup-roles.ts";
import * as sounds from "../../src/db/queries/backup-sounds.ts";
import * as stickers from "../../src/db/queries/backup-stickers.ts";
import * as tags from "../../src/db/queries/backup-tags.ts";
import * as threads from "../../src/db/queries/backup-threads.ts";
import * as backups from "../../src/db/queries/backups.ts";
import type { BackupMessageRow, BackupRow, Database, MetaRow } from "../../src/db/types.ts";

// every backup query module runs against a real temp-file duckdb, migrated for
// real so migration 2's self_check_json column is present. the point is the
// boundary: an id survives as a string, a 64-bit bitfield round-trips exactly,
// and the batch path lands the same rows as the single-row path.

const SCHEMA = new URL("../../src/db/schema.sql", import.meta.url);

const ISO = "2024-01-01T00:00:00.000Z";
const SNOWFLAKE = "144102483157850112"; // 18 digits, above 2^53
const MAX_BITS = "9223372036854775807"; // 2^63-1, the widest a permission bitfield gets
const BIT_62 = "4611686018427387904"; // 2^62: above Number.MAX_SAFE_INTEGER

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-backup-queries-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeBackup(overrides: Partial<BackupRow> = {}): BackupRow {
  return {
    backup_id: "0190a000-0000-7000-8000-000000000001",
    guild_id: SNOWFLAKE,
    label: "nightly",
    kind: "manual",
    guild_name: "test guild",
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: "223456789012345678",
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
    created_at: ISO,
    created_by: "223456789012345678",
    ...overrides,
  };
}

function makeMessage(backupId: string, i: number): BackupMessageRow {
  return {
    backup_id: backupId,
    channel_source_id: "200",
    message_id: String(1_000_000_000 + i),
    author_id: "400",
    author_username: "someone",
    author_global_name: null,
    author_nickname: null,
    author_avatar_url: null,
    author_is_bot: false,
    author_webhook_id: null,
    content: `msg ${i}`,
    embeds_json: null,
    attachments_json: null,
    stickers_json: null,
    components_json: null,
    reactions_json: null,
    reference_json: null,
    thread_source_id: null,
    flags: null,
    pinned: false,
    type: 0,
    created_at: ISO,
    edited_at: null,
  };
}

async function columnNames(database: Database, table: string): Promise<string[]> {
  const rows = await database.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
    [table],
  );
  return rows.map((row) => row.column_name);
}

describe("backups", () => {
  test("insert, select back, and a snowflake stays a string", async () => {
    await backups.insertBackup(db, makeBackup());

    const got = await backups.getBackup(db, "0190a000-0000-7000-8000-000000000001");
    expect(got).not.toBeNull();
    expect(got?.guild_id).toBe(SNOWFLAKE);
    expect(typeof got?.guild_id).toBe("string");
    expect(got?.created_by).toBe("223456789012345678");
    expect(typeof got?.created_by).toBe("string");
    // a number would round silently here; the string boundary is what stops it
    expect(String(Number(SNOWFLAKE))).not.toBe(SNOWFLAKE);
  });

  test("updateBackup seals counts, size, and self_check_json", async () => {
    await backups.updateBackup(
      db,
      makeBackup({
        member_count: 10,
        message_count: 99,
        channel_count: 4,
        role_count: 7,
        size_bytes: 5_000_000,
        self_check_json: {
          ok: false,
          failures: ["message 5 has no channel", "count mismatch"],
          skipped: [{ category: "members", what: "@someone", why: "not in the guild" }],
        },
      }),
    );

    const got = await backups.getBackup(db, "0190a000-0000-7000-8000-000000000001");
    expect(got?.message_count).toBe(99);
    expect(typeof got?.size_bytes).toBe("number");
    expect(got?.size_bytes).toBe(5_000_000);
    expect(got?.self_check_json).toEqual({
      ok: false,
      failures: ["message 5 has no channel", "count mismatch"],
      skipped: [{ category: "members", what: "@someone", why: "not in the guild" }],
    });
  });

  test("an unsealed backup has a null self_check_json and counts as open", async () => {
    await backups.insertBackup(
      db,
      makeBackup({ backup_id: "0190a000-0000-7000-8000-000000000002" }),
    );

    const got = await backups.getBackup(db, "0190a000-0000-7000-8000-000000000002");
    expect(got?.self_check_json).toBeNull();

    // only the second row is still open; the first was sealed above
    const open = await backups.listOpenBackups(db, SNOWFLAKE);
    expect(open.map((row) => row.backup_id)).toEqual(["0190a000-0000-7000-8000-000000000002"]);
  });

  test("list by guild returns newest first, count reflects the guild", async () => {
    const list = await backups.listBackupsByGuild(db, SNOWFLAKE);
    expect(list).toHaveLength(2);
    expect(await backups.countBackupsByGuild(db, SNOWFLAKE)).toBe(2);
    expect(await backups.countBackupsByGuild(db, "1")).toBe(0);
  });

  test("deleteBackup removes the row", async () => {
    await backups.deleteBackup(db, "0190a000-0000-7000-8000-000000000002");
    expect(await backups.getBackup(db, "0190a000-0000-7000-8000-000000000002")).toBeNull();
    expect(await backups.countBackupsByGuild(db, SNOWFLAKE)).toBe(1);
  });
});

describe("backup_roles", () => {
  const B = "0190a000-0000-7000-8000-000000000100";

  test("a permission bitfield above MAX_SAFE_INTEGER round-trips exactly", async () => {
    await roles.insertBackupRole(db, {
      backup_id: B,
      source_role_id: SNOWFLAKE,
      name: "admin",
      color: 0x5865f2,
      hoist: true,
      mentionable: false,
      position: 3,
      permissions: MAX_BITS,
      is_everyone: false,
      is_bot_managed: false,
      bot_id: null,
      integration_id: null,
      icon_url: null,
      unicode_emoji: null,
      tags_json: { premium_subscriber: null },
    });

    const list = await roles.listBackupRolesByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.permissions).toBe(MAX_BITS);
    expect(typeof list[0]?.permissions).toBe("string");
    expect(typeof list[0]?.source_role_id).toBe("string");
    expect(list[0]?.tags_json).toEqual({ premium_subscriber: null });
    expect(await roles.countBackupRolesByBackup(db, B)).toBe(1);

    await roles.deleteBackupRolesByBackup(db, B);
    expect(await roles.countBackupRolesByBackup(db, B)).toBe(0);
    expect((await roles.listBackupRolesByBackup(db, B)).length).toBe(0);
  });
});

describe("backup_channels", () => {
  const B = "0190a000-0000-7000-8000-000000000200";

  test("round-trips a channel row", async () => {
    await channels.insertBackupChannel(db, {
      backup_id: B,
      source_channel_id: "300",
      parent_source_id: "299",
      type: 0,
      name: "general",
      position: 1,
      topic: "hello",
      nsfw: false,
      rate_limit_per_user: 5,
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
    });

    const list = await channels.listBackupChannelsByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("general");
    expect(list[0]?.parent_source_id).toBe("299");
    expect(list[0]?.nsfw).toBe(false);
    expect(await channels.countBackupChannelsByBackup(db, B)).toBe(1);

    await channels.deleteBackupChannelsByBackup(db, B);
    expect(await channels.countBackupChannelsByBackup(db, B)).toBe(0);
  });
});

describe("backup_channel_overwrites", () => {
  const B = "0190a000-0000-7000-8000-000000000201";

  test("allow and deny round-trip exactly above MAX_SAFE_INTEGER", async () => {
    await overwrites.insertBackupChannelOverwrite(db, {
      backup_id: B,
      source_channel_id: "300",
      target_type: "role",
      source_target_id: "100",
      target_name: "admin",
      allow: MAX_BITS,
      deny: BIT_62,
    });

    const list = await overwrites.listBackupChannelOverwritesByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.allow).toBe(MAX_BITS);
    expect(list[0]?.deny).toBe(BIT_62);
    expect(typeof list[0]?.allow).toBe("string");
    expect(list[0]?.target_type).toBe("role");
    expect(await overwrites.countBackupChannelOverwritesByBackup(db, B)).toBe(1);

    await overwrites.deleteBackupChannelOverwritesByBackup(db, B);
    expect(await overwrites.countBackupChannelOverwritesByBackup(db, B)).toBe(0);
  });
});

describe("backup_threads", () => {
  const B = "0190a000-0000-7000-8000-000000000300";

  test("round-trips a thread row", async () => {
    await threads.insertBackupThread(db, {
      backup_id: B,
      source_thread_id: "400",
      source_parent_id: "300",
      type: 11,
      name: "thread",
      archived: true,
      locked: false,
      auto_archive_duration: 1440,
      rate_limit_per_user: null,
      applied_tags_json: ["a", "b"],
    });

    const list = await threads.listBackupThreadsByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.applied_tags_json).toEqual(["a", "b"]);
    expect(list[0]?.archived).toBe(true);
    expect(await threads.countBackupThreadsByBackup(db, B)).toBe(1);

    await threads.deleteBackupThreadsByBackup(db, B);
    expect(await threads.countBackupThreadsByBackup(db, B)).toBe(0);
  });
});

describe("backup_members", () => {
  const B = "0190a000-0000-7000-8000-000000000400";

  test("round-trips a member row with a string snowflake", async () => {
    await members.insertBackupMember(db, {
      backup_id: B,
      user_id: SNOWFLAKE,
      username: "someone",
      global_name: "Someone",
      discriminator: null,
      nickname: "nick",
      avatar_url: null,
      joined_at: ISO,
      is_bot: false,
      role_ids_json: ["100"],
      pending: false,
      timed_out_until: null,
      premium_since: null,
      flags: null,
      source_role_names_json: ["admin"],
    });

    const list = await members.listBackupMembersByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.user_id).toBe(SNOWFLAKE);
    expect(typeof list[0]?.user_id).toBe("string");
    expect(list[0]?.role_ids_json).toEqual(["100"]);
    expect(list[0]?.source_role_names_json).toEqual(["admin"]);
    expect(await members.countBackupMembersByBackup(db, B)).toBe(1);

    await members.deleteBackupMembersByBackup(db, B);
    expect(await members.countBackupMembersByBackup(db, B)).toBe(0);
  });
});

describe("backup_messages", () => {
  const B = "0190a000-0000-7000-8000-000000000500";

  test("round-trips a message row with json columns", async () => {
    await messages.insertBackupMessage(db, {
      ...makeMessage(B, 1),
      embeds_json: [{ title: "t" }],
      attachments_json: [{ url: "https://x/y", path: "assets/attachments/y" }],
    });

    const list = await messages.listBackupMessagesByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.content).toBe("msg 1");
    expect(list[0]?.embeds_json).toEqual([{ title: "t" }]);
    // attachments carry both the cdn url and the local asset path (D4PLAN 11.5)
    expect(list[0]?.attachments_json).toEqual([
      { url: "https://x/y", path: "assets/attachments/y" },
    ]);
    expect(await messages.countBackupMessagesByBackup(db, B)).toBe(1);

    await messages.deleteBackupMessagesByBackup(db, B);
    expect(await messages.countBackupMessagesByBackup(db, B)).toBe(0);
  });

  test("the batch path lands the same rows as the single-row path", async () => {
    const total = 1_200; // more than one batchInsert chunk (1000), so the loop runs
    const batchedId = "0190a000-0000-7000-8000-0000000005a0";
    const singleId = "0190a000-0000-7000-8000-0000000005b0";

    await messages.insertBackupMessages(
      db,
      Array.from({ length: total }, (_, i) => makeMessage(batchedId, i)),
    );
    for (let i = 0; i < total; i++) {
      await messages.insertBackupMessage(db, makeMessage(singleId, i));
    }

    const project = (rows: BackupMessageRow[]) =>
      rows.map((row) => [row.message_id, row.channel_source_id, row.author_id, row.content]);
    const batched = await messages.listBackupMessagesByBackup(db, batchedId);
    const single = await messages.listBackupMessagesByBackup(db, singleId);

    expect(batched).toHaveLength(total);
    expect(project(batched)).toEqual(project(single));

    await messages.deleteBackupMessagesByBackup(db, batchedId);
    await messages.deleteBackupMessagesByBackup(db, singleId);
    // 1200 single inserts is 1200 transactions: the test is given room
    // rather than the insert path being made faster.
  }, 30_000);
});

describe("backup_bans", () => {
  const B = "0190a000-0000-7000-8000-000000000600";

  test("round-trips a ban row", async () => {
    await bans.insertBackupBan(db, {
      backup_id: B,
      user_id: "700",
      username: "bad",
      global_name: null,
      reason: "spam",
    });

    const list = await bans.listBackupBansByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.reason).toBe("spam");
    expect(await bans.countBackupBansByBackup(db, B)).toBe(1);

    await bans.deleteBackupBansByBackup(db, B);
    expect(await bans.countBackupBansByBackup(db, B)).toBe(0);
  });
});

describe("backup_assets keep their url", () => {
  // schema.sql gives backup_emojis, backup_stickers and backup_sounds a single
  // url column, not a separate local asset path; the downloaded blob lives on
  // disk under backups/<id>/assets/ (D4PLAN 11). so the url is what must survive.

  test("an emoji row keeps its url as a string", async () => {
    const B = "0190a000-0000-7000-8000-000000000700";
    await emojis.insertBackupEmoji(db, {
      backup_id: B,
      source_emoji_id: "800",
      name: "blob",
      animated: false,
      managed: false,
      available: true,
      roles_json: [],
      url: "https://cdn.discordapp.com/emojis/800.png",
    });

    const list = await emojis.listBackupEmojisByBackup(db, B);
    expect(list[0]?.url).toBe("https://cdn.discordapp.com/emojis/800.png");
    expect(typeof list[0]?.url).toBe("string");
    expect(await emojis.countBackupEmojisByBackup(db, B)).toBe(1);

    await emojis.deleteBackupEmojisByBackup(db, B);
    expect(await emojis.countBackupEmojisByBackup(db, B)).toBe(0);
  });

  test("a sticker row keeps its url as a string", async () => {
    const B = "0190a000-0000-7000-8000-000000000701";
    await stickers.insertBackupSticker(db, {
      backup_id: B,
      source_sticker_id: "801",
      name: "sticker",
      description: "d",
      tags: "a, b",
      format_type: 1,
      url: "https://cdn.discordapp.com/stickers/801.png",
    });

    const list = await stickers.listBackupStickersByBackup(db, B);
    expect(list[0]?.url).toBe("https://cdn.discordapp.com/stickers/801.png");
    expect(typeof list[0]?.url).toBe("string");
    expect(await stickers.countBackupStickersByBackup(db, B)).toBe(1);

    await stickers.deleteBackupStickersByBackup(db, B);
    expect(await stickers.countBackupStickersByBackup(db, B)).toBe(0);
  });

  test("a sound row keeps its url as a string", async () => {
    const B = "0190a000-0000-7000-8000-000000000702";
    await sounds.insertBackupSound(db, {
      backup_id: B,
      source_sound_id: "802",
      name: "boom",
      volume: 0.5,
      emoji_name: "boom",
      emoji_id: null,
      url: "https://cdn.discordapp.com/soundboard-sounds/802",
    });

    const list = await sounds.listBackupSoundsByBackup(db, B);
    expect(list[0]?.url).toBe("https://cdn.discordapp.com/soundboard-sounds/802");
    expect(typeof list[0]?.url).toBe("string");
    expect(list[0]?.volume).toBe(0.5);
    expect(await sounds.countBackupSoundsByBackup(db, B)).toBe(1);

    await sounds.deleteBackupSoundsByBackup(db, B);
    expect(await sounds.countBackupSoundsByBackup(db, B)).toBe(0);
  });
});

describe("backup_automod", () => {
  const B = "0190a000-0000-7000-8000-000000001000";

  test("round-trips an automod row", async () => {
    await automod.insertBackupAutomod(db, {
      backup_id: B,
      source_rule_id: "1100",
      name: "rule",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata_json: { keyword_filter: ["bad"] },
      actions_json: [{ type: 1 }],
      enabled: true,
      exempt_roles_json: ["100"],
      exempt_channels_json: [],
    });

    const list = await automod.listBackupAutomodsByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.actions_json).toEqual([{ type: 1 }]);
    expect(list[0]?.exempt_roles_json).toEqual(["100"]);
    expect(await automod.countBackupAutomodsByBackup(db, B)).toBe(1);

    await automod.deleteBackupAutomodsByBackup(db, B);
    expect(await automod.countBackupAutomodsByBackup(db, B)).toBe(0);
  });
});

describe("backup_events", () => {
  const B = "0190a000-0000-7000-8000-000000001100";

  test("round-trips a scheduled event row", async () => {
    await events.insertBackupEvent(db, {
      backup_id: B,
      source_event_id: "1200",
      name: "party",
      description: null,
      scheduled_start: ISO,
      scheduled_end: null,
      privacy_level: 2,
      entity_type: 3,
      entity_metadata_json: { location: "here" },
      status: 1,
      cover_url: null,
    });

    const list = await events.listBackupEventsByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.entity_metadata_json).toEqual({ location: "here" });
    expect(list[0]?.scheduled_start).toBe(ISO);
    expect(await events.countBackupEventsByBackup(db, B)).toBe(1);

    await events.deleteBackupEventsByBackup(db, B);
    expect(await events.countBackupEventsByBackup(db, B)).toBe(0);
  });
});

describe("backup_tags", () => {
  const B = "0190a000-0000-7000-8000-000000001200";

  test("round-trips a tag row with the quoted table column", async () => {
    await tags.insertBackupTag(db, {
      backup_id: B,
      table: "backup_messages",
      row_id: "500",
      tag: "general",
    });

    const list = await tags.listBackupTagsByBackup(db, B);
    expect(list).toHaveLength(1);
    expect(list[0]?.table).toBe("backup_messages");
    expect(list[0]?.tag).toBe("general");
    expect(await tags.countBackupTagsByBackup(db, B)).toBe(1);

    await tags.deleteBackupTagsByBackup(db, B);
    expect(await tags.countBackupTagsByBackup(db, B)).toBe(0);
  });
});

describe("migration 2", () => {
  test("applying it twice leaves one self_check_json column", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 2);
    expect(migration).toBeDefined();
    if (migration === undefined) return;

    await db.exec(migration.sql);
    await db.exec(migration.sql);

    const columns = await columnNames(db, "backups");
    expect(columns.filter((name) => name === "self_check_json")).toHaveLength(1);
  });

  test("a database created at version 1 migrates to the current version and keeps its rows", async () => {
    const v1Dir = mkdtempSync(join(tmpdir(), "snapback-mig2-"));
    const v1 = await openDuckDB(join(v1Dir, "v1.duckdb"));
    try {
      // schema.sql alone is the version 1 baseline: no self_check_json yet.
      await v1.exec(await Bun.file(SCHEMA).text());
      expect(await columnNames(v1, "backups")).not.toContain("self_check_json");

      // a row written while still at version 1
      await v1.run(
        "INSERT INTO backups (backup_id, guild_id, kind, member_count, created_at) VALUES (?, ?, ?, ?, ?)",
        ["0190a000-0000-7000-8000-0000000009f0", SNOWFLAKE, "manual", 3, ISO],
      );
      await v1.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");

      await migrate(v1);

      expect(await columnNames(v1, "backups")).toContain("self_check_json");
      const rows = await v1.query<{ backup_id: string; member_count: number }>(
        "SELECT backup_id, member_count FROM backups",
      );
      expect(rows).toHaveLength(1); // the version 1 row survived the alter
      expect(rows[0]?.backup_id).toBe("0190a000-0000-7000-8000-0000000009f0");

      const version = await v1.query<MetaRow>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      );
      expect(Number(version[0]?.value)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(4);
    } finally {
      await v1.close();
      rmSync(v1Dir, { recursive: true, force: true });
    }
  });
});
