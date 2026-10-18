// tests/services/backup/events.test.ts
// scheduled events capture (D4PLAN 11 step 12). the contract this pins: the
// event's timestamps, enums and entity metadata are stored (end null when there
// is none), the cover image is downloaded once under the guild kind keyed by the
// event id, the stored cover url is the one the module derived, the request asks
// for the user counts inline, and a 403 is one skip in discord's own words.
//
// the fixture helpers live in tests/fixtures/db.ts and tests/fixtures/guild.ts;
// this file imports them by those names.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  countBackupEventsByBackup,
  listBackupEventsByBackup,
} from "../../../src/db/queries/backup-events.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureEvents } from "../../../src/services/backup/events.ts";
import type { AssetStore, BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";
import {
  counts,
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  type FixtureGuild,
  makeContext,
  makeGuild,
  type RestStub,
  restStub,
} from "../../fixtures/guild.ts";

// the key restStub.fail() indexes by: method plus the route without its query.
const ROUTE = `GET /guilds/${FIXTURE_GUILD_ID}/scheduled-events`;

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
  await insertFixtureBackup(db);
});

afterAll(async () => {
  await closeFixtureDb(db);
});

beforeEach(async () => {
  await db.run("DELETE FROM backup_events");
});

// makeContext builds its own stub and hands back only the client. the test needs
// routes(), calls() and fail() reachable, so it builds its own stub and swaps the
// client into the context makeContext returned.
function harness(
  fixture: FixtureGuild,
  assets?: AssetStore,
): { stub: RestStub; ctx: BackupContext } {
  const stub = restStub(fixture);
  return { stub, ctx: { ...makeContext({ db, guild: fixture, assets }), client: stub.client } };
}

// records every save() call, so a test can assert exactly what was downloaded
// without the real store touching disk.
function recordingAssets(): {
  assets: AssetStore;
  saves: { kind: string; name: string; url: string | null }[];
} {
  const saves: { kind: string; name: string; url: string | null }[] = [];
  const assets: AssetStore = {
    dir: "/tmp/snapback-fixture-assets",
    save: async (kind, name, url) => {
      saves.push({ kind, name, url });
      return url === null ? null : { url, path: `assets/${kind}/${name}`, bytes: 0 };
    },
    pathFor: (kind, name) => `assets/${kind}/${name}`,
  };
  return { assets, saves };
}

describe("captureEvents", () => {
  test("stores the fixture's event with its timestamps, enums and metadata", async () => {
    const fixture = makeGuild();
    const source = fixture.events[0] as Record<string, unknown>;
    const { ctx } = harness(fixture);

    const result = await captureEvents(ctx);
    expect(result.written).toBe(counts(fixture).events);

    const rows = await listBackupEventsByBackup(db, FIXTURE_BACKUP_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.backup_id).toBe(FIXTURE_BACKUP_ID);
    expect(row?.source_event_id).toBe(String(source.id));
    expect(row?.name).toBe("fixture event");
    expect(row?.description).toBe("a scheduled event");
    expect(row?.scheduled_start).toBe(source.scheduled_start_time as string | null);
    expect(row?.scheduled_end).toBe(source.scheduled_end_time as string | null);
    expect(row?.privacy_level).toBe(2);
    expect(row?.entity_type).toBe(3);
    expect(row?.status).toBe(1);
    expect(typeof row?.entity_metadata_json).toBe("object");
    expect(row?.entity_metadata_json).toEqual({ location: "somewhere" });
  });

  test("downloads the cover once under the guild kind with the event id as its name", async () => {
    const fixture = makeGuild();
    const eventId = String(fixture.events[0]?.id);
    const { assets, saves } = recordingAssets();
    const { ctx } = harness(fixture, assets);

    await captureEvents(ctx);

    expect(saves).toHaveLength(1);
    expect(saves[0]?.kind).toBe("guild");
    expect(saves[0]?.name).toBe(eventId);

    const row = (await listBackupEventsByBackup(db, FIXTURE_BACKUP_ID))[0];
    // assert the derived url's shape, not a hardcoded hash: cdn host, the
    // guild-events path, the event id, and a .png hash.
    expect(row?.cover_url).toMatch(
      new RegExp(`^https://cdn\\.discordapp\\.com/guild-events/${eventId}/.+\\.png$`),
    );
    expect(saves[0]?.url).toBe(row?.cover_url);
  });

  test("an event with no image stores a null cover, records no skip, downloads nothing", async () => {
    const base = makeGuild();
    const source = base.events[0] as Record<string, unknown>;
    const fixture = makeGuild({ events: [{ ...source, image: null, cover_image: null }] });
    const { assets, saves } = recordingAssets();
    const { ctx } = harness(fixture, assets);

    await captureEvents(ctx);

    const row = (await listBackupEventsByBackup(db, FIXTURE_BACKUP_ID))[0];
    expect(row?.cover_url).toBeNull();
    expect(ctx.skips.size).toBe(0);
    expect(saves).toHaveLength(0);
  });

  test("asks for the user counts alongside the events on the scheduled-events route", async () => {
    const fixture = makeGuild();
    const { stub, ctx } = harness(fixture);

    await captureEvents(ctx);

    expect(stub.routes()).toEqual([`GET /guilds/${FIXTURE_GUILD_ID}/scheduled-events`]);
    const call = stub.calls()[0];
    expect(call?.method).toBe("GET");
    expect(call?.route).toBe(`/guilds/${FIXTURE_GUILD_ID}/scheduled-events?with_user_count=true`);
  });

  test("a 403 is one skip in discord's own words and writes nothing", async () => {
    const fixture = makeGuild();
    const { stub, ctx } = harness(fixture);
    stub.fail(
      ROUTE,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/scheduled-events`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );

    const result = await captureEvents(ctx);

    expect(result).toEqual({ written: 0 });
    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toEqual({
      category: "events",
      what: "all scheduled events",
      why: "50013 Missing Permissions",
    });
    expect(await countBackupEventsByBackup(db, FIXTURE_BACKUP_ID)).toBe(0);
  });

  test("an event with no end keeps a null scheduled_end", async () => {
    const base = makeGuild();
    const source = base.events[0] as Record<string, unknown>;
    const fixture = makeGuild({ events: [{ ...source, scheduled_end_time: null }] });
    const { ctx } = harness(fixture);

    await captureEvents(ctx);

    const row = (await listBackupEventsByBackup(db, FIXTURE_BACKUP_ID))[0];
    expect(row?.scheduled_end).toBeNull();
  });
});
