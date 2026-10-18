// tests/services/backup/guild.test.ts
//
// d4plan 11 steps 1, 2 and 10: the guild step writes the row's own fields and
// urls, downloads the four images, and reads the widget, welcome screen and
// vanity url as optional extras. the suite drives the fixture guild through the
// real duckdb, so the json columns round-trip rather than a mock.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBackup } from "../../../src/db/queries/backups.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureGuild } from "../../../src/services/backup/guild.ts";
import type { AssetKind, AssetStore, BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_GENERAL,
  CHANNEL_VOICE,
  FIXTURE_GUILD_ID,
  makeContext,
  makeGuild,
  restStub,
  USER_NICK,
} from "../../fixtures/guild.ts";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// one row per test: the file shares a database, and backups primary-key on id.
const ROW_FIELDS = "0190a000-0000-7000-8000-000000000101";
const ROW_ASSETS = "0190a000-0000-7000-8000-000000000102";
const ROW_SETTINGS = "0190a000-0000-7000-8000-000000000103";
const ROW_SETTINGS_OMIT = "0190a000-0000-7000-8000-000000000104";
const ROW_AFK = "0190a000-0000-7000-8000-000000000105";
const ROW_WIDGET = "0190a000-0000-7000-8000-000000000106";
const ROW_WIDGET_FAIL = "0190a000-0000-7000-8000-000000000107";
const ROW_WELCOME = "0190a000-0000-7000-8000-000000000108";
const ROW_WELCOME_OFF = "0190a000-0000-7000-8000-000000000109";
const ROW_WELCOME_FAIL = "0190a000-0000-7000-8000-000000000110";
const ROW_VANITY_FAIL = "0190a000-0000-7000-8000-000000000111";

const CDN = "https://cdn.discordapp.com";
// the fixture's hashes: an animated icon, a banner, a discovery splash, no splash.
const ICON_URL = `${CDN}/icons/${FIXTURE_GUILD_ID}/a_iconhash.gif`;
const BANNER_URL = `${CDN}/banners/${FIXTURE_GUILD_ID}/bannerhash.png`;
const DISCOVERY_URL = `${CDN}/discovery-splashes/${FIXTURE_GUILD_ID}/splashhash.png`;

interface SavedAsset {
  kind: AssetKind;
  name: string;
  url: string | null;
}

// the capture downloads through ctx.assets. a store that records instead of
// writing is how the test sees exactly which assets it asked for.
function recordingAssets(): { store: AssetStore; saved: SavedAsset[] } {
  const saved: SavedAsset[] = [];
  const store: AssetStore = {
    dir: "/tmp/snapback-guild-test-assets",
    save: async (kind, name, url) => {
      saved.push({ kind, name, url });
      return url === null ? null : { url, path: `assets/${kind}/${name}`, bytes: 0 };
    },
    pathFor: (kind, name) => `assets/${kind}/${name}`,
  };
  return { store, saved };
}

