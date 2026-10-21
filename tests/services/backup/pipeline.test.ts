// tests/services/backup/pipeline.test.ts
//
// the phase-5 acceptance check (D4TODO): a scratch guild round-trips its counts,
// an over-limit channel clamps at the cap and not a page past it, and a backup
// that lost a step is stored incomplete rather than quietly complete.
//
// this drives the real pipeline over the fixture guild with the real database and
// no disk and no network, so it is the one test that sees the steps in the order
// they run in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listBackupChannelsByBackup } from "../../../src/db/queries/backup-channels.ts";
import { listBackupMessagesByBackup } from "../../../src/db/queries/backup-messages.ts";
import { listBackupChannelOverwritesByBackup } from "../../../src/db/queries/backup-overwrites.ts";
import { listBackupRolesByBackup } from "../../../src/db/queries/backup-roles.ts";
import { getBackup, listOpenBackups } from "../../../src/db/queries/backups.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { runBackup } from "../../../src/services/backup/index.ts";
import { BACKUP_SCHEMA_VERSION } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_GENERAL,
  counts,
  FIXTURE_GUILD_ID,
  makeGuild,
  makeSettings,
  restStub,
  stubAssets,
  USER_PENDING,
} from "../../fixtures/guild.ts";

const CREATED_BY = "987654321098765432";
const NOW = "2024-06-01T00:00:00.000Z";
const NO_ASSETS = "/tmp/snapback-pipeline-assets";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function run(options: {
  guild?: ReturnType<typeof makeGuild>;
  settings?: Parameters<typeof runBackup>[1]["settings"];
  label?: string | null;
}) {
  const guild = options.guild ?? makeGuild();
  const stub = restStub(guild);
  return runBackup(
    {
      db,
      client: stub.client,
      log: createLogger({ level: "error", dir: null }),
      now: () => NOW,
      // no disk and no network: the assets step is asserted in assets.test.ts.
      assets: () => stubAssets(),
    },
    {
      guildId: FIXTURE_GUILD_ID,
      kind: "manual",
      createdBy: CREATED_BY,
      label: options.label ?? "pipeline",
      settings: options.settings ?? makeSettings(),
      backupDir: NO_ASSETS,
      maxAssetBytes: 8 * 1024 * 1024,
    },
  );
}

