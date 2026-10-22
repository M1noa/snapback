// tests/services/export/formats.test.ts
// the restorecord shape is someone else's contract, so it is pinned exactly: the
// keys their download serves, the types it uses (channel type as a number,
// permissions as a string), and no ids, since their format carries none.
//
// the point of the test is that a snapback backup can be handed to a tool that
// expects restorecord's file, and that the parts we cannot express are the parts
// the format itself drops, not something we silently lose.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import type { BackupRoleRow, Database } from "../../../src/db/types.ts";
import { bundleToRestorecord, parseExportFormat, writeFormattedExport } from "../../../src/services/export/formats.ts";
import { buildExport, type ExportBundle, ExportError } from "../../../src/services/export/json.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";

const NOW = "2024-06-01T00:00:00.000Z";
const MAX_BITS = "9223372036854775807";

let db: Database;
let bundle: ExportBundle;

beforeAll(async () => {
  db = await openFixtureDb();
  const seeded = await insertFixtureBackup(db, { guild_name: "the server", icon_url: null });
  await insertBackupRoles(db, [
    { ...makeRole(seeded.backup_id, "1", 0), name: "@everyone", is_everyone: true },
    { ...makeRole(seeded.backup_id, "2", 1), name: "mods", color: 16711680, hoist: true },
  ]);
  await insertBackupChannels(db, [
    {
      backup_id: seeded.backup_id,
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
      backup_id: seeded.backup_id,
      source_channel_id: "20",
      parent_source_id: "10",
      type: 2,
      name: "a voice room",
      position: 1,
      topic: null,
      nsfw: false,
      rate_limit_per_user: null,
      bitrate: 64000,
      user_limit: 5,
      rtc_region: null,
      video_quality_mode: null,
      default_auto_archive_duration: null,
      default_thread_rate_limit_per_user: null,
      default_sort_order: null,
      default_forum_layout: null,
      available_tags_json: null,
      flags: 0,
      is_news: false,
    },
  ]);
  bundle = await buildExport(db, seeded.backup_id, { now: () => NOW });
});

afterAll(async () => {
  await closeFixtureDb(db);
});

describe("restorecord shape", () => {
  test("carries the wrapper and the five top-level keys", () => {
    const out = bundleToRestorecord(bundle);
    expect(out.success).toBe(true);
    expect(Object.keys(out.backup)).toEqual(["name", "icon", "channels", "roles", "createdAt"]);
    expect(out.backup.name).toBe("the server");
    expect(out.backup.icon).toBeNull();
  });

  test("a channel keeps its type number, position, and parent id", () => {
    const [category, voice] = bundleToRestorecord(bundle).backup.channels;
    expect(Object.keys(voice ?? {})).toEqual([
      "name",
      "type",
      "position",
      "parentId",
      "topic",
      "nsfw",
      "userLimit",
      "createdAt",
    ]);
    expect(category?.type).toBe(4);
    expect(voice?.type).toBe(2);
    expect(voice?.parentId).toBe("10");
    expect(voice?.userLimit).toBe(5);
  });

  test("a role keeps its bitfield as a string and its everyone flag", () => {
    const [everyone, mods] = bundleToRestorecord(bundle).backup.roles;
    expect(Object.keys(mods ?? {})).toEqual([
      "name",
      "color",
      "hoist",
      "permissions",
      "mentionable",
      "position",
      "isEveryone",
      "createdAt",
    ]);
    expect(everyone?.isEveryone).toBe(true);
    expect(typeof mods?.permissions).toBe("string");
    expect(mods?.color).toBe(16711680);
  });

  test("no ids leak into a format that has no field for them", () => {
    const text = JSON.stringify(bundleToRestorecord(bundle));
    expect(text).not.toContain(bundle.backup.backup_id);
    expect(text).not.toContain(bundle.backup.guild_id);
    // source ids survive only where the format has a slot: a channel parent.
    expect(text).not.toContain('"source_channel_id"');
    expect(text).not.toContain('"source_role_id"');
  });

  test("a permission bitfield wider than a double survives verbatim", () => {
    const wide: ExportBundle = {
      ...bundle,
      roles: [{ ...makeRole(bundle.backup.backup_id, "1", 0), permissions: MAX_BITS }],
    };
    expect(bundleToRestorecord(wide).backup.roles[0]?.permissions).toBe(MAX_BITS);
  });
});

describe("writeFormattedExport", () => {
  test("writes restorecord.json under the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sb-export-"));
    try {
      const { path, bytes } = await writeFormattedExport(bundle, join(dir, "g"), "restorecord");
      expect(path.endsWith("restorecord.json")).toBe(true);
      const text = await readFile(path, "utf8");
      expect(Buffer.byteLength(text, "utf8")).toBe(bytes);
      expect(text.endsWith("\n")).toBe(true);
      expect(JSON.parse(text).success).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("json still writes backup.json, the lossless bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sb-export-"));
    try {
      const { path } = await writeFormattedExport(bundle, join(dir, "g"), "json");
      expect(path.endsWith("backup.json")).toBe(true);
      const parsed = JSON.parse(await readFile(path, "utf8"));
      expect(parsed.schema_version).toBe(bundle.schema_version);
      expect(Array.isArray(parsed.roles)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseExportFormat", () => {
  test("accepts the two formats it writes", () => {
    expect(parseExportFormat("json")).toBe("json");
    expect(parseExportFormat("restorecord")).toBe("restorecord");
  });

  test("refuses anything else with the fixed code", () => {
    expect(() => parseExportFormat("vaultcord")).toThrow(ExportError);
    try {
      parseExportFormat("vaultcord");
    } catch (error) {
      expect((error as ExportError).code).toBe("SB_EXPORT_FORMAT");
    }
  });
});

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
