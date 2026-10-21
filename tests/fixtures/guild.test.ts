// tests/fixtures/guild.test.ts
//
// the fixture seam (AGENTS.md tests: "the fixture guild generator is the source
// of truth for shapes"). every capture suite drives makeGuild's payloads through
// restStub, so this file pins the seam they stand on: counts() matches the arrays
// it names, makeGuild is deterministic and returns fresh independent objects,
// every id is a string above 2^53, the stub answers every phase-5 route and pages
// on the documented cursors, and db.ts's openFixtureDb is a real migrated duckdb.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBackup } from "../../src/db/queries/backups.ts";
import type { Database } from "../../src/db/types.ts";
import { DiscordApiError } from "../../src/discord/errors.ts";
import { BACKUP_SCHEMA_VERSION } from "../../src/services/backup/types.ts";
import { closeFixtureDb, insertFixtureBackup, makeBackup, openFixtureDb } from "./db.ts";
import {
  CHANNEL_GENERAL,
  counts,
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  makeContext,
  makeGuild,
  makeSettings,
  restStub,
  stubAssets,
  USER_BOT,
  USER_NICK,
  USER_PENDING,
} from "./guild.ts";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// ---- counts() is the source of truth ----------------------------------------

describe("counts()", () => {
  test("matches the fixture the day it ships", () => {
    expect(counts(makeGuild())).toEqual({
      roles: 4,
      channels: 4,
      threads: 2,
      overwrites: 3,
      members: 3,
      messages: 5,
      bans: 1,
      emojis: 2,
      stickers: 1,
      sounds: 1,
      automod: 1,
      events: 1,
    });
  });

  test("equals the length of every array it names", () => {
    const fixture = makeGuild();
    const c = counts(fixture);
    expect(c.roles).toBe(fixture.roles.length);
    expect(c.channels).toBe(fixture.channels.length);
    expect(c.threads).toBe(fixture.threads.active.length + fixture.threads.archived.length);
    expect(c.members).toBe(fixture.members.length);
    expect(c.messages).toBe(
      Object.values(fixture.messagesByChannel).reduce((total, list) => total + list.length, 0),
    );
    expect(c.bans).toBe(fixture.bans.length);
    expect(c.emojis).toBe(fixture.emojis.length);
    expect(c.stickers).toBe(fixture.stickers.length);
    expect(c.sounds).toBe(fixture.sounds.length);
    expect(c.automod).toBe(fixture.automod.length);
    expect(c.events).toBe(fixture.events.length);
  });

  test("overwrites counts the nested overwrites, not the channels", () => {
    const fixture = makeGuild();
    const nested = fixture.channels.reduce(
      (total, channel) =>
        total + ((channel.permission_overwrites as unknown[] | undefined)?.length ?? 0),
      0,
    );
    expect(counts(fixture).overwrites).toBe(nested);
    expect(counts(fixture).overwrites).toBe(3);
    expect(counts(fixture).overwrites).not.toBe(fixture.channels.length);
  });

  test("an override of any one array shows up in counts", () => {
    expect(counts(makeGuild({ roles: [] }))).toMatchObject({ roles: 0 });
    expect(counts(makeGuild({ channels: [] }))).toMatchObject({ channels: 0, overwrites: 0 });
    expect(counts(makeGuild({ threads: { active: [], archived: [] } }))).toMatchObject({
      threads: 0,
    });
    expect(counts(makeGuild({ members: [] }))).toMatchObject({ members: 0 });
    expect(counts(makeGuild({ messagesByChannel: {} }))).toMatchObject({ messages: 0 });
    expect(counts(makeGuild({ bans: [] }))).toMatchObject({ bans: 0 });
    expect(counts(makeGuild({ emojis: [] }))).toMatchObject({ emojis: 0 });
    expect(counts(makeGuild({ stickers: [] }))).toMatchObject({ stickers: 0 });
    expect(counts(makeGuild({ sounds: [] }))).toMatchObject({ sounds: 0 });
    expect(counts(makeGuild({ automod: [] }))).toMatchObject({ automod: 0 });
    expect(counts(makeGuild({ events: [] }))).toMatchObject({ events: 0 });

    // an override that shrinks rather than empties is reflected too
    const oneMember = makeGuild().members[0]!;
    expect(counts(makeGuild({ members: [oneMember] })).members).toBe(1);
  });
});

