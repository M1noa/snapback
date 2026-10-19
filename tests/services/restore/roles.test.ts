// tests/services/restore/roles.test.ts. restoreRoles (D4PLAN 12.3) against a
// real temp-file duckdb and a recording client: @everyone is edited rather than
// created, the other roles are created in position-descending order, the
// hierarchy is set in one call, and a 64-bit permissions bitfield crosses as a
// string.
//
// each test seeds its own backup_id, so the (backup_id, source_role_id)
// primary key never collides across cases.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertBackupRoles } from "../../../src/db/queries/backup-roles.ts";
import type { BackupRoleRow, Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { restoreRoles } from "../../../src/services/restore/roles.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
  type RestoreMaps,
  type RestoreOptions,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  FIXTURE_GUILD_ID,
  ROLE_BOT,
  ROLE_MEMBERS,
  ROLE_MODS,
  USER_BOT,
} from "../../fixtures/guild.ts";

// the guild the restore writes into. its id is the @everyone role's id.
const TARGET_GUILD_ID = "800000000000000001";
// the widest a permission bitfield gets: 2^63-1, well above 2^53.
const MAX_BITS = "9223372036854775807";
// the integration id the fixture's managed role carries.
const INTEGRATION_ID = "1000000000000000045";
// the png signature is enough: the client never looks at the bytes.
const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");

interface TargetRole {
  id: string;
  name: string;
  managed?: boolean;
  tags?: { bot_id?: string; integration_id?: string } | null;
}

interface Recorded {
  method: string;
  route: string;
  body: unknown;
}

let db: Database;
const tempDirs: string[] = [];

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function backupId(n: number): string {
  return `0190b000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapback-restore-roles-"));
  tempDirs.push(dir);
  return dir;
}

// a client that records every request and serves the target's roles. the
// fixture's restStub serves a capture's payloads, not a restore's.
function fakeClient(target: {
  roles?: TargetRole[];
  features?: string[];
  /** the error to throw for a call, or undefined to let it through. */
  fail?: (method: string, path: string, nth: number) => unknown;
}): { client: DiscordClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  let created = 0;

  const client = {
    async request<T>(request: RequestOptions): Promise<T> {
      const path = request.route.split("?")[0] ?? request.route;
      calls.push({ method: request.method, route: request.route, body: request.body });
      const key = `${request.method} ${path}`;
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);

      const failure = target.fail?.(request.method, path, nth);
      if (failure !== undefined) throw failure;

      if (request.method === "GET" && path === `/guilds/${TARGET_GUILD_ID}/roles`) {
        return (target.roles ?? []) as T;
      }
      if (request.method === "GET" && path === `/guilds/${TARGET_GUILD_ID}`) {
        return { features: target.features ?? [] } as T;
      }
      if (request.method === "POST" && path === `/guilds/${TARGET_GUILD_ID}/roles`) {
        created += 1;
        return { id: `9000000000000000${String(created).padStart(3, "0")}` } as T;
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

// the fixture guild's four roles, as the backup stored them.
function seedRoles(backup: string): Promise<void> {
  return insertBackupRoles(db, [
    roleRow(backup, {
      source_role_id: FIXTURE_GUILD_ID,
      name: "@everyone",
      position: 0,
      permissions: MAX_BITS,
      is_everyone: true,
    }),
    roleRow(backup, {
      source_role_id: ROLE_MODS,
      name: "mods",
      color: 16711680,
      hoist: true,
      mentionable: true,
      position: 2,
      permissions: "8",
      icon_url: `https://cdn.discordapp.com/role-icons/${ROLE_MODS}/roleiconhash.png`,
    }),
    roleRow(backup, {
      source_role_id: ROLE_MEMBERS,
      name: "members",
      color: 3066993,
      mentionable: true,
      position: 1,
      permissions: "1024",
      unicode_emoji: "\u{1F44B}",
    }),
    roleRow(backup, {
      source_role_id: ROLE_BOT,
      name: "snapbot",
      color: 5793266,
      position: 3,
      permissions: "104324673",
      is_bot_managed: true,
      bot_id: USER_BOT,
      integration_id: INTEGRATION_ID,
    }),
  ]);
}

function makeContext(options: {
  client: DiscordClient;
  backup: string;
  maps?: RestoreMaps;
  restoreOptions?: Partial<RestoreOptions>;
  backupDir?: string;
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
    backupDir: options.backupDir ?? tempDir(),
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: (what: string, why: string) => {
      notes.push({ what, why });
    },
    now: () => "2024-01-01T00:00:00.000Z",
  };
  return { ctx, maps, notes };
}

function creates(calls: readonly Recorded[]): Recorded[] {
  return calls.filter(
    (call) => call.method === "POST" && call.route === `/guilds/${TARGET_GUILD_ID}/roles`,
  );
}

