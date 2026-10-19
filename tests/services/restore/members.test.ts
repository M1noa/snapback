// tests/services/restore/members.test.ts
//
// restoreMembers (D4PLAN 12.5). a real temp-file duckdb holds the backup's
// members and roles, and a recording client holds the requests, so the
// assertions are about the requests, the maps and the notes.
//
// the fixture guild supplies the source ids. the target is a different guild
// with its own role ids, because a restore that only works in the guild it
// came from is not a restore.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  deleteBackupMembersByBackup,
  insertBackupMembers,
} from "../../../src/db/queries/backup-members.ts";
import {
  deleteBackupRolesByBackup,
  insertBackupRoles,
} from "../../../src/db/queries/backup-roles.ts";
import { insertBackup } from "../../../src/db/queries/backups.ts";
import type { BackupMemberRow, BackupRoleRow, Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { restoreMembers } from "../../../src/services/restore/members.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  ROLE_MEMBERS,
  ROLE_MODS,
  USER_BOT,
  USER_NICK,
  USER_PENDING,
} from "../../fixtures/guild.ts";

const T0 = "2024-01-01T00:00:00.000Z";
/** the target guild is not the guild the backup came from. */
const TARGET_GUILD_ID = "20000000000000000001";
/** the target's own role ids. */
const TARGET_ROLE_MODS = "20000000000000000010";
const TARGET_ROLE_MEMBERS = "20000000000000000011";
/** a role the target has and the backup never captured. */
const TARGET_ROLE_EXTRA = "20000000000000000012";
/** a role the backup has and the target does not. */
const SOURCE_ROLE_WIZARD = "10000000000000000099";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
  await insertBackup(db, {
    backup_id: FIXTURE_BACKUP_ID,
    guild_id: FIXTURE_GUILD_ID,
    label: "fixture",
    kind: "manual",
    guild_name: "fixture guild",
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: null,
    member_count: 0,
    message_count: 0,
    channel_count: 0,
    role_count: 0,
    size_bytes: 0,
    schema_version: 1,
    guild_settings_json: null,
    onboarding_json: null,
    welcome_screen_json: null,
    widget_json: null,
    afk_json: null,
    self_check_json: null,
    created_at: T0,
    created_by: FIXTURE_GUILD_ID,
  });
});

afterAll(async () => {
  await closeFixtureDb(db);
});

beforeEach(async () => {
  await deleteBackupMembersByBackup(db, FIXTURE_BACKUP_ID);
  await deleteBackupRolesByBackup(db, FIXTURE_BACKUP_ID);
});

interface Recorded {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
}

interface Stub {
  readonly client: DiscordClient;
  readonly calls: Recorded[];
}

/** a client that records what it was asked and answers from a responder. */
function recordingClient(respond: (method: string, route: string) => unknown): Stub {
  const calls: Recorded[] = [];
  const client = {
    async request<T>(options: RequestOptions): Promise<T> {
      calls.push({ method: options.method, route: options.route, body: options.body });
      return respond(options.method, options.route) as T;
    },
  } as unknown as DiscordClient;
  return { client, calls };
}

/** what discord says about a route that does not exist. */
function unknownRoute(method: string, route: string): DiscordApiError {
  return new DiscordApiError({
    status: 404,
    route,
    method,
    body: JSON.stringify({ code: 10003, message: "Unknown Route" }),
  });
}

/** a member as the target guild holds them. */
function targetMember(userId: string, roles: string[] = []): Record<string, unknown> {
  return { user: { id: userId }, nick: null, roles };
}

function memberRow(overrides: Partial<BackupMemberRow> = {}): BackupMemberRow {
  return {
    backup_id: FIXTURE_BACKUP_ID,
    user_id: USER_NICK,
    username: "nickname",
    global_name: "Nick Name",
    discriminator: "0",
    nickname: "nick in this guild",
    avatar_url: null,
    joined_at: T0,
    is_bot: false,
    role_ids_json: [ROLE_MODS, ROLE_MEMBERS],
    pending: false,
    timed_out_until: null,
    premium_since: null,
    flags: 0,
    source_role_names_json: ["mods", "members"],
    ...overrides,
  };
}

