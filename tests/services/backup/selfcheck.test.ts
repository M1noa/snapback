// tests/services/backup/selfcheck.test.ts
//
// D4PLAN 11.6: a backup validates itself before it is sealed, and one that fails
// is stored, marked incomplete, with the specific failures listed. the failure
// mode this prevents is a backup nobody notices is partial until the day it is
// restored, so every check gets a test that breaks exactly that invariant.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { insertBackupMembers } from "../../../src/db/queries/backup-members.ts";
import { insertBackupMessages } from "../../../src/db/queries/backup-messages.ts";
import { insertBackupChannelOverwrites } from "../../../src/db/queries/backup-overwrites.ts";
import { insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import { listOpenBackups } from "../../../src/db/queries/backups.ts";
import type {
  BackupChannelOverwriteRow,
  BackupChannelRow,
  BackupMemberRow,
  BackupMessageRow,
  BackupRoleRow,
  Database,
} from "../../../src/db/types.ts";
import {
  countRows,
  type RecordedCounts,
  runSelfCheck,
  sealBackup,
} from "../../../src/services/backup/selfcheck.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";

let db: Database;
const dirs: string[] = [];

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// a working directory with real bytes in it, so size_bytes is a measurement and
// not a promise.
function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "snapback-selfcheck-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function role(backupId: string, id: string): BackupRoleRow {
  return {
    backup_id: backupId,
    source_role_id: id,
    name: `role ${id}`,
    color: 0,
    hoist: false,
    mentionable: false,
    position: 0,
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

function channel(backupId: string, id: string, parent: string | null): BackupChannelRow {
  return {
    backup_id: backupId,
    source_channel_id: id,
    parent_source_id: parent,
    type: parent === null ? 4 : 0,
    name: `channel ${id}`,
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
  };
}

function member(backupId: string, id: string, roleIds: string[]): BackupMemberRow {
  return {
    backup_id: backupId,
    user_id: id,
    username: `user ${id}`,
    global_name: null,
    discriminator: "0",
    nickname: null,
    avatar_url: null,
    joined_at: null,
    is_bot: false,
    role_ids_json: roleIds,
    pending: false,
    timed_out_until: null,
    premium_since: null,
    flags: null,
    source_role_names_json: [],
  };
}

function message(backupId: string, channelId: string, id: string): BackupMessageRow {
  return {
    backup_id: backupId,
    channel_source_id: channelId,
    message_id: id,
    author_id: "1",
    author_username: "someone",
    author_global_name: null,
    author_nickname: null,
    author_avatar_url: null,
    author_is_bot: false,
    author_webhook_id: null,
    content: "hi",
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
    created_at: "2024-01-01T00:00:00.000Z",
    edited_at: null,
  };
}

function overwrite(
  backupId: string,
  channelId: string,
  targetType: "role" | "member",
  targetId: string,
  name: string | null,
): BackupChannelOverwriteRow {
  return {
    backup_id: backupId,
    source_channel_id: channelId,
    target_type: targetType,
    source_target_id: targetId,
    target_name: name,
    allow: "0",
    deny: "0",
  };
}

// a coherent backup: one category, a channel under it, a role, a member holding
// that role, an overwrite that resolves, and a message in the channel.
async function coherent(overrides: { skipRoles?: boolean } = {}) {
  const row = await insertFixtureBackup(db);
  const id = row.backup_id;
  await insertBackupChannels(db, [channel(id, "10", null), channel(id, "20", "10")]);
  await insertBackupRoles(db, overrides.skipRoles === true ? [] : [role(id, "100")]);
  await insertBackupMembers(db, [member(id, "900", overrides.skipRoles === true ? [] : ["100"])]);
  await insertBackupChannelOverwrites(db, [overwrite(id, "20", "role", "100", "role 100")]);
  await insertBackupMessages(db, [message(id, "20", "500")]);
  return id;
}

const MATCHING: RecordedCounts = { roles: 1, channels: 2, members: 6, messages: 1 };

describe("runSelfCheck", () => {
  test("a coherent backup passes every check", async () => {
    const id = await coherent();
    const counts = await countRows(db, id);
    const result = await runSelfCheck(db, id, counts);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a channel whose parent is not in the backup is a failure", async () => {
    const id = await coherent();
    await insertBackupChannels(db, [channel(id, "30", "99")]);
    const result = await runSelfCheck(db, id, await countRows(db, id));
    expect(result.ok).toBe(false);
    expect(result.failures.some((line) => line.includes("30") && line.includes("99"))).toBe(true);
  });

  test("a member carrying an uncaptured role is a failure", async () => {
    const id = await coherent();
    await insertBackupMembers(db, [member(id, "901", ["100", "404"])]);
    const result = await runSelfCheck(db, id, await countRows(db, id));
    expect(result.ok).toBe(false);
    expect(result.failures.some((line) => line.includes("901") && line.includes("404"))).toBe(true);
  });

  test("with roles turned off, members are not reported for every role they hold", async () => {
    // the check only runs when roles were captured at all: otherwise every member
    // fails for a reason the operator chose on purpose.
    const id = await coherent({ skipRoles: true });
    await insertBackupMembers(db, [member(id, "901", ["100", "101"])]);
    const result = await runSelfCheck(db, id, await countRows(db, id));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("an unresolved overwrite is only a failure when it has no name to fall back on", async () => {
    const id = await coherent();
    const flagged = await insertFixtureBackup(db, { label: "flagged" });
    await insertBackupChannels(db, [channel(flagged.backup_id, "20", null)]);
    await insertBackupChannelOverwrites(db, [
      overwrite(flagged.backup_id, "20", "role", "777", ""),
    ]);
    const bad = await runSelfCheck(db, flagged.backup_id, await countRows(db, flagged.backup_id));
    expect(bad.failures.some((line) => line.includes("777"))).toBe(true);

    const resolved = await insertFixtureBackup(db, { label: "resolved" });
    await insertBackupChannels(db, [channel(resolved.backup_id, "20", null)]);
    await insertBackupChannelOverwrites(db, [
      overwrite(resolved.backup_id, "20", "role", "777", "a role from another guild"),
    ]);
    const fine = await runSelfCheck(db, resolved.backup_id, await countRows(db, resolved.backup_id));
    expect(fine.failures).toEqual([]);
    // the first backup is untouched by the second one's result
    expect(id).not.toBe(resolved.backup_id);
  });

  test("a message in a channel the backup does not hold is a failure", async () => {
    const id = await coherent();
    await insertBackupMessages(db, [message(id, "999", "501")]);
    const result = await runSelfCheck(db, id, await countRows(db, id));
    expect(result.failures.some((line) => line.includes("501") && line.includes("999"))).toBe(true);
  });

  test("a count that does not match the rows is a failure", async () => {
    const id = await coherent();
    const result = await runSelfCheck(db, id, { ...MATCHING, messages: 99 });
    expect(result.ok).toBe(false);
    expect(result.failures.some((line) => line.includes("99") && line.includes("messages"))).toBe(
      true,
    );
  });
});

describe("sealBackup", () => {
  test("writes the counts, the size on disk, and the check onto the row", async () => {
    const id = await coherent();
    const dir = makeDir({ "assets/guild/icon.png": "1234567890", "assets/a/b.bin": "12345" });
    const { backup, check } = await sealBackup({
      db,
      backupId: id,
      recorded: await countRows(db, id),
      skips: [],
      assetDir: dir,
    });

    expect(check.ok).toBe(true);
    expect(backup.self_check_json?.ok).toBe(true);
    expect(backup.self_check_json?.skipped).toEqual([]);
    expect(backup.role_count).toBe(1);
    expect(backup.channel_count).toBe(2);
    expect(backup.member_count).toBe(1);
    expect(backup.message_count).toBe(1);
    // 10 bytes in one file plus 5 in a nested one.
    expect(backup.size_bytes).toBe(15);

    // sealed means sealed: it stops being an open backup.
    const open = await listOpenBackups(db, backup.guild_id);
    expect(open.some((row) => row.backup_id === id)).toBe(false);
  });

  test("a missing asset directory is zero bytes, not an error", async () => {
    const id = await coherent();
    const { backup } = await sealBackup({
      db,
      backupId: id,
      recorded: await countRows(db, id),
      skips: [],
      assetDir: join(tmpdir(), "snapback-no-such-directory-1234"),
    });
    expect(backup.size_bytes).toBe(0);
  });

  test("the skip list is stored beside the failures", async () => {
    const id = await coherent();
    const skips = [
      { category: "bans", what: "the ban list", why: "50013 Missing Permissions" },
    ];
    const { backup } = await sealBackup({
      db,
      backupId: id,
      recorded: await countRows(db, id),
      skips,
      assetDir: null,
    });
    expect(backup.self_check_json?.skipped).toEqual(skips);
    // a skip is not a failure: the backup is still complete.
    expect(backup.self_check_json?.ok).toBe(true);
  });

  test("a step failure is folded in and makes the backup incomplete", async () => {
    const id = await coherent();
    const { backup, check } = await sealBackup({
      db,
      backupId: id,
      recorded: await countRows(db, id),
      skips: [],
      assetDir: null,
      extraFailures: ["step automod failed: the automod step blew up"],
    });
    expect(check.ok).toBe(false);
    expect(backup.self_check_json?.ok).toBe(false);
    expect(backup.self_check_json?.failures).toContain(
      "step automod failed: the automod step blew up",
    );
  });

  test("a backup row that is gone is our own error, not a silent no-op", async () => {
    await expect(
      sealBackup({
        db,
        backupId: "0190a000-0000-7000-8000-0000000000ff",
        recorded: MATCHING,
        skips: [],
        assetDir: null,
      }),
    ).rejects.toThrow("SB_BACKUP_MISSING");
  });
});
