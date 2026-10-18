// tests/services/backup/automod.test.ts
// automod capture (D4PLAN 11 step 11). the contract this pins: every column of a
// rule is stored, the two json columns come back parsed with their nested arrays
// and objects intact, a disabled rule stays disabled, a 403 is one skip carrying
// discord's own words rather than a thrown error, and an empty list is a no-op.
//
// the fixture helpers live in tests/fixtures/db.ts and tests/fixtures/guild.ts;
// this file imports them by those names.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  countBackupAutomodsByBackup,
  listBackupAutomodsByBackup,
} from "../../../src/db/queries/backup-automod.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureAutomod } from "../../../src/services/backup/automod.ts";
import type { BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_MEMES,
  counts,
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  type FixtureGuild,
  makeContext,
  makeGuild,
  type RestStub,
  ROLE_MODS,
  restStub,
} from "../../fixtures/guild.ts";

// the key restStub.fail() and routes() are indexed by: method plus the route
// without its query, exactly as the stub builds it.
const ROUTE = `GET /guilds/${FIXTURE_GUILD_ID}/auto-moderation/rules`;

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
  await insertFixtureBackup(db);
});

afterAll(async () => {
  await closeFixtureDb(db);
});

beforeEach(async () => {
  await db.run("DELETE FROM backup_automod");
});

// makeContext builds its own stub and hands back only the client. the test needs
// the same handlers with routes(), calls() and fail() reachable, so it builds its
// own stub and swaps the client into the context makeContext returned.
function harness(fixture: FixtureGuild): { stub: RestStub; ctx: BackupContext } {
  const stub = restStub(fixture);
  return { stub, ctx: { ...makeContext({ db, guild: fixture }), client: stub.client } };
}

describe("captureAutomod", () => {
  test("stores the fixture's rule across every column", async () => {
    const fixture = makeGuild();
    const { ctx } = harness(fixture);

    const result = await captureAutomod(ctx);
    expect(result.written).toBe(counts(fixture).automod);

    const rows = await listBackupAutomodsByBackup(db, FIXTURE_BACKUP_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.backup_id).toBe(FIXTURE_BACKUP_ID);
    expect(row?.source_rule_id).toBe(String(fixture.automod[0]?.id));
    expect(row?.name).toBe("no invites");
    expect(row?.event_type).toBe(1);
    expect(row?.trigger_type).toBe(1);
    expect(row?.enabled).toBe(true);
    // json columns come back parsed, never as the stored string
    expect(typeof row?.trigger_metadata_json).toBe("object");
    expect(Array.isArray(row?.actions_json)).toBe(true);
    expect(row?.exempt_roles_json).toEqual([ROLE_MODS]);
    expect(row?.exempt_channels_json).toEqual([CHANNEL_MEMES]);
  });

  test("trigger metadata keeps its nested array and actions keep their metadata", async () => {
    const fixture = makeGuild();
    const { ctx } = harness(fixture);
    await captureAutomod(ctx);

    const row = (await listBackupAutomodsByBackup(db, FIXTURE_BACKUP_ID))[0];
    expect(Array.isArray(row?.trigger_metadata_json?.keyword_filter)).toBe(true);
    expect(row?.trigger_metadata_json?.keyword_filter).toEqual(["discord.gg"]);
    expect(row?.actions_json[0]?.metadata).toEqual({ custom_message: "no" });
  });

  test("a rule the operator disabled is stored disabled", async () => {
    const base = makeGuild();
    const rule = base.automod[0] as Record<string, unknown>;
    const fixture = makeGuild({ automod: [{ ...rule, enabled: false }] });
    const { ctx } = harness(fixture);

    await captureAutomod(ctx);

    const row = (await listBackupAutomodsByBackup(db, FIXTURE_BACKUP_ID))[0];
    expect(row?.enabled).toBe(false);
  });

  test("a 403 is one skip in discord's own words and writes nothing", async () => {
    const fixture = makeGuild();
    const { stub, ctx } = harness(fixture);
    stub.fail(
      ROUTE,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/auto-moderation/rules`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );

    const result = await captureAutomod(ctx);

    expect(result).toEqual({ written: 0 });
    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toEqual({
      category: "automod",
      what: "all auto-moderation rules",
      why: "50013 Missing Permissions",
    });
    expect(await countBackupAutomodsByBackup(db, FIXTURE_BACKUP_ID)).toBe(0);
  });

  test("an empty rule list writes nothing and records no skip", async () => {
    const fixture = makeGuild({ automod: [] });
    const { ctx } = harness(fixture);

    const result = await captureAutomod(ctx);

    expect(result.written).toBe(0);
    expect(ctx.skips.size).toBe(0);
    expect(await countBackupAutomodsByBackup(db, FIXTURE_BACKUP_ID)).toBe(0);
  });
});
