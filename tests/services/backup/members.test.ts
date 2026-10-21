// tests/services/backup/members.test.ts
//
// captureMembers and captureBans (D4PLAN 11.4, 11 steps 13-14). real temp-file
// duckdb, real query modules, the fixture guild as the payload source. an id above
// 2^53 has to cross the boundary as a string, and a 403 has to be one skip in
// discord's own words rather than a failed backup.
//
// the fixture's member rows carry no top-level `id`, and the restStub pages on
// `row.id` (tests/fixtures/guild.ts page()). so a synthetic member built for the
// pagination tests sets `id` equal to its user id; that is what lets the `after`
// cursor advance instead of re-serving the whole list.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_BACKUP_INCLUDE } from "../../../src/config/defaults.ts";
import {
  countBackupBansByBackup,
  deleteBackupBansByBackup,
  listBackupBansByBackup,
} from "../../../src/db/queries/backup-bans.ts";
import {
  countBackupMembersByBackup,
  deleteBackupMembersByBackup,
  listBackupMembersByBackup,
} from "../../../src/db/queries/backup-members.ts";
import {
  deleteBackupRolesByBackup,
  insertBackupRoles,
} from "../../../src/db/queries/backup-roles.ts";
import type { BackupRoleRow, Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { captureBans, captureMembers } from "../../../src/services/backup/members.ts";
import {
  type AssetStore,
  type BackupContext,
  createSkipList,
} from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  counts,
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  type FixtureGuild,
  makeContext,
  makeGuild,
  makeSettings,
  type RestStub,
  ROLE_BOT,
  ROLE_MEMBERS,
  ROLE_MODS,
  restStub,
  stubAssets,
  USER_BOT,
  USER_NICK,
  USER_PENDING,
} from "../../fixtures/guild.ts";

const T0 = "2024-01-01T00:00:00.000Z";
const T1 = "2024-02-01T00:00:00.000Z";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// every test starts from an empty set of captured rows for the fixture backup.
beforeEach(async () => {
  await deleteBackupMembersByBackup(db, FIXTURE_BACKUP_ID);
  await deleteBackupBansByBackup(db, FIXTURE_BACKUP_ID);
  await deleteBackupRolesByBackup(db, FIXTURE_BACKUP_ID);
});

// a context whose stub the test can also drive and read, so a route can be failed
// or a route list asserted. makeContext hides its stub, so this mirrors it.
function contextWithStub(options: {
  guild: FixtureGuild;
  settings?: ReturnType<typeof makeSettings>;
}): { ctx: BackupContext; stub: RestStub } {
  const stub = restStub(options.guild);
  return {
    stub,
    ctx: {
      db,
      client: stub.client,
      log: createLogger({ level: "error", dir: null }),
      backupId: FIXTURE_BACKUP_ID,
      guildId: String(options.guild.guild.id),
      settings: options.settings ?? makeSettings(),
      assets: stubAssets(),
      skips: createSkipList(),
      checkpoint: async () => {},
      now: () => T0,
    },
  };
}

// the role rows the members step resolves names against, built from the fixture's
// own role list so a name here is the name the fixture carries.
function roleRows(guild: FixtureGuild): BackupRoleRow[] {
  return guild.roles.map((role) => ({
    backup_id: FIXTURE_BACKUP_ID,
    source_role_id: String(role.id),
    name: String(role.name),
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
  }));
}

// 20-digit, constant-width ids: above 2^53 and lexicographically ordered, so the
// stub's `String(row.id) > after` cursor advances by exactly one page.
function memberId(n: number): string {
  return `10000000000000${String(n).padStart(6, "0")}`;
}

function pagingMember(n: number): Record<string, unknown> {
  const id = memberId(n);
  return {
    id,
    user: {
      id,
      username: `user${n}`,
      global_name: null,
      discriminator: "0",
      avatar: null,
      bot: false,
    },
    nick: null,
    joined_at: T0,
    roles: [],
    pending: false,
    premium_since: null,
    flags: 0,
  };
}