// ---- makeGuild is deterministic and independent -----------------------------

describe("makeGuild", () => {
  test("two calls produce deep-equal objects", () => {
    expect(makeGuild()).toEqual(makeGuild());
  });

  test("mutating one call leaves the next untouched", () => {
    const first = makeGuild();
    const second = makeGuild();

    first.roles.push({ id: "9999999999999999999", name: "injected" });
    const general = first.messagesByChannel[CHANNEL_GENERAL]!;
    general[0]!.content = "mutated";

    expect(second.roles).toHaveLength(4);
    expect(second.roles.some((role) => role.name === "injected")).toBe(false);
    expect(second.messagesByChannel[CHANNEL_GENERAL]?.[0]?.content).toBe("the newest message");
  });

  test("every id is a string, none a number, and one is above 2^53", () => {
    const ids: string[] = [];
    const numeric: string[] = [];
    walkIds(makeGuild(), "", (key, value) => {
      if (typeof value === "number") numeric.push(key);
      else if (typeof value === "string") ids.push(value);
    });

    // an id-keyed value that is a JavaScript number is the rule-3 bug this pins
    expect(numeric).toEqual([]);
    expect(ids.length).toBeGreaterThan(0);

    const wide = ids.filter((value) => value.length > 15);
    expect(wide.length).toBeGreaterThan(0);
    expect(Number.isSafeInteger(Number(wide[0]))).toBe(false);
  });
});

// an id key at any depth: id, *_id, *_ids. an array under one (role_ids,
// default_channel_ids) contributes its elements, since those are id lists.
function isIdKey(key: string): boolean {
  return key === "id" || key.endsWith("_id") || key.endsWith("_ids");
}

function walkIds(node: unknown, key: string, onId: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkIds(item, key, onId);
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [childKey, childValue] of Object.entries(node)) {
      walkIds(childValue, childKey, onId);
    }
    return;
  }
  if (isIdKey(key)) onId(key, node);
}

// ---- the stub serves what a capture asks for --------------------------------

