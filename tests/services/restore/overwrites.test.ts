// tests/services/restore/overwrites.test.ts. restoreOverwrites (D4PLAN 12.4)
// against a real temp-file duckdb and a recording client: a role overwrite
// resolves by name, a member overwrite resolves by user id, the bitfields
// cross as strings, and a target that cannot be resolved is a note.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertBackupChannelOverwrites } from "../../../src/db/queries/backup-overwrites.ts";
import { insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import type { BackupChannelOverwriteRow, BackupRoleRow, Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { restoreOverwrites } from "../../../src/services/restore/overwrites.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
  type RestoreMaps,
  type RestoreOptions,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_GENERAL,
  FIXTURE_GUILD_ID,
  ROLE_MODS,
  USER_PENDING,
} from "../../fixtures/guild.ts";

const TARGET_GUILD_ID = "800000000000000001";
// the channel the restore put in the target for the source channel.
const TARGET_CHANNEL_ID = "8000000000000000100";
// a bitfield above 2^53, the kind that loses digits as a number.
const BIG_BITS = "4611686018427387904";

interface TargetRole {
  id: string;
  name: string;
}

interface Recorded {
  method: string;
  route: string;
  body: unknown;
}

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function backupId(n: number): string {
  return `0190c000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

// a client that records every request and serves the target's roles and
// members. the fixture's restStub serves a capture's payloads, not a
// restore's.
function fakeClient(target: { roles?: TargetRole[]; members?: string[] }): {
  client: DiscordClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const client = {
    async request<T>(request: RequestOptions): Promise<T> {
      const path = request.route.split("?")[0] ?? request.route;
      calls.push({ method: request.method, route: request.route, body: request.body });
      if (request.method === "GET" && path === `/guilds/${TARGET_GUILD_ID}/roles`) {
        return (target.roles ?? []) as T;
      }
      if (request.method === "GET" && path === `/guilds/${TARGET_GUILD_ID}/members`) {
        return (target.members ?? []).map((id) => ({ user: { id } })) as T;
      }
      return {} as T;
    },
  } as unknown as DiscordClient;
  return { client, calls };
}

function roleRow(backup: string, overrides: Partial<BackupRoleRow>): BackupRoleRow {
  return {
    backup_id: backup,
    source_role_id: "",
    name: "",
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
    ...overrides,
  };
}

function overwriteRow(
  backup: string,
  overrides: Partial<BackupChannelOverwriteRow>,
): BackupChannelOverwriteRow {
  return {
    backup_id: backup,
    source_channel_id: CHANNEL_GENERAL,
    target_type: "role",
    source_target_id: "",
    target_name: null,
    allow: "0",
    deny: "0",
    ...overrides,
  };
}

async function seed(backup: string, overwrites: BackupChannelOverwriteRow[]): Promise<void> {
  await insertBackupRoles(db, [
    roleRow(backup, {
      source_role_id: FIXTURE_GUILD_ID,
      name: "@everyone",
      position: 0,
      is_everyone: true,
    }),
    roleRow(backup, { source_role_id: ROLE_MODS, name: "mods", position: 2 }),
  ]);
  await insertBackupChannelOverwrites(db, overwrites);
}

function makeContext(options: {
  client: DiscordClient;
  backup: string;
  maps?: RestoreMaps;
  restoreOptions?: Partial<RestoreOptions>;
}): { ctx: RestoreContext; maps: RestoreMaps; notes: { what: string; why: string }[] } {
  const notes: { what: string; why: string }[] = [];
  const maps = options.maps ?? createRestoreMaps();
  const ctx: RestoreContext = {
    db,
    client: options.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: options.backup,
    targetGuildId: TARGET_GUILD_ID,
    options: { ...DEFAULT_RESTORE_OPTIONS, ...options.restoreOptions },
    maps,
    sourceGuildId: FIXTURE_GUILD_ID,
    backupDir: "/tmp/snapback-restore-overwrites-test",
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: (what: string, why: string) => {
      notes.push({ what, why });
    },
    now: () => "2024-01-01T00:00:00.000Z",
  };
  return { ctx, maps, notes };
}

function writes(calls: readonly Recorded[]): Recorded[] {
  return calls.filter((call) => call.method === "PUT");
}

function bodyOf(call: Recorded | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe("restoreOverwrites", () => {
  test("a role overwrite resolves by name against a role this restore created", async () => {
    const backup = backupId(1);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "role",
        source_target_id: ROLE_MODS,
        target_name: "mods",
        allow: "1024",
        deny: "2048",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    maps.roles.set(ROLE_MODS, "9000000000000000001");
    const { client, calls } = fakeClient({ roles: [] });
    const { ctx } = makeContext({ client, backup, maps });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(1);
    const write = writes(calls)[0];
    expect(write?.route).toBe(
      `/guilds/${TARGET_GUILD_ID}/channels/${TARGET_CHANNEL_ID}/permissions/9000000000000000001`,
    );
    expect(bodyOf(write)).toEqual({ type: 0, allow: "1024", deny: "2048" });
  });

  test("a name that matches an existing target role resolves to that one", async () => {
    const backup = backupId(2);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "role",
        source_target_id: ROLE_MODS,
        target_name: "mods",
        allow: "8",
        deny: "0",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    const { client, calls } = fakeClient({
      roles: [{ id: "9000000000000000777", name: "mods" }],
    });
    const { ctx } = makeContext({ client, backup, maps });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(1);
    expect(writes(calls)[0]?.route).toBe(
      `/guilds/${TARGET_GUILD_ID}/channels/${TARGET_CHANNEL_ID}/permissions/9000000000000000777`,
    );
  });

  test("an unknown target is skipped with a note naming it", async () => {
    const backup = backupId(3);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "role",
        source_target_id: "1000000000000000099",
        target_name: "ghost",
        allow: "0",
        deny: "0",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    const { client, calls } = fakeClient({ roles: [] });
    const { ctx, notes } = makeContext({ client, backup, maps });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(0);
    expect(writes(calls)).toHaveLength(0);
    expect(notes[0]?.what).toContain("ghost");
  });

  test("a member overwrite resolves by user id", async () => {
    const backup = backupId(4);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "member",
        source_target_id: USER_PENDING,
        target_name: "pending",
        allow: "0",
        deny: "2048",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    const { client, calls } = fakeClient({ members: [USER_PENDING] });
    const { ctx } = makeContext({ client, backup, maps });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(1);
    const write = writes(calls)[0];
    expect(write?.route).toBe(
      `/guilds/${TARGET_GUILD_ID}/channels/${TARGET_CHANNEL_ID}/permissions/${USER_PENDING}`,
    );
    expect(bodyOf(write)).toEqual({ type: 1, allow: "0", deny: "2048" });
  });

  test("a member who is not in the target is skipped with a note", async () => {
    const backup = backupId(5);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "member",
        source_target_id: USER_PENDING,
        target_name: "pending",
        allow: "0",
        deny: "2048",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    const { client, calls } = fakeClient({ members: [] });
    const { ctx, notes } = makeContext({ client, backup, maps });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(0);
    expect(writes(calls)).toHaveLength(0);
    expect(notes[0]?.why).toBe("the user is not in the target guild");
  });

  test("allow and deny cross as strings, including a bitfield above 2^53", async () => {
    const backup = backupId(6);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "role",
        source_target_id: ROLE_MODS,
        target_name: "mods",
        allow: BIG_BITS,
        deny: "8",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    maps.roles.set(ROLE_MODS, "9000000000000000001");
    const { client, calls } = fakeClient({ roles: [] });
    const { ctx } = makeContext({ client, backup, maps });

    await restoreOverwrites(ctx);

    const write = writes(calls)[0];
    expect(bodyOf(write).allow).toBe(BIG_BITS);
    expect(typeof bodyOf(write).allow).toBe("string");
    expect(bodyOf(write).deny).toBe("8");
    expect(typeof bodyOf(write).deny).toBe("string");
  });

  test("a channel that is not in the map is a note, not a crash", async () => {
    const backup = backupId(7);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "role",
        source_target_id: ROLE_MODS,
        target_name: "mods",
        allow: "1024",
        deny: "2048",
      }),
    ]);
    const { client, calls } = fakeClient({ roles: [] });
    const { ctx, notes } = makeContext({ client, backup });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(0);
    expect(writes(calls)).toHaveLength(0);
    expect(notes[0]?.why).toBe("the channel is not in the target");
  });

  test("@everyone resolves to the target guild's own role", async () => {
    const backup = backupId(8);
    await seed(backup, [
      overwriteRow(backup, {
        target_type: "role",
        source_target_id: FIXTURE_GUILD_ID,
        target_name: "@everyone",
        allow: "1024",
        deny: "0",
      }),
    ]);
    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL_GENERAL, TARGET_CHANNEL_ID);
    const { client, calls } = fakeClient({ roles: [] });
    const { ctx } = makeContext({ client, backup, maps });

    const result = await restoreOverwrites(ctx);

    expect(result.count).toBe(1);
    expect(writes(calls)[0]?.route).toBe(
      `/guilds/${TARGET_GUILD_ID}/channels/${TARGET_CHANNEL_ID}/permissions/${TARGET_GUILD_ID}`,
    );
  });
});
