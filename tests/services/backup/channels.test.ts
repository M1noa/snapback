// tests/services/backup/channels.test.ts. captureChannels and captureThreads
// (D4PLAN 11.3) against a real temp-file duckdb and the fixture guild: categories
// before their children, overwrite targets resolved by name from rows already in
// the db, a 64-bit allow/deny surviving as a string, and threads kept out of
// backup_channels.
//
// each test uses its own backup_id so the primary keys never collide across cases.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  countBackupChannelsByBackup,
  listBackupChannelsByBackup,
} from "../../../src/db/queries/backup-channels.ts";
import { insertBackupMembers } from "../../../src/db/queries/backup-members.ts";
import {
  countBackupChannelOverwritesByBackup,
  listBackupChannelOverwritesByBackup,
} from "../../../src/db/queries/backup-overwrites.ts";
import { insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import { listBackupThreadsByBackup } from "../../../src/db/queries/backup-threads.ts";
import type { BackupMemberRow, BackupRoleRow, Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureChannels, captureThreads } from "../../../src/services/backup/channels.ts";
import type { BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  CATEGORY_ID,
  CHANNEL_GENERAL,
  CHANNEL_MEMES,
  CHANNEL_VOICE,
  counts,
  makeContext,
  makeGuild,
  makeSettings,
  ROLE_MEMBERS,
  ROLE_MODS,
  restStub,
  THREAD_ACTIVE,
  THREAD_ARCHIVED,
  USER_PENDING,
} from "../../fixtures/guild.ts";

// the widest a permission bitfield gets: 2^63-1, above 2^53.
const MAX_BITS = "9223372036854775807";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function backupId(n: number): string {
  return `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

// a context whose client is a stub the test can read routes()/fail() from.
function contextWithStub(options: Parameters<typeof makeContext>[0]): {
  ctx: BackupContext;
  stub: ReturnType<typeof restStub>;
} {
  const stub = restStub(options.guild);
  const ctx: BackupContext = { ...makeContext(options), client: stub.client };
  return { ctx, stub };
}

// a full role row: captureChannels reads only id and name, but the insert binds
// every column, so the row must carry them all.
function roleRow(
  backup: string,
  sourceRoleId: string,
  name: string,
  position: number,
): BackupRoleRow {
  return {
    backup_id: backup,
    source_role_id: sourceRoleId,
    name,
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

function memberRow(
  backup: string,
  userId: string,
  username: string,
  nickname: string | null,
  globalName: string | null,
): BackupMemberRow {
  return {
    backup_id: backup,
    user_id: userId,
    username,
    global_name: globalName,
    discriminator: "0",
    nickname,
    avatar_url: null,
    joined_at: null,
    is_bot: false,
    role_ids_json: [],
    pending: false,
    timed_out_until: null,
    premium_since: null,
    flags: 0,
    source_role_names_json: [],
  };
}

// seed the roles and member an overwrite names, so target_name resolves from the
// rows already in the db rather than a fresh request (11.3).
async function seedOverwriteTargets(backup: string): Promise<void> {
  await insertBackupRoles(db, [
    roleRow(backup, ROLE_MODS, "mods", 0),
    roleRow(backup, ROLE_MEMBERS, "members", 1),
  ]);
  await insertBackupMembers(db, [memberRow(backup, USER_PENDING, "pending", null, null)]);
}

describe("captureChannels", () => {
  test("categories come back before their children; non-categories keep position order", async () => {
    const guild = makeGuild();
    const id = backupId(1);

    await captureChannels(makeContext({ db, guild, backupId: id }));

    const rows = await listBackupChannelsByBackup(db, id);
    expect(rows.map((row) => row.source_channel_id)).toEqual([
      CATEGORY_ID,
      CHANNEL_GENERAL,
      CHANNEL_VOICE,
      CHANNEL_MEMES,
    ]);
    expect(rows.map((row) => row.type)).toEqual([4, 0, 2, 0]);

    const categoryIndex = rows.findIndex((row) => row.source_channel_id === CATEGORY_ID);
    for (const child of [CHANNEL_GENERAL, CHANNEL_MEMES, CHANNEL_VOICE]) {
      expect(rows.findIndex((row) => row.source_channel_id === child)).toBeGreaterThan(
        categoryIndex,
      );
    }
  });

  test("a child keeps its category source id; a top-level channel stores null", async () => {
    const guild = makeGuild();
    const id = backupId(2);

    await captureChannels(makeContext({ db, guild, backupId: id }));

    const rows = await listBackupChannelsByBackup(db, id);
    const byId = new Map(rows.map((row) => [row.source_channel_id, row]));
    expect(byId.get(CATEGORY_ID)?.parent_source_id).toBeNull();
    expect(byId.get(CHANNEL_GENERAL)?.parent_source_id).toBe(CATEGORY_ID);
    expect(byId.get(CHANNEL_MEMES)?.parent_source_id).toBe(CATEGORY_ID);
    expect(byId.get(CHANNEL_VOICE)?.parent_source_id).toBe(CATEGORY_ID);
  });

  test("overwrites resolve target names from the seeded roles and member", async () => {
    const guild = makeGuild();
    const id = backupId(3);
    await seedOverwriteTargets(id);

    await captureChannels(makeContext({ db, guild, backupId: id }));

    const rows = (await listBackupChannelOverwritesByBackup(db, id)).filter(
      (row) => row.source_channel_id === CHANNEL_GENERAL,
    );
    expect(rows).toHaveLength(3);

    const byTarget = new Map(rows.map((row) => [row.source_target_id, row]));
    expect(byTarget.get(ROLE_MODS)?.target_type).toBe("role");
    expect(byTarget.get(ROLE_MODS)?.target_name).toBe("mods");
    expect(byTarget.get(ROLE_MODS)?.deny).toBe("2048");
    expect(byTarget.get(ROLE_MEMBERS)?.target_type).toBe("role");
    expect(byTarget.get(ROLE_MEMBERS)?.target_name).toBe("members");
    expect(byTarget.get(ROLE_MEMBERS)?.allow).toBe("66560");
    expect(byTarget.get(USER_PENDING)?.target_type).toBe("member");
    expect(byTarget.get(USER_PENDING)?.target_name).toBe("pending");

    // allow / deny cross the db as bigints but come back as strings.
    for (const row of rows) {
      expect(typeof row.allow).toBe("string");
      expect(typeof row.deny).toBe("string");
    }
  });

  test("an allow / deny bitfield above 2^53 survives as a string", async () => {
    const base = makeGuild();
    const guild = makeGuild({
      channels: base.channels.map((channel) =>
        String(channel.id) === CHANNEL_GENERAL
          ? {
              ...channel,
              permission_overwrites: [{ id: ROLE_MODS, type: 0, allow: MAX_BITS, deny: MAX_BITS }],
            }
          : channel,
      ),
    });
    const id = backupId(4);
    await insertBackupRoles(db, [roleRow(id, ROLE_MODS, "mods", 0)]);

    await captureChannels(makeContext({ db, guild, backupId: id }));

    const rows = await listBackupChannelOverwritesByBackup(db, id);
    const overwrite = rows.find(
      (row) => row.source_channel_id === CHANNEL_GENERAL && row.source_target_id === ROLE_MODS,
    );
    expect(overwrite?.allow).toBe(MAX_BITS);
    expect(overwrite?.deny).toBe(MAX_BITS);
    expect(typeof overwrite?.allow).toBe("string");
    expect(typeof overwrite?.deny).toBe("string");
  });

  test("an overwrite to an uncaptured target stores an empty name and one skip", async () => {
    const unknown = "10000000000000000999";
    const base = makeGuild();
    const guild = makeGuild({
      channels: base.channels.map((channel) =>
        String(channel.id) === CHANNEL_MEMES
          ? {
              ...channel,
              permission_overwrites: [{ id: unknown, type: 0, allow: "0", deny: "0" }],
            }
          : channel,
      ),
    });
    const id = backupId(5);
    // seed the ones that should resolve, leaving only the unknown target unresolved.
    await seedOverwriteTargets(id);

    const ctx = makeContext({ db, guild, backupId: id });
    await captureChannels(ctx);

    const rows = await listBackupChannelOverwritesByBackup(db, id);
    const unresolved = rows.filter((row) => row.target_name === "");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.source_target_id).toBe(unknown);

    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("channels");
  });

  test("written counts channels and overwrites; counts.channels counts channels alone", async () => {
    const guild = makeGuild();
    const id = backupId(6);

    const result = await captureChannels(makeContext({ db, guild, backupId: id }));

    expect(result.written).toBe(counts(guild).channels + counts(guild).overwrites);
    expect(result.counts?.channels).toBe(counts(guild).channels);
    expect(await countBackupChannelsByBackup(db, id)).toBe(counts(guild).channels);
    expect(await countBackupChannelOverwritesByBackup(db, id)).toBe(counts(guild).overwrites);
  });

  test("threads land in backup_threads and never in backup_channels", async () => {
    const guild = makeGuild();
    const id = backupId(7);
    const ctx = makeContext({ db, guild, backupId: id });

    await captureChannels(ctx);
    await captureThreads(ctx);

    const channels = await listBackupChannelsByBackup(db, id);
    const channelIds = new Set(channels.map((row) => row.source_channel_id));
    expect(channelIds.has(THREAD_ACTIVE)).toBe(false);
    expect(channelIds.has(THREAD_ARCHIVED)).toBe(false);
    expect(channels.every((row) => ![10, 11, 12].includes(row.type))).toBe(true);

    const threads = await listBackupThreadsByBackup(db, id);
    expect(threads).toHaveLength(2);
    const byId = new Map(threads.map((thread) => [thread.source_thread_id, thread]));
    expect(byId.get(THREAD_ACTIVE)).toMatchObject({
      source_parent_id: CHANNEL_GENERAL,
      type: 11,
      archived: false,
      locked: false,
    });
    expect(byId.get(THREAD_ARCHIVED)).toMatchObject({
      source_parent_id: CHANNEL_GENERAL,
      type: 10,
      archived: true,
      locked: true,
    });
  });

  test("messages off records one skip and makes no thread request", async () => {
    const guild = makeGuild();
    const id = backupId(8);
    const settings = makeSettings({
      backup_include: { ...makeSettings().backup_include, messages: false },
    });
    const { ctx, stub } = contextWithStub({ db, guild, backupId: id, settings });

    const result = await captureThreads(ctx);

    expect(result).toEqual({ written: 0 });
    expect(stub.routes().some((route) => route.includes("/threads/"))).toBe(false);
    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("threads");
  });

  test("channels off writes nothing and makes no request", async () => {
    const guild = makeGuild();
    const id = backupId(9);
    const settings = makeSettings({
      backup_include: { ...makeSettings().backup_include, channels: false },
    });
    const { ctx, stub } = contextWithStub({ db, guild, backupId: id, settings });

    const result = await captureChannels(ctx);

    expect(result).toEqual({ written: 0 });
    expect(stub.routes()).toEqual([]);
  });

  test("a 403 on one channel's archived list is one skip and the rest still captures", async () => {
    const guild = makeGuild();
    const id = backupId(10);
    const { ctx, stub } = contextWithStub({ db, guild, backupId: id });
    // seed the overwrite targets, so captureChannels records no skips and the one
    // thread skip below is the only entry.
    await seedOverwriteTargets(id);
    await captureChannels(ctx);

    const route = `GET /channels/${CHANNEL_MEMES}/threads/archived/public`;
    stub.fail(
      route,
      new DiscordApiError({
        status: 403,
        route,
        method: "GET",
        body: JSON.stringify({ code: 50001, message: "Missing Access" }),
      }),
    );

    const result = await captureThreads(ctx);

    expect(result.written).toBe(2);
    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("threads");
    expect(skips[0]?.why).toBe("Missing Access");
    expect(await listBackupThreadsByBackup(db, id)).toHaveLength(2);
  });
});