describe("restStub requests", () => {
  test("resolves and records every phase-5 route", async () => {
    const stub = restStub(makeGuild());
    const g = FIXTURE_GUILD_ID;
    const routes = [
      `/guilds/${g}`,
      `/guilds/${g}/roles`,
      `/guilds/${g}/emojis`,
      `/guilds/${g}/stickers`,
      `/guilds/${g}/soundboard-sounds`,
      `/guilds/${g}/channels`,
      `/guilds/${g}/threads/active`,
      `/guilds/${g}/onboarding`,
      `/guilds/${g}/welcome-screen`,
      `/guilds/${g}/widget`,
      `/guilds/${g}/vanity-url`,
      `/guilds/${g}/auto-moderation/rules`,
      `/guilds/${g}/scheduled-events`,
      `/guilds/${g}/members`,
      `/guilds/${g}/bans`,
      `/channels/${CHANNEL_GENERAL}/messages`,
      `/channels/${CHANNEL_GENERAL}/threads/archived/public`,
      `/channels/${CHANNEL_GENERAL}/threads/archived/private`,
    ];

    for (const route of routes) {
      const payload = await stub.client.request({ method: "GET", route });
      expect(payload).not.toBeUndefined();
      expect(stub.routes()).toContain(`GET ${route}`);
    }
  });

  test("hands back fresh, deep-equal copies", async () => {
    const stub = restStub(makeGuild());

    const a = await stub.client.request<Record<string, unknown>[]>({
      method: "GET",
      route: `/guilds/${FIXTURE_GUILD_ID}/roles`,
    });
    const b = await stub.client.request<Record<string, unknown>[]>({
      method: "GET",
      route: `/guilds/${FIXTURE_GUILD_ID}/roles`,
    });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a[0]!.name = "mutated";
    expect(b[0]!.name).toBe("@everyone");

    const guild1 = await stub.client.request<Record<string, unknown>>({
      method: "GET",
      route: `/guilds/${FIXTURE_GUILD_ID}`,
    });
    const guild2 = await stub.client.request<Record<string, unknown>>({
      method: "GET",
      route: `/guilds/${FIXTURE_GUILD_ID}`,
    });
    expect(guild1).not.toBe(guild2);
    expect(guild1).toEqual(guild2);
    guild1.name = "mutated";
    expect(guild2.name).toBe("fixture guild");
  });

  test("an unknown route rejects with discord's 404, not undefined", async () => {
    const stub = restStub(makeGuild());
    let caught: unknown;
    try {
      await stub.client.request({
        method: "GET",
        route: `/guilds/${FIXTURE_GUILD_ID}/definitely-not-a-route`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiscordApiError);
    const error = caught as DiscordApiError;
    expect(error.status).toBe(404);
    expect(error.code).toBe(10003);
    expect(error.message).toBe("Unknown Route"); // discord's own words, verbatim
  });

  test("fail() breaks exactly one route", async () => {
    const stub = restStub(makeGuild());
    const rolesRoute = `GET /guilds/${FIXTURE_GUILD_ID}/roles`;
    const denied = new DiscordApiError({
      status: 403,
      route: rolesRoute,
      method: "GET",
      body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
    });

    stub.fail(rolesRoute, denied);

    await expect(
      stub.client.request({ method: "GET", route: `/guilds/${FIXTURE_GUILD_ID}/roles` }),
    ).rejects.toBe(denied);

    // every other route still resolves
    const channels = await stub.client.request({
      method: "GET",
      route: `/guilds/${FIXTURE_GUILD_ID}/channels`,
    });
    expect(channels).not.toBeUndefined();
    const members = await stub.client.request({
      method: "GET",
      route: `/guilds/${FIXTURE_GUILD_ID}/members`,
    });
    expect(members).not.toBeUndefined();
  });
});

// ---- pagination -------------------------------------------------------------
//
// members and bans page on `after`; messages walk `before` (newest first).
// NOTE: the fixture's page() helper filters on `row.id`, but member and ban rows
// carry the id at `row.user.id`, so the `after` cursor never advances for them.
// the members/bans cases below assert the documented contract and fail on the
// current fixture; the defect is reported in the task summary, not fixed here.

describe("restStub pagination", () => {
  test("members page on after: the first two, then the last", async () => {
    const stub = restStub(makeGuild());
    const route = (after?: string) =>
      `/guilds/${FIXTURE_GUILD_ID}/members?limit=2${after === undefined ? "" : `&after=${after}`}`;

    const page1 = await stub.client.request<{ user: { id: string } }[]>({
      method: "GET",
      route: route(),
    });
    expect(page1.map((member) => member.user.id)).toEqual([USER_BOT, USER_NICK]);

    const cursor = page1[page1.length - 1]!.user.id; // the last id of the first page
    const page2 = await stub.client.request<{ user: { id: string } }[]>({
      method: "GET",
      route: route(cursor),
    });

    // the second request carries after=<the last id of the first page>
    expect(stub.calls().at(-1)!.route).toContain(`after=${cursor}`);
    // and returns the one member left
    expect(page2.map((member) => member.user.id)).toEqual([USER_PENDING]);
  });

  test("bans page on after: the one ban, then none", async () => {
    const stub = restStub(makeGuild());
    const route = (after?: string) =>
      `/guilds/${FIXTURE_GUILD_ID}/bans?limit=1${after === undefined ? "" : `&after=${after}`}`;

    const page1 = await stub.client.request<{ user: { id: string } }[]>({
      method: "GET",
      route: route(),
    });
    expect(page1.map((ban) => ban.user.id)).toEqual([USER_NICK]);

    const cursor = page1[page1.length - 1]!.user.id;
    const page2 = await stub.client.request<{ user: { id: string } }[]>({
      method: "GET",
      route: route(cursor),
    });
    expect(stub.calls().at(-1)!.route).toContain(`after=${cursor}`);
    expect(page2).toEqual([]);
  });

  test("messages honour limit and walk before, ending on the oldest id", async () => {
    const stub = restStub(makeGuild());
    const ordered = makeGuild().messagesByChannel[CHANNEL_GENERAL]!.map(
      (message) => message.id as string,
    );
    const route = (before?: string) =>
      `/channels/${CHANNEL_GENERAL}/messages?limit=2${before === undefined ? "" : `&before=${before}`}`;

    const page1 = await stub.client.request<{ id: string }[]>({ method: "GET", route: route() });
    expect(page1.map((message) => message.id)).toEqual(ordered.slice(0, 2)); // newest first

    const page2 = await stub.client.request<{ id: string }[]>({
      method: "GET",
      route: route(page1[page1.length - 1]!.id),
    });
    expect(page2.map((message) => message.id)).toEqual(ordered.slice(2, 4));

    const page3 = await stub.client.request<{ id: string }[]>({
      method: "GET",
      route: route(page2[page2.length - 1]!.id),
    });
    expect(page3.map((message) => message.id)).toEqual(ordered.slice(4)); // the short last page
    expect(page3[page3.length - 1]!.id).toBe(ordered.at(-1)!); // the oldest id
  });
});

// ---- makeContext ------------------------------------------------------------

describe("makeContext", () => {
  test("starts empty, at the documented defaults", async () => {
    const ctx = makeContext({ db, guild: makeGuild() });

    expect(ctx.skips.size).toBe(0);
    expect(ctx.skips.all()).toEqual([]);
    expect(ctx.guildId).toBe(FIXTURE_GUILD_ID);
    expect(typeof ctx.guildId).toBe("string");
    expect(ctx.backupId).toBe(FIXTURE_BACKUP_ID);
    expect(ctx.settings).toEqual(makeSettings());
    expect(ctx.settings.backup_max_messages_per_channel).toBe(1000);
    expect(ctx.settings.backup_max_messages_total).toBe(10_000);
    expect(ctx.log.level).toBe("error");
    expect(typeof ctx.log.error).toBe("function");
    await expect(ctx.checkpoint("roles", { done: 0, total: null })).resolves.toBeUndefined();
  });

  test("applies a settings override", () => {
    const ctx = makeContext({
      db,
      guild: makeGuild(),
      settings: makeSettings({ notify_on_join: true }),
    });
    expect(ctx.settings.notify_on_join).toBe(true);
    expect(ctx.settings.ephemeral_default).toBe(true); // still the shipped default
  });
});

describe("stubAssets", () => {
  test("saves nothing for a null url, an asset for a real one", async () => {
    const assets = stubAssets();
    expect(await assets.save("guild", "icon", null)).toBeNull();

    const url = "https://cdn.discordapp.com/icons/1/hash.png";
    expect(await assets.save("guild", "icon", url)).toEqual({
      url,
      path: "assets/guild/icon",
      bytes: 0,
    });
    expect(typeof assets.pathFor("role", "mods", url)).toBe("string");
  });
});

// ---- the database helper ----------------------------------------------------

describe("openFixtureDb / insertFixtureBackup", () => {
  test("migration 2 is applied: self_check_json round-trips", async () => {
    const backupId = "0190a000-0000-7000-8000-0000000000a1";
    const selfCheck = {
      ok: false,
      failures: ["count mismatch"],
      skipped: [{ category: "members", what: "@someone", why: "not in the guild" }],
    };

    await insertFixtureBackup(db, { backup_id: backupId, self_check_json: selfCheck });

    const stored = await getBackup(db, backupId);
    expect(stored?.self_check_json).toEqual(selfCheck);
  });

  test("insertFixtureBackup returns the row it inserted, with makeBackup defaults", async () => {
    const backupId = "0190a000-0000-7000-8000-0000000000b2";
    const row = await insertFixtureBackup(db, { backup_id: backupId, label: "nightly" });

    expect(row).toEqual(makeBackup({ backup_id: backupId, label: "nightly" }));
    expect(row.guild_id).toBe(FIXTURE_GUILD_ID);
    expect(row.schema_version).toBe(BACKUP_SCHEMA_VERSION);

    // and it really landed in the database
    expect(await getBackup(db, backupId)).toEqual(row);
  });

  test("two calls give two independent databases", async () => {
    const first = await openFixtureDb();
    const second = await openFixtureDb();
    try {
      const row = await insertFixtureBackup(first);
      expect(await getBackup(first, row.backup_id)).not.toBeNull();
      expect(await getBackup(second, row.backup_id)).toBeNull();
    } finally {
      await first.close();
      await second.close();
    }
  });
});
