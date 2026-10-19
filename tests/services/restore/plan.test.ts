// tests/services/restore/plan.test.ts
//
// the plan is a promise about what a restore would do, so it is only worth
// anything if the order matches the executor and the counts match the backup.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { insertBackupMembers } from "../../../src/db/queries/backup-members.ts";
import { insertBackupMessages } from "../../../src/db/queries/backup-messages.ts";
import { insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import type { Database } from "../../../src/db/types.ts";
import { buildPlan } from "../../../src/services/restore/plan.ts";
import {
  DEFAULT_RESTORE_OPTIONS,
  RESTORE_PHASES,
  type RestoreOptions,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";

const BACKUP = "0190a000-0000-7000-8000-000000000001";
const GUILD = "123456789012345678";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
  await insertFixtureBackup(db, { backup_id: BACKUP });
  await insertBackupRoles(db, [
    {
      backup_id: BACKUP,
      source_role_id: GUILD,
      name: "@everyone",
      color: 0,
      hoist: false,
      mentionable: false,
      position: 0,
      permissions: "0",
      is_everyone: true,
      is_bot_managed: false,
      bot_id: null,
      integration_id: null,
      icon_url: null,
      unicode_emoji: null,
      tags_json: null,
    },
    {
      backup_id: BACKUP,
      source_role_id: "200",
      name: "mods",
      color: 0,
      hoist: false,
      mentionable: false,
      position: 1,
      permissions: "0",
      is_everyone: false,
      is_bot_managed: false,
      bot_id: null,
      integration_id: null,
      icon_url: null,
      unicode_emoji: null,
      tags_json: null,
    },
  ]);
  await insertBackupChannels(db, [
    {
      backup_id: BACKUP,
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
      backup_id: BACKUP,
      source_channel_id: "20",
      parent_source_id: "10",
      type: 0,
      name: "general",
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
  ]);
  await insertBackupMembers(db, [
    {
      backup_id: BACKUP,
      user_id: "900",
      username: "someone",
      global_name: null,
      discriminator: "0",
      nickname: null,
      avatar_url: null,
      joined_at: null,
      is_bot: false,
      role_ids_json: ["200"],
      pending: false,
      timed_out_until: null,
      premium_since: null,
      flags: null,
      source_role_names_json: ["mods"],
    },
  ]);
  await insertBackupMessages(db, [message(BACKUP, "20", "500"), message(BACKUP, "20", "501")]);
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function message(backupId: string, channelId: string, id: string) {
  return {
    backup_id: backupId,
    channel_source_id: channelId,
    message_id: id,
    author_id: "900",
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
    created_at: "2024-06-01T00:00:00.000Z",
    edited_at: null,
  };
}

function options(overrides: Partial<RestoreOptions> = {}): RestoreOptions {
  return { ...DEFAULT_RESTORE_OPTIONS, ...overrides };
}

describe("buildPlan", () => {
  test("an empty backup plans nothing but still lists the phases", async () => {
    const plan = await buildPlan(db, "no-such-backup", options());
    expect(plan.ops).toEqual([]);
    expect(plan.phases.map((phase) => phase.phase)).toEqual([...RESTORE_PHASES]);
    expect(plan.notes[0]).toContain("gone");
  });

  test("the ops come out in the order the phases run", async () => {
    const plan = await buildPlan(db, BACKUP, options());
    expect(plan.phases.map((phase) => phase.phase)).toEqual([...RESTORE_PHASES]);
  });

  test("the counts are the counts the backup holds", async () => {
    const plan = await buildPlan(db, BACKUP, options());
    expect(plan.counts.roles).toBe(2);
    expect(plan.counts.channels).toBe(2);
    expect(plan.counts.members).toBe(1);
    expect(plan.counts.messages).toBe(2);
  });

  test("a category turned off produces no op for it", async () => {
    const plan = await buildPlan(db, BACKUP, options({ roles: false, members: false }));
    expect(plan.ops.some((op) => op.phase === "roles")).toBe(false);
    expect(plan.ops.some((op) => op.phase === "members")).toBe(false);
    expect(plan.ops.some((op) => op.phase === "channels")).toBe(true);
  });

  test("the message ceiling caps the messages op, and says what is left out", async () => {
    const plan = await buildPlan(db, BACKUP, options({ messageLimit: 1 }));
    const op = plan.ops.find((entry) => entry.phase === "messages");
    expect(op?.count).toBe(1);
    expect(plan.notes.some((note) => note.includes("beyond the ceiling"))).toBe(true);
  });

  test("the member mode says what it would do", async () => {
    const rolesOnly = await buildPlan(db, BACKUP, options({ memberMode: 1 }));
    expect(rolesOnly.ops.find((op) => op.phase === "members")?.what).toContain("roles");
    const withNick = await buildPlan(db, BACKUP, options({ memberMode: 2 }));
    expect(withNick.ops.find((op) => op.phase === "members")?.what).toContain("nicknames");
    const sync = await buildPlan(db, BACKUP, options({ memberMode: 3 }));
    expect(sync.ops.find((op) => op.phase === "members")?.what).toContain("sync");
  });

  test("clearing the target is the first op", async () => {
    const plan = await buildPlan(db, BACKUP, options({ clearBefore: true }));
    expect(plan.ops[0]?.phase).toBe("guild");
    expect(plan.ops[0]?.what).toContain("clear the target");
  });

  test("a backup that failed its own check says so", async () => {
    const broken = "0190a000-0000-7000-8000-0000000000b1";
    await insertFixtureBackup(db, {
      backup_id: broken,
      self_check_json: { ok: false, failures: ["a channel has no parent"], skipped: [] },
    });
    const plan = await buildPlan(db, broken, options());
    expect(plan.notes.some((note) => note.includes("incomplete"))).toBe(true);
  });
});