describe("captureGuild", () => {
  test("fills the row's guild fields, urls, owner, and reports one write", async () => {
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_FIELDS });
    const ctx = makeContext({ db, guild, backupId: row.backup_id });

    const result = await captureGuild(ctx);
    expect(result).toEqual({ written: 1 });

    const stored = await getBackup(db, row.backup_id);
    expect(stored?.guild_name).toBe("fixture guild");
    expect(stored?.icon_url).toBe(ICON_URL);
    expect(stored?.banner_url).toBe(BANNER_URL);
    expect(stored?.splash_url).toBeNull();
    expect(stored?.discovery_splash_url).toBe(DISCOVERY_URL);
    expect(stored?.owner_user_id).toBe(USER_NICK);
  });

  test("downloads each present asset once, and the absent splash silently", async () => {
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_ASSETS });
    const { store, saved } = recordingAssets();
    const ctx = makeContext({ db, guild, backupId: row.backup_id, assets: store });

    const result = await captureGuild(ctx);

    expect(result).toEqual({ written: 1 });
    // three present assets, in the order the step saves them. the fixture has no
    // splash, so there is no fourth call and no skip for it.
    expect(saved.map((asset) => asset.name)).toEqual(["icon", "banner", "discovery_splash"]);
    expect(saved.every((asset) => asset.kind === "guild")).toBe(true);
    expect(saved[0]?.url).toBe(ICON_URL);
    expect(saved[1]?.url).toBe(BANNER_URL);
    expect(saved[2]?.url).toBe(DISCOVERY_URL);
    expect(ctx.skips.all()).toEqual([]);
  });

  test("stores the guild settings the plan lists, a missing one as null not absent", async () => {
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_SETTINGS });
    await captureGuild(makeContext({ db, guild, backupId: row.backup_id }));

    expect((await getBackup(db, row.backup_id))?.guild_settings_json).toEqual({
      verification_level: 1,
      explicit_content_filter: 0,
      default_message_notifications: 0,
      preferred_locale: "en-US",
      system_channel_id: CHANNEL_GENERAL,
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
      premium_tier: 0,
    });

    // a field discord does not send is stored as null, never dropped from the blob.
    const trimmed = makeGuild();
    delete (trimmed.guild as Record<string, unknown>).verification_level;
    const row2 = await insertFixtureBackup(db, { backup_id: ROW_SETTINGS_OMIT });
    await captureGuild(makeContext({ db, guild: trimmed, backupId: row2.backup_id }));

    const settings = (await getBackup(db, row2.backup_id))?.guild_settings_json;
    expect(settings).not.toBeNull();
    expect("verification_level" in (settings ?? {})).toBe(true);
    expect(settings?.verification_level).toBeNull();
  });

  test("stores the afk channel and timeout from the guild object", async () => {
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_AFK });
    await captureGuild(makeContext({ db, guild, backupId: row.backup_id }));

    expect((await getBackup(db, row.backup_id))?.afk_json).toEqual({
      afk_channel_id: CHANNEL_VOICE,
      afk_timeout: 300,
    });
  });

  test("stores the widget, and keeps the prior value when the widget read fails", async () => {
    // present: stored as discord returned it.
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_WIDGET });
    await captureGuild(makeContext({ db, guild, backupId: row.backup_id }));
    expect((await getBackup(db, row.backup_id))?.widget_json).toEqual({
      enabled: true,
      channel_id: CHANNEL_GENERAL,
    });

    // failing: a 403 is one skip, the column keeps what it already held, and the
    // step still reports its write.
    const failed = makeGuild();
    const stub = restStub(failed);
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/widget`,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/widget`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );
    const previous = { enabled: false, channel_id: null };
    const row2 = await insertFixtureBackup(db, {
      backup_id: ROW_WIDGET_FAIL,
      widget_json: previous,
    });
    const ctx: BackupContext = {
      ...makeContext({ db, guild: failed, backupId: row2.backup_id }),
      client: stub.client,
    };

    const result = await captureGuild(ctx);

    expect(result).toEqual({ written: 1 });
    expect(ctx.skips.all()).toHaveLength(1);
    expect(ctx.skips.all()[0]?.what).toBe("widget");
    expect((await getBackup(db, row2.backup_id))?.widget_json).toEqual(previous);
  });

  test("carries the WELCOME_SCREEN_ENABLED feature flag beside the welcome screen", async () => {
    const guild = makeGuild();
    const row = await insertFixtureBackup(db, { backup_id: ROW_WELCOME });
    await captureGuild(makeContext({ db, guild, backupId: row.backup_id }));
    expect((await getBackup(db, row.backup_id))?.welcome_screen_json).toEqual({
      ...guild.welcomeScreen,
      welcome_screen_enabled: true,
    });

    // the feature absent means the screen is captured but flagged off.
    const noFlag = makeGuild();
    noFlag.guild = { ...noFlag.guild, features: ["COMMUNITY"] };
    const row2 = await insertFixtureBackup(db, { backup_id: ROW_WELCOME_OFF });
    await captureGuild(makeContext({ db, guild: noFlag, backupId: row2.backup_id }));
    expect((await getBackup(db, row2.backup_id))?.welcome_screen_json).toEqual({
      ...noFlag.welcomeScreen,
      welcome_screen_enabled: false,
    });
  });

  test("a failed welcome-screen read is one skip with discord's words, not a failed capture", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/welcome-screen`,
      new DiscordApiError({
        status: 404,
        route: `/guilds/${FIXTURE_GUILD_ID}/welcome-screen`,
        method: "GET",
        body: JSON.stringify({ code: 10068, message: "Unknown Guild" }),
      }),
    );
    const row = await insertFixtureBackup(db, { backup_id: ROW_WELCOME_FAIL });
    const ctx: BackupContext = {
      ...makeContext({ db, guild, backupId: row.backup_id }),
      client: stub.client,
    };

    const result = await captureGuild(ctx);

    expect(result).toEqual({ written: 1 });
    expect(ctx.skips.all()).toHaveLength(1);
    expect(ctx.skips.all()[0]?.why).toBe("10068 Unknown Guild");
    expect((await getBackup(db, row.backup_id))?.welcome_screen_json).toBeNull();
  });

  test("a 403 on the vanity url is one skip and does not fail the capture", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/vanity-url`,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/vanity-url`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );
    const row = await insertFixtureBackup(db, { backup_id: ROW_VANITY_FAIL });
    const ctx: BackupContext = {
      ...makeContext({ db, guild, backupId: row.backup_id }),
      client: stub.client,
    };

    const result = await captureGuild(ctx);

    expect(result).toEqual({ written: 1 });
    expect(ctx.skips.all()).toHaveLength(1);
    expect(ctx.skips.all()[0]?.what).toBe("vanity url");
  });
});