function bodyOf(call: Recorded | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe("restoreRoles", () => {
  test("@everyone is edited, never created", async () => {
    const backup = backupId(1);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
    });
    const { ctx, maps } = makeContext({ client, backup });

    await restoreRoles(ctx);

    // only the two ordinary roles are created. @everyone is patched.
    expect(creates(calls).map((call) => bodyOf(call).name)).toEqual(["mods", "members"]);
    const patch = calls.find(
      (call) =>
        call.method === "PATCH" &&
        call.route === `/guilds/${TARGET_GUILD_ID}/roles/${TARGET_GUILD_ID}`,
    );
    expect(patch).toBeDefined();
    expect(bodyOf(patch)).toEqual({
      color: 0,
      hoist: false,
      mentionable: false,
      permissions: MAX_BITS,
    });
    expect(maps.roles.get(FIXTURE_GUILD_ID)).toBe(TARGET_GUILD_ID);
  });

  test("the roles are created in position-descending order", async () => {
    const backup = backupId(2);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
    });
    const { ctx } = makeContext({ client, backup });

    await restoreRoles(ctx);

    // mods sits at position 2, members at 1.
    expect(creates(calls).map((call) => bodyOf(call).name)).toEqual(["mods", "members"]);
  });

  test("the order is set in one call carrying the whole array", async () => {
    const backup = backupId(3);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
    });
    const { ctx } = makeContext({ client, backup });

    await restoreRoles(ctx);

    const reorders = calls.filter(
      (call) => call.method === "PATCH" && call.route === `/guilds/${TARGET_GUILD_ID}/roles`,
    );
    expect(reorders).toHaveLength(1);
    expect(reorders[0]?.body).toEqual([
      { id: "9000000000000000002", position: 1 },
      { id: "9000000000000000001", position: 2 },
    ]);
  });

  test("the permissions string crosses unchanged, including above 2^53", async () => {
    const backup = backupId(4);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
    });
    const { ctx } = makeContext({ client, backup });

    await restoreRoles(ctx);

    const everyone = calls.find(
      (call) =>
        call.method === "PATCH" &&
        call.route === `/guilds/${TARGET_GUILD_ID}/roles/${TARGET_GUILD_ID}`,
    );
    expect(bodyOf(everyone).permissions).toBe(MAX_BITS);
    expect(typeof bodyOf(everyone).permissions).toBe("string");

    const mods = creates(calls).find((call) => bodyOf(call).name === "mods");
    expect(bodyOf(mods).permissions).toBe("8");
    expect(typeof bodyOf(mods).permissions).toBe("string");
  });

  test("the created role's id lands in the map", async () => {
    const backup = backupId(5);
    await seedRoles(backup);
    const { client } = fakeClient({ roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }] });
    const { ctx, maps } = makeContext({ client, backup });

    await restoreRoles(ctx);

    expect(maps.roles.get(ROLE_MODS)).toBe("9000000000000000001");
    expect(maps.roles.get(ROLE_MEMBERS)).toBe("9000000000000000002");
  });

  test("a bot-managed role is never created and is reported", async () => {
    const backup = backupId(6);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
    });
    const { ctx, maps, notes } = makeContext({ client, backup });

    await restoreRoles(ctx);

    expect(creates(calls).map((call) => bodyOf(call).name)).not.toContain("snapbot");
    expect(maps.roles.has(ROLE_BOT)).toBe(false);
    expect(notes.map((note) => note.why)).toContain(
      "not restorable: integration role from an application not in this guild",
    );
  });

  test("a managed role links to the target's integration role of the same application", async () => {
    const backup = backupId(7);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [
        { id: TARGET_GUILD_ID, name: "@everyone" },
        {
          id: "9000000000000000009",
          name: "snapbot",
          managed: true,
          tags: { bot_id: USER_BOT, integration_id: INTEGRATION_ID },
        },
      ],
    });
    const { ctx, maps, notes } = makeContext({ client, backup });

    await restoreRoles(ctx);

    expect(creates(calls).map((call) => bodyOf(call).name)).not.toContain("snapbot");
    expect(maps.roles.get(ROLE_BOT)).toBe("9000000000000000009");
    expect(notes.map((note) => note.why)).not.toContain(
      "not restorable: integration role from an application not in this guild",
    );
  });

  test("a missing icon file notes and the role is created anyway", async () => {
    const backup = backupId(8);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
      features: ["ROLE_ICONS"],
    });
    const { ctx, maps, notes } = makeContext({ client, backup });

    await restoreRoles(ctx);

    expect(notes.map((note) => note.why)).toContain(
      "the file is not in the backup's asset directory",
    );
    const mods = creates(calls).find((call) => bodyOf(call).name === "mods");
    expect(bodyOf(mods).icon).toBeUndefined();
    expect(maps.roles.has(ROLE_MODS)).toBe(true);
  });

  test("the role icon rides in the same body as the colour", async () => {
    const backup = backupId(9);
    await seedRoles(backup);
    const dir = tempDir();
    mkdirSync(join(dir, backup, "assets", "role"), { recursive: true });
    writeFileSync(join(dir, backup, "assets", "role", `${ROLE_MODS}.png`), PNG_BYTES);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
      features: ["ROLE_ICONS"],
    });
    const { ctx } = makeContext({ client, backup, backupDir: dir });

    await restoreRoles(ctx);

    const mods = creates(calls).find((call) => bodyOf(call).name === "mods");
    expect(bodyOf(mods).icon).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    expect(bodyOf(mods).color).toBe(16711680);
  });

  test("a target without ROLE_ICONS gets the role without the icon and a note", async () => {
    const backup = backupId(10);
    await seedRoles(backup);
    const dir = tempDir();
    mkdirSync(join(dir, "assets", "role"), { recursive: true });
    writeFileSync(join(dir, "assets", "role", `${ROLE_MODS}.png`), PNG_BYTES);
    const { client, calls } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
      features: ["COMMUNITY"],
    });
    const { ctx, notes } = makeContext({ client, backup, backupDir: dir });

    await restoreRoles(ctx);

    expect(notes.map((note) => note.why)).toContain(
      "the target guild does not have the ROLE_ICONS feature",
    );
    const mods = creates(calls).find((call) => bodyOf(call).name === "mods");
    expect(bodyOf(mods).icon).toBeUndefined();
  });

  test("deleteExtraRoles never touches @everyone or a managed role", async () => {
    const backup = backupId(11);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [
        { id: TARGET_GUILD_ID, name: "@everyone" },
        { id: "9000000000000000011", name: "snapbot", managed: true, tags: { bot_id: USER_BOT } },
        { id: "9000000000000000012", name: "mods" },
        { id: "9000000000000000013", name: "stranger" },
      ],
    });
    const { ctx } = makeContext({
      client,
      backup,
      restoreOptions: { deleteExtraRoles: true },
    });

    await restoreRoles(ctx);

    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.route).toBe(`/guilds/${TARGET_GUILD_ID}/roles/9000000000000000013`);
  });

  test("deleteExtraRoles is off by default", async () => {
    const backup = backupId(12);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [
        { id: TARGET_GUILD_ID, name: "@everyone" },
        { id: "9000000000000000013", name: "stranger" },
      ],
    });
    const { ctx } = makeContext({ client, backup });

    await restoreRoles(ctx);

    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  test("reuseRoles edits the target role with the same name instead of making a second one", async () => {
    const backup = backupId(13);
    await seedRoles(backup);
    const { client, calls } = fakeClient({
      roles: [
        { id: TARGET_GUILD_ID, name: "@everyone" },
        { id: "9000000000000000021", name: "mods" },
      ],
    });
    const { ctx, maps } = makeContext({ client, backup });

    await restoreRoles(ctx);

    expect(creates(calls).map((call) => bodyOf(call).name)).not.toContain("mods");
    const patch = calls.find(
      (call) =>
        call.method === "PATCH" &&
        call.route === `/guilds/${TARGET_GUILD_ID}/roles/9000000000000000021`,
    );
    expect(patch).toBeDefined();
    expect(bodyOf(patch).name).toBe("mods");
    expect(maps.roles.get(ROLE_MODS)).toBe("9000000000000000021");
  });

  test("a role-cap error is a note and the phase returns what it did", async () => {
    const backup = backupId(14);
    await seedRoles(backup);
    const cap = new DiscordApiError({
      status: 400,
      route: `/guilds/${TARGET_GUILD_ID}/roles`,
      method: "POST",
      body: JSON.stringify({ code: 30003, message: "Maximum number of roles reached (250)" }),
    });
    const { client } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
      fail: (method, path) =>
        method === "POST" && path === `/guilds/${TARGET_GUILD_ID}/roles` ? cap : undefined,
    });
    const { ctx, notes } = makeContext({ client, backup });

    const result = await restoreRoles(ctx);

    expect(result.failed).toBe(true);
    // @everyone was edited before the cap was hit.
    expect(result.count).toBe(1);
    expect(notes.map((note) => note.why)).toContain("30003 Maximum number of roles reached (250)");
  });

  test("a 429 is a note and the phase returns what it did", async () => {
    const backup = backupId(15);
    await seedRoles(backup);
    const limited = new DiscordApiError({
      status: 429,
      route: `/guilds/${TARGET_GUILD_ID}/roles`,
      method: "POST",
      body: JSON.stringify({ code: 0, message: "You are being rate limited." }),
    });
    const { client } = fakeClient({
      roles: [{ id: TARGET_GUILD_ID, name: "@everyone" }],
      fail: (method, path, nth) =>
        method === "POST" && path === `/guilds/${TARGET_GUILD_ID}/roles` && nth === 2
          ? limited
          : undefined,
    });
    const { ctx, notes } = makeContext({ client, backup });

    const result = await restoreRoles(ctx);

    expect(result.failed).toBe(true);
    // @everyone and the first role were done before the 429.
    expect(result.count).toBe(2);
    expect(notes.some((note) => note.why.includes("You are being rate limited."))).toBe(true);
  });
});