describe("runBackup", () => {
  test("a scratch guild round-trips its counts, step by step", async () => {
    const guild = makeGuild();
    const expected = counts(guild);
    const { backup, check } = await run({ guild });

    // the counts on the sealed row are the counts that are really there. the
    // fixture's join notice (type 7) is filtered by the default type set, so the
    // stored total is one short of everything the channel holds.
    expect(backup.role_count).toBe(expected.roles);
    expect(backup.channel_count).toBe(expected.channels);
    expect(backup.member_count).toBe(expected.members);
    expect(backup.message_count).toBe(expected.messages - 1);
    expect(backup.schema_version).toBe(BACKUP_SCHEMA_VERSION);
    expect(backup.created_by).toBe(CREATED_BY);
    expect(backup.label).toBe("pipeline");
    expect(backup.guild_name).toBe("fixture guild");

    // and the rows are readable back out of the database.
    expect(await listBackupRolesByBackup(db, backup.backup_id)).toHaveLength(expected.roles);
    expect(await listBackupChannelsByBackup(db, backup.backup_id)).toHaveLength(expected.channels);
    const stored = await listBackupMessagesByBackup(db, backup.backup_id);
    expect(stored).toHaveLength(expected.messages - 1);
    // the filter is visible: no join notice, no boost, only conversation.
    expect(stored.some((row) => row.type === 7)).toBe(false);
    expect(stored.some((row) => row.type === 19)).toBe(true);

    // the fixture is coherent, so nothing a step reported disagrees with the rows.
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
  });

  test("a member overwrite keeps the member's name, which the step order has to allow", async () => {
    const { backup } = await run({});
    const overwrites = await listBackupChannelOverwritesByBackup(db, backup.backup_id);
    const onMember = overwrites.find(
      (row) => row.source_channel_id === CHANNEL_GENERAL && row.source_target_id === USER_PENDING,
    );
    expect(onMember?.target_type).toBe("member");
    // the channels step runs after the members step for exactly this line: read
    // the other way round, this name would be empty and the restore would warn.
    expect(onMember?.target_name).toBe("pending");
  });

  test("an over-limit channel clamps at the cap and not a page past it", async () => {
    const guild = makeGuild();
    // three of the five messages in the fixture's channel, so a second page would
    // be possible if the cap were not enforced.
    const settings = makeSettings({ auto_backup_message_count: 3 });
    const stub = restStub(guild);
    const { backup, check } = await runBackup(
      {
        db,
        client: stub.client,
        log: createLogger({ level: "error", dir: null }),
        now: () => NOW,
        assets: () => stubAssets(),
      },
      {
        guildId: FIXTURE_GUILD_ID,
        kind: "manual",
        createdBy: CREATED_BY,
        label: "clamped",
        settings,
        backupDir: NO_ASSETS,
        maxAssetBytes: 0,
      },
    );

    const messages = await listBackupMessagesByBackup(db, backup.backup_id);
    expect(messages).toHaveLength(3);
    expect(backup.message_count).toBe(3);
    expect(check.ok).toBe(true);

    // the channel in question asked exactly once, for only what was left, and no
    // page went past the cap even though the fixture holds five messages there.
    const calls = stub
      .calls()
      .filter((call) => call.route.startsWith(`/channels/${CHANNEL_GENERAL}/messages`));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe(`/channels/${CHANNEL_GENERAL}/messages?limit=3`);
  });

  test("a step that cannot be read is a skip, and the backup is still complete", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    // bans need BAN_MEMBERS. a 403 there is one skip, not a failed backup.
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/bans`,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/bans`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );

    const { backup, check } = await runBackup(
      {
        db,
        client: stub.client,
        log: createLogger({ level: "error", dir: null }),
        now: () => NOW,
        assets: () => stubAssets(),
      },
      {
        guildId: FIXTURE_GUILD_ID,
        kind: "manual",
        createdBy: CREATED_BY,
        label: "no bans",
        settings: makeSettings(),
        backupDir: NO_ASSETS,
        maxAssetBytes: 0,
      },
    );

    expect(check.ok).toBe(true);
    const skipped = backup.self_check_json?.skipped ?? [];
    const banSkip = skipped.find((skip) => skip.category === "bans");
    expect(banSkip?.why).toBe("50013 Missing Permissions");
  });

  test("a step that throws makes the backup incomplete, with the reason stored", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    // an unhandled route is a 404 the step does not catch: the pipeline records a
    // failure and keeps the rest of the work.
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/auto-moderation/rules`,
      new Error("the automod step blew up"),
    );

    const { backup, check } = await runBackup(
      {
        db,
        client: stub.client,
        log: createLogger({ level: "error", dir: null }),
        now: () => NOW,
        assets: () => stubAssets(),
      },
      {
        guildId: FIXTURE_GUILD_ID,
        kind: "manual",
        createdBy: CREATED_BY,
        label: "broken step",
        settings: makeSettings(),
        backupDir: NO_ASSETS,
        maxAssetBytes: 0,
      },
    );

    expect(check.ok).toBe(false);
    expect(
      check.failures.some((line) => line.includes("automod") && line.includes("blew up")),
    ).toBe(true);
    // stored, sealed, and marked: a partial backup is never a silent one.
    expect(backup.self_check_json?.ok).toBe(false);
    expect(backup.self_check_json?.failures.length).toBeGreaterThan(0);
    expect(await getBackup(db, backup.backup_id)).not.toBeNull();
  });

  test("a sealed backup stops being open", async () => {
    const { backup } = await run({});
    const open = await listOpenBackups(db, FIXTURE_GUILD_ID);
    expect(open.some((row) => row.backup_id === backup.backup_id)).toBe(false);
  });

  test("the checksum of the row is the size on disk, zero when there are no assets", async () => {
    const { backup } = await run({});
    expect(backup.size_bytes).toBe(0);
  });
});