function roleRow(sourceRoleId: string, name: string): BackupRoleRow {
  return {
    backup_id: FIXTURE_BACKUP_ID,
    source_role_id: sourceRoleId,
    name,
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

interface Harness {
  readonly ctx: RestoreContext;
  readonly notes: { what: string; why: string }[];
}

function harness(options: {
  client: DiscordClient;
  memberMode?: 1 | 2 | 3;
  roles?: Record<string, string>;
  now?: () => string;
}): Harness {
  const notes: { what: string; why: string }[] = [];
  const maps = createRestoreMaps();
  for (const [source, target] of Object.entries(options.roles ?? {})) {
    maps.roles.set(source, target);
  }

  const ctx: RestoreContext = {
    db,
    client: options.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: FIXTURE_BACKUP_ID,
    targetGuildId: TARGET_GUILD_ID,
    options: { ...DEFAULT_RESTORE_OPTIONS, memberMode: options.memberMode ?? 1 },
    maps,
    sourceGuildId: FIXTURE_GUILD_ID,
    backupDir: "/tmp/snapback-restore-members",
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: (what, why) => {
      notes.push({ what, why });
    },
    now: options.now ?? (() => T0),
  };
  return { ctx, notes };
}

/** the role map a restore of the fixture's roles would hold. */
const ROLE_MAP = {
  [ROLE_MODS]: TARGET_ROLE_MODS,
  [ROLE_MEMBERS]: TARGET_ROLE_MEMBERS,
};

describe("restoreMembers", () => {
  test("mode 1 sends only the roles", async () => {
    await insertBackupMembers(db, [memberRow()]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, roles: ROLE_MAP });

    const result = await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    expect(patch?.route).toBe(`/guilds/${TARGET_GUILD_ID}/members/${USER_NICK}`);
    const body = patch?.body as { roles: string[]; nick?: string };
    expect(Object.keys(body)).toEqual(["roles"]);
    expect(body.roles).toEqual([TARGET_ROLE_MODS, TARGET_ROLE_MEMBERS]);
    expect(result.count).toBe(1);
    expect(result.failed).toBe(false);
    expect(notes).toEqual([]);
    // the map says which backup user is which target user, and the ids are global
    expect(ctx.maps.members.get(USER_NICK)).toBe(USER_NICK);
  });

  test("mode 2 sends the nickname as well", async () => {
    await insertBackupMembers(db, [memberRow()]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client, memberMode: 2, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as { roles: string[]; nick: string | null };
    expect(body.nick).toBe("nick in this guild");
    expect(body.roles).toEqual([TARGET_ROLE_MODS, TARGET_ROLE_MEMBERS]);
  });

  test("a nickname over 32 characters is truncated with a note", async () => {
    const long = "n".repeat(40);
    await insertBackupMembers(db, [memberRow({ nickname: long })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, memberMode: 2, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as { nick: string };
    expect(body.nick).toBe("n".repeat(32));
    expect(body.nick.length).toBe(32);
    const notesAbout = notes.filter((note) => note.what.includes("nickname"));
    expect(notesAbout.length).toBe(1);
    expect(notesAbout[0]?.why).toContain("truncated");
  });

  test("a backup role the target does not have is dropped and counted", async () => {
    await insertBackupRoles(db, [
      roleRow(ROLE_MODS, "mods"),
      roleRow(SOURCE_ROLE_WIZARD, "wizard"),
    ]);
    await insertBackupMembers(db, [
      memberRow({
        role_ids_json: [ROLE_MODS, SOURCE_ROLE_WIZARD],
        source_role_names_json: ["mods", "wizard"],
      }),
    ]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK)];
      }
      // the target guild has no role called wizard
      if (method === "GET" && route === `/guilds/${TARGET_GUILD_ID}/roles`) {
        return [{ id: TARGET_ROLE_MODS, name: "mods" }];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, roles: ROLE_MAP });

    const result = await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as { roles: string[] };
    expect(body.roles).toEqual([TARGET_ROLE_MODS]);
    const drops = notes.filter((note) => note.what.includes("wizard"));
    expect(drops.length).toBe(1);
    expect(drops[0]?.why).toContain("no role with that name");
    // the member was still patched, the role was only dropped
    expect(result.count).toBe(1);
  });

  test("a member who is not in the target is counted as absent and never added", async () => {
    await insertBackupMembers(db, [memberRow({ user_id: USER_BOT, role_ids_json: [] })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        // the target holds another member, not the one the backup has
        return [targetMember(USER_PENDING)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, roles: ROLE_MAP });

    const result = await restoreMembers(ctx);

    // no add attempt, no patch, no request for that user at all
    expect(stub.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    expect(stub.calls.filter((call) => call.route.includes(USER_BOT))).toHaveLength(0);
    expect(result.count).toBe(0);
    expect(result.failed).toBe(false);
    const absent = notes.filter((note) => note.what.includes(USER_BOT));
    expect(absent.length).toBe(1);
    expect(absent[0]?.why).toContain("not in the target guild");
  });

  test("a timeout longer than 28 days is clamped with a note", async () => {
    // 40 days after the phase's now.
    await insertBackupMembers(db, [memberRow({ timed_out_until: "2024-02-10T00:00:00.000Z" })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as { communication_disabled_until?: string };
    // 28 days after 2024-01-01
    expect(body.communication_disabled_until).toBe("2024-01-29T00:00:00.000Z");
    const clamped = notes.filter((note) => note.what.includes("timeout"));
    expect(clamped.length).toBe(1);
    expect(clamped[0]?.why).toContain("clamped");
  });

  test("a timeout in the past is dropped and not sent", async () => {
    await insertBackupMembers(db, [memberRow({ timed_out_until: "2023-12-01T00:00:00.000Z" })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as Record<string, unknown>;
    expect("communication_disabled_until" in body).toBe(false);
    const dropped = notes.filter((note) => note.what.includes("timeout"));
    expect(dropped.length).toBe(1);
    expect(dropped[0]?.why).toContain("in the past");
  });

  test("mode 1 leaves the roles the backup does not know about alone", async () => {
    await insertBackupMembers(db, [memberRow()]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK, [TARGET_ROLE_EXTRA])];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as { roles: string[] };
    expect(body.roles).toEqual([TARGET_ROLE_MODS, TARGET_ROLE_MEMBERS, TARGET_ROLE_EXTRA]);
  });

  test("mode 3 removes the roles the backup does not know about and says so", async () => {
    await insertBackupMembers(db, [memberRow()]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK, [TARGET_ROLE_EXTRA])];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, memberMode: 3, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const patch = stub.calls.find((call) => call.method === "PATCH");
    const body = patch?.body as { roles: string[] };
    expect(body.roles).toEqual([TARGET_ROLE_MODS, TARGET_ROLE_MEMBERS]);
    const removals = notes.filter((note) => note.why.includes("removed"));
    expect(removals.length).toBe(1);
    expect(removals[0]?.why).toContain(TARGET_ROLE_EXTRA);
  });

  test("the member list is read once for the whole phase", async () => {
    await insertBackupMembers(db, [memberRow(), memberRow({ user_id: USER_PENDING })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK), targetMember(USER_PENDING)];
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const listCalls = stub.calls.filter(
      (call) => call.method === "GET" && call.route.includes("/members"),
    );
    expect(listCalls.length).toBe(1);
    expect(listCalls[0]?.route).toBe(`/guilds/${TARGET_GUILD_ID}/members?limit=1000`);
    // one patch per member in the target, and no second walk of the list
    expect(stub.calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
  });

  test("the member list is paginated on after, and not read once per member", async () => {
    await insertBackupMembers(db, [memberRow(), memberRow({ user_id: USER_PENDING })]);
    const first = Array.from({ length: 1000 }, (_unused, index) =>
      targetMember(`3000000000000${String(index).padStart(4, "0")}`),
    );
    const second = [targetMember(USER_NICK), targetMember(USER_PENDING)];
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return route.includes("after=") ? second : first;
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client, roles: ROLE_MAP });

    await restoreMembers(ctx);

    const listCalls = stub.calls.filter(
      (call) => call.method === "GET" && call.route.includes("/members"),
    );
    expect(listCalls.length).toBe(2);
    expect(listCalls[0]?.route).toBe(`/guilds/${TARGET_GUILD_ID}/members?limit=1000`);
    expect(listCalls[1]?.route).toBe(
      `/guilds/${TARGET_GUILD_ID}/members?limit=1000&after=30000000000000999`,
    );
    // two members, two patches, and still only the one walk of the list
    expect(stub.calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
  });

  test("a member discord refuses is a note and the phase carries on", async () => {
    await insertBackupMembers(db, [memberRow(), memberRow({ user_id: USER_PENDING })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/members`)) {
        return [targetMember(USER_NICK), targetMember(USER_PENDING)];
      }
      if (method === "PATCH" && route.endsWith(USER_NICK)) {
        throw new DiscordApiError({
          status: 403,
          route,
          method,
          body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
        });
      }
      if (method === "PATCH") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client, roles: ROLE_MAP });

    const result = await restoreMembers(ctx);

    // the other member was still patched
    expect(result.count).toBe(1);
    expect(result.failed).toBe(false);
    const refused = notes.filter((note) => note.what.includes(USER_NICK));
    expect(refused.length).toBe(1);
    expect(refused[0]?.why).toContain("50013");
    expect(refused[0]?.why).toContain("Missing Permissions");
  });
});
