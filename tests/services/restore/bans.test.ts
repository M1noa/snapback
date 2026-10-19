// tests/services/restore/bans.test.ts
//
// restoreBans (D4PLAN 12.2 step 12). a real temp-file duckdb holds the
// backup's bans and a recording client holds the requests.
//
// a refusal is a note in discord's own words, and the phase carries on. a user
// who is already banned is named, not treated as a failure.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { deleteBackupBansByBackup, insertBackupBans } from "../../../src/db/queries/backup-bans.ts";
import { insertBackup } from "../../../src/db/queries/backups.ts";
import type { BackupBanRow, Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { restoreBans } from "../../../src/services/restore/bans.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  FIXTURE_BACKUP_ID,
  FIXTURE_GUILD_ID,
  USER_NICK,
  USER_PENDING,
} from "../../fixtures/guild.ts";

const T0 = "2024-01-01T00:00:00.000Z";
/** the target guild is not the guild the backup came from. */
const TARGET_GUILD_ID = "20000000000000000001";

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
  await deleteBackupBansByBackup(db, FIXTURE_BACKUP_ID);
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

function banRow(overrides: Partial<BackupBanRow> = {}): BackupBanRow {
  return {
    backup_id: FIXTURE_BACKUP_ID,
    user_id: USER_NICK,
    username: "nickname",
    global_name: "Nick Name",
    reason: "fixture ban",
    ...overrides,
  };
}

interface Harness {
  readonly ctx: RestoreContext;
  readonly notes: { what: string; why: string }[];
}

function harness(options: { client: DiscordClient; bans?: boolean }): Harness {
  const notes: { what: string; why: string }[] = [];
  const ctx: RestoreContext = {
    db,
    client: options.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: FIXTURE_BACKUP_ID,
    targetGuildId: TARGET_GUILD_ID,
    options: { ...DEFAULT_RESTORE_OPTIONS, bans: options.bans ?? true },
    maps: createRestoreMaps(),
    sourceGuildId: FIXTURE_GUILD_ID,
    backupDir: "/tmp/snapback-restore-bans",
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: (what, why) => {
      notes.push({ what, why });
    },
    now: () => T0,
  };
  return { ctx, notes };
}

describe("restoreBans", () => {
  test("each ban is a put with the reason", async () => {
    await insertBackupBans(db, [
      banRow(),
      banRow({ user_id: USER_PENDING, username: "pending", reason: "spam" }),
    ]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/bans`)) return [];
      if (method === "PUT") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client });

    const result = await restoreBans(ctx);

    const puts = stub.calls.filter((call) => call.method === "PUT");
    expect(puts.length).toBe(2);
    expect(puts[0]?.route).toBe(`/guilds/${TARGET_GUILD_ID}/bans/${USER_NICK}`);
    expect(puts[1]?.route).toBe(`/guilds/${TARGET_GUILD_ID}/bans/${USER_PENDING}`);
    const body = puts[0]?.body as { delete_message_seconds: number; reason: string };
    expect(body.delete_message_seconds).toBe(0);
    expect(body.reason).toBe("fixture ban");
    expect((puts[1]?.body as { reason: string } | undefined)?.reason).toBe("spam");
    expect(result.count).toBe(2);
    expect(result.failed).toBe(false);
    expect(notes).toEqual([]);
  });

  test("a ban with no reason sends no reason", async () => {
    await insertBackupBans(db, [banRow({ reason: null })]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/bans`)) return [];
      if (method === "PUT") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client });

    await restoreBans(ctx);

    const put = stub.calls.find((call) => call.method === "PUT");
    const body = put?.body as Record<string, unknown>;
    expect(body.delete_message_seconds).toBe(0);
    expect("reason" in body).toBe(false);
  });

  test("a refusal is a note carrying discord's own message", async () => {
    await insertBackupBans(db, [
      banRow(),
      banRow({ user_id: USER_PENDING, username: "pending", reason: "spam" }),
    ]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/bans`)) return [];
      if (method === "PUT" && route.endsWith(USER_NICK)) {
        throw new DiscordApiError({
          status: 403,
          route,
          method,
          body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
        });
      }
      if (method === "PUT") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client });

    const result = await restoreBans(ctx);

    // the second ban still went through
    expect(result.count).toBe(1);
    expect(result.failed).toBe(false);
    const refused = notes.filter((note) => note.what.includes(USER_NICK));
    expect(refused.length).toBe(1);
    expect(refused[0]?.why).toContain("50013");
    expect(refused[0]?.why).toContain("Missing Permissions");
  });

  test("a user who is already banned is a note and not a failure", async () => {
    await insertBackupBans(db, [banRow()]);
    const stub = recordingClient((method, route) => {
      // the target already has this user banned
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/bans`)) {
        return [{ user: { id: USER_NICK }, reason: "older reason" }];
      }
      if (method === "PUT") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx, notes } = harness({ client: stub.client });

    const result = await restoreBans(ctx);

    // no second ban was sent
    expect(stub.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    expect(result.count).toBe(0);
    expect(result.failed).toBe(false);
    expect(result.outcome).toBe("warn");
    const already = notes.filter((note) => note.what.includes(USER_NICK));
    expect(already.length).toBe(1);
    expect(already[0]?.why).toContain("already banned");
  });

  test("the target's ban list is read once, and a ban with no target list still tries", async () => {
    await insertBackupBans(db, [banRow()]);
    const stub = recordingClient((method, route) => {
      if (method === "GET" && route.startsWith(`/guilds/${TARGET_GUILD_ID}/bans`)) {
        throw new DiscordApiError({
          status: 403,
          route,
          method,
          body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
        });
      }
      if (method === "PUT") return undefined;
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client });

    const result = await restoreBans(ctx);

    const listCalls = stub.calls.filter(
      (call) => call.method === "GET" && call.route.includes("/bans"),
    );
    expect(listCalls.length).toBe(1);
    expect(stub.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  test("bans turned off are not applied", async () => {
    await insertBackupBans(db, [banRow()]);
    const stub = recordingClient((method, route) => {
      throw unknownRoute(method, route);
    });
    const { ctx } = harness({ client: stub.client, bans: false });

    const result = await restoreBans(ctx);

    expect(stub.calls).toHaveLength(0);
    expect(result.count).toBe(0);
  });
});
