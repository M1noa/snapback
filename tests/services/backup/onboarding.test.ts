// tests/services/backup/onboarding.test.ts
//
// d4plan 11 step 9: the onboarding prompts and default channels. the step is
// gated by the include set, and a guild without COMMUNITY answers 404, so the
// two failure paths (turned off, not available) are both one skip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBackup } from "../../../src/db/queries/backups.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureOnboarding } from "../../../src/services/backup/onboarding.ts";
import type { BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_GENERAL,
  CHANNEL_MEMES,
  FIXTURE_GUILD_ID,
  makeContext,
  makeGuild,
  makeSettings,
  restStub,
} from "../../fixtures/guild.ts";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// one row per test: the file shares a database, and backups primary-key on id.
const ROW_ON = "0190a000-0000-7000-8000-000000000201";
const ROW_GATE = "0190a000-0000-7000-8000-000000000202";
const ROW_404 = "0190a000-0000-7000-8000-000000000203";
const ROW_REPLACE = "0190a000-0000-7000-8000-000000000204";

describe("captureOnboarding", () => {
  test("stores the prompts, default channels, mode and enabled", async () => {
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_ON });

    const result = await captureOnboarding(makeContext({ db, guild, backupId: row.backup_id }));

    expect(result).toEqual({ written: 1 });
    const stored = (await getBackup(db, row.backup_id))?.onboarding_json;
    expect(stored).toEqual(guild.onboarding);
    expect(stored?.mode).toBe(1);
    expect(stored?.enabled).toBe(true);
    expect(stored?.default_channel_ids).toEqual([CHANNEL_GENERAL]);
    expect(Array.isArray(stored?.prompts)).toBe(true);
  });

  test("the include gate writes nothing, makes no request, and is one skip", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    const previous = {
      guild_id: FIXTURE_GUILD_ID,
      prompts: [],
      default_channel_ids: [],
      mode: 0,
      enabled: false,
    };
    const row = await insertFixtureBackup(db, { backup_id: ROW_GATE, onboarding_json: previous });
    const settings = makeSettings({
      backup_include: { ...makeSettings().backup_include, onboarding: false },
    });
    const ctx: BackupContext = {
      ...makeContext({ db, guild, backupId: row.backup_id, settings }),
      client: stub.client,
    };

    const result = await captureOnboarding(ctx);

    expect(result).toEqual({ written: 0 });
    expect(ctx.skips.all()).toHaveLength(1);
    expect(stub.calls()).toHaveLength(0);
    // the column keeps whatever it held, since the step never reached the write.
    expect((await getBackup(db, row.backup_id))?.onboarding_json).toEqual(previous);
  });

  test("a 404 for a guild with no onboarding is one skip with discord's words", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/onboarding`,
      new DiscordApiError({
        status: 404,
        route: `/guilds/${FIXTURE_GUILD_ID}/onboarding`,
        method: "GET",
        body: JSON.stringify({ code: 10068, message: "Unknown Guild" }),
      }),
    );
    const row = await insertFixtureBackup(db, { backup_id: ROW_404 });
    const ctx: BackupContext = {
      ...makeContext({ db, guild, backupId: row.backup_id }),
      client: stub.client,
    };

    const result = await captureOnboarding(ctx);

    expect(result).toEqual({ written: 0 });
    expect(ctx.skips.all()).toHaveLength(1);
    expect(ctx.skips.all()[0]?.why).toBe("10068 Unknown Guild");
    expect((await getBackup(db, row.backup_id))?.onboarding_json).toBeNull();
  });

  test("a second capture replaces the stored value rather than appending", async () => {
    const row = await insertFixtureBackup(db, { backup_id: ROW_REPLACE });

    const first = makeGuild();
    await captureOnboarding(makeContext({ db, guild: first, backupId: row.backup_id }));
    expect((await getBackup(db, row.backup_id))?.onboarding_json).toEqual(first.onboarding);

    const second = makeGuild();
    second.onboarding = {
      ...second.onboarding,
      default_channel_ids: [CHANNEL_MEMES],
      mode: 0,
      enabled: false,
    };
    await captureOnboarding(makeContext({ db, guild: second, backupId: row.backup_id }));

    const stored = (await getBackup(db, row.backup_id))?.onboarding_json;
    expect(stored).toEqual(second.onboarding);
    expect(stored?.default_channel_ids).toEqual([CHANNEL_MEMES]);
    expect(stored?.mode).toBe(0);
    expect(stored?.enabled).toBe(false);
  });
});