describe("captureMembers", () => {
  test("stores the fixture's three members and reports the count", async () => {
    const guild = makeGuild();
    const ctx = makeContext({ db, guild });

    const result = await captureMembers(ctx);

    expect(result.written).toBe(counts(guild).members);
    expect(await countBackupMembersByBackup(db, FIXTURE_BACKUP_ID)).toBe(counts(guild).members);

    const rows = await listBackupMembersByBackup(db, FIXTURE_BACKUP_ID);
    const ids = rows.map((row) => row.user_id);
    expect(ids.sort()).toEqual([USER_BOT, USER_NICK, USER_PENDING].sort());
    // an id above 2^53 survives as a string, never a number
    expect(String(Number(USER_BOT))).not.toBe(USER_BOT);
    for (const id of ids) expect(typeof id).toBe("string");
  });

  test("role ids stay strings and names resolve from the captured roles", async () => {
    const guild = makeGuild();
    await insertBackupRoles(db, roleRows(guild));
    const ctx = makeContext({ db, guild });

    await captureMembers(ctx);

    const rows = await listBackupMembersByBackup(db, FIXTURE_BACKUP_ID);

    const nick = rows.find((row) => row.user_id === USER_NICK);
    expect(nick?.role_ids_json).toEqual([ROLE_MODS, ROLE_MEMBERS]);
    expect(nick?.role_ids_json.every((id) => typeof id === "string")).toBe(true);
    expect(nick?.source_role_names_json).toEqual(["mods", "members"]);

    const bot = rows.find((row) => row.user_id === USER_BOT);
    expect(bot?.role_ids_json).toEqual([ROLE_BOT]);
    expect(bot?.source_role_names_json).toEqual(["snapbot"]);

    // every captured role id resolved, so nothing was left unresolved
    expect(ctx.skips.all()).toEqual([]);
  });

  test("an avatar is null when absent, .gif when animated, .png otherwise", async () => {
    const guild = makeGuild();
    const saved: string[] = [];
    const assets: AssetStore = {
      dir: "/tmp/snapback-members-assets",
      save: async (kind, name, url) => {
        saved.push(name);
        return url === null ? null : { url, path: `assets/${kind}/${name}`, bytes: 0 };
      },
      pathFor: (kind, name) => `assets/${kind}/${name}`,
    };
    const ctx = makeContext({ db, guild, assets });

    await captureMembers(ctx);

    const rows = await listBackupMembersByBackup(db, FIXTURE_BACKUP_ID);
    const pending = rows.find((row) => row.user_id === USER_PENDING);
    expect(pending?.avatar_url).toBeNull();

    const nick = rows.find((row) => row.user_id === USER_NICK);
    expect(nick?.avatar_url).toBe(
      `https://cdn.discordapp.com/avatars/${USER_NICK}/a_animatedhash.gif`,
    );

    const bot = rows.find((row) => row.user_id === USER_BOT);
    expect(bot?.avatar_url).toBe(`https://cdn.discordapp.com/avatars/${USER_BOT}/bothash.png`);

    // the member with no avatar downloads nothing
    expect(saved).not.toContain(USER_PENDING);
  });

  test("pending, timed_out_until and premium_since survive the round trip", async () => {
    const ctx = makeContext({ db, guild: makeGuild() });

    await captureMembers(ctx);

    const rows = await listBackupMembersByBackup(db, FIXTURE_BACKUP_ID);

    const nick = rows.find((row) => row.user_id === USER_NICK);
    expect(nick?.premium_since).toBe(T0);
    expect(nick?.timed_out_until).toBe(T1);
    expect(nick?.pending).toBe(false);

    const pending = rows.find((row) => row.user_id === USER_PENDING);
    expect(pending?.pending).toBe(true);
    expect(pending?.premium_since).toBeNull();
    expect(pending?.timed_out_until).toBeNull();

    const bot = rows.find((row) => row.user_id === USER_BOT);
    expect(bot?.is_bot).toBe(true);
  });

  test("a role id not in the db adds exactly one skip, not one per member", async () => {
    const unknown = "1000000000000000999";
    const members = [1, 2].map((n) => ({ ...pagingMember(n), roles: [unknown] }));
    const guild = makeGuild({ members });
    const ctx = makeContext({ db, guild });

    await captureMembers(ctx);

    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("members");
    expect(skips[0]?.what).toBe(`role ${unknown}`);
    expect(skips[0]?.why).toContain("not captured");

    const rows = await listBackupMembersByBackup(db, FIXTURE_BACKUP_ID);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.role_ids_json).toEqual([unknown]);
    expect(rows[0]?.source_role_names_json).toEqual([]);
  });

  test("a 403 on /members is one skip in discord's words and writes nothing", async () => {
    const { ctx, stub } = contextWithStub({ guild: makeGuild() });
    stub.fail(
      `GET /guilds/${FIXTURE_GUILD_ID}/members`,
      new DiscordApiError({
        status: 403,
        route: `/guilds/${FIXTURE_GUILD_ID}/members`,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );

    const result = await captureMembers(ctx);

    expect(result).toEqual({ written: 0 });
    expect(ctx.skips.all()).toEqual([
      { category: "members", what: "the member list", why: "50013 Missing Permissions" },
    ]);
    expect(await countBackupMembersByBackup(db, FIXTURE_BACKUP_ID)).toBe(0);
  });
});

describe("members pagination", () => {
  test("the capture stops as soon as a page comes back short", async () => {
    // three members is a short page against the step's limit of 1000, so the walk
    // ends after one request and never sets an `after` cursor.
    const { ctx, stub } = contextWithStub({ guild: makeGuild() });

    const result = await captureMembers(ctx);

    expect(result.written).toBe(3);
    expect(stub.routes()).toEqual([`GET /guilds/${FIXTURE_GUILD_ID}/members`]);
    expect(stub.calls().map((call) => call.route)).toEqual([
      `/guilds/${FIXTURE_GUILD_ID}/members?limit=1000`,
    ]);
  });

  test("the members endpoint pages on limit and after, stopping on a short page", async () => {
    const guild = makeGuild({ members: [1, 2, 3].map(pagingMember) });
    const stub = restStub(guild);
    const route = (after: string | null) =>
      `/guilds/${FIXTURE_GUILD_ID}/members?limit=2${after === null ? "" : `&after=${after}`}`;

    const first = await stub.client.request<{ user: { id: string } }[]>({
      method: "GET",
      route: route(null),
    });
    expect(first).toHaveLength(2);

    const cursor = first[1]?.user.id ?? "";
    const second = await stub.client.request<unknown[]>({ method: "GET", route: route(cursor) });
    // the cursor returned the one member past it, a short page
    expect(second).toHaveLength(1);

    expect(stub.routes()).toEqual([
      `GET /guilds/${FIXTURE_GUILD_ID}/members`,
      `GET /guilds/${FIXTURE_GUILD_ID}/members`,
    ]);
    expect(stub.calls().map((call) => call.route)).toEqual([route(null), route(cursor)]);
  });

  test("a list larger than 1000 flushes in pages and lands every row", async () => {
    const guild = makeGuild({
      members: Array.from({ length: 1001 }, (_, i) => pagingMember(i + 1)),
    });
    const { ctx, stub } = contextWithStub({ guild });

    const result = await captureMembers(ctx);

    expect(result.written).toBe(1001);
    expect(await countBackupMembersByBackup(db, FIXTURE_BACKUP_ID)).toBe(1001);
    // two requests: a full 1000-row page, then the one-row remainder
    expect(stub.routes()).toHaveLength(2);
    expect(stub.calls().map((call) => call.route)).toEqual([
      `/guilds/${FIXTURE_GUILD_ID}/members?limit=1000`,
      `/guilds/${FIXTURE_GUILD_ID}/members?limit=1000&after=${memberId(1000)}`,
    ]);
  });
});

describe("captureBans", () => {
  test("the members gate being off still captures bans, reason and all", async () => {
    const settings = makeSettings({
      backup_include: { ...DEFAULT_BACKUP_INCLUDE, members: false },
    });
    const ctx = makeContext({ db, guild: makeGuild(), settings });

    expect(await captureMembers(ctx)).toEqual({ written: 0 });
    expect(await countBackupMembersByBackup(db, FIXTURE_BACKUP_ID)).toBe(0);

    const result = await captureBans(ctx);
    expect(result.written).toBe(1);

    const bans = await listBackupBansByBackup(db, FIXTURE_BACKUP_ID);
    expect(bans).toHaveLength(1);
    expect(bans[0]?.user_id).toBe(USER_NICK);
    expect(bans[0]?.username).toBe("nickname");
    expect(bans[0]?.reason).toBe("fixture ban");
  });

  test("the bans gate being off still captures members", async () => {
    const settings = makeSettings({ backup_include: { ...DEFAULT_BACKUP_INCLUDE, bans: false } });
    const ctx = makeContext({ db, guild: makeGuild(), settings });

    expect(await captureBans(ctx)).toEqual({ written: 0 });
    expect(await countBackupBansByBackup(db, FIXTURE_BACKUP_ID)).toBe(0);

    expect((await captureMembers(ctx)).written).toBe(3);
  });

  test("a ban with no reason stores null", async () => {
    const guild = makeGuild({
      bans: [
        {
          user: {
            id: USER_NICK,
            username: "nickname",
            global_name: null,
            discriminator: "0",
            avatar: null,
            bot: false,
          },
        },
      ],
    });
    const ctx = makeContext({ db, guild });

    await captureBans(ctx);

    const bans = await listBackupBansByBackup(db, FIXTURE_BACKUP_ID);
    expect(bans).toHaveLength(1);
    expect(bans[0]?.reason).toBeNull();
  });
});
