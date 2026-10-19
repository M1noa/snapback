// tests/discord/commands/users.test.ts
//
// the /users surface: the commands, the pages they render, and the two rules
// that matter most here. an export carries no token and no bare address, and a
// record from another server is not reachable from this one.

import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import type { VerifyRecordRow } from "../../../src/db/types.ts";
import {
  buildRecordsExport,
  recordsExportToJson,
  USERS_ACTION,
  USERS_OBJECT,
  USERS_SPECS,
  USERS_SURFACE,
  type UsersDeps,
  usersCustomId,
} from "../../../src/discord/commands/users/deps.ts";
import { registerUsersHandlers } from "../../../src/discord/commands/users/handlers.ts";
import { usersCommands } from "../../../src/discord/commands/users/index.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId, Router } from "../../../src/discord/interactions/router.ts";
import { createLogger } from "../../../src/lib/log.ts";

const GUILD = "123456789012345678";
const OTHER_GUILD = "222222222222222222";
const USER = "987654321098765432";
const OWNER = "111111111111111111";
const AT = "2024-06-01T12:00:00.000Z";

function makeRecord(overrides: Partial<VerifyRecordRow> = {}): VerifyRecordRow {
  return {
    record_id: "0190a000-0000-7000-8000-0000000000d1",
    guild_id: GUILD,
    user_id: USER,
    username: "someone",
    global_name: "Some One",
    discriminator: "0",
    avatar_url: null,
    email: "someone@example.com",
    email_verified: true,
    locale: "en-GB",
    mfa_enabled: false,
    premium_type: 0,
    flags: 0,
    connections_json: null,
    guilds_json: null,
    relationships_json: null,
    oauth_scopes_json: ["identify", "email", "guilds.join"],
    oauth_granted_at: "2024-06-01T00:00:00.000Z",
    oauth_last_checked_at: null,
    access_token_enc: "ACCESS-TOKEN-CIPHERTEXT",
    refresh_token_enc: "REFRESH-TOKEN-CIPHERTEXT",
    token_expires_at: "2024-06-02T00:00:00.000Z",
    token_status: "valid",
    first_ip_hash: "sha256-of-the-address",
    first_ip_enc: null,
    last_ip_hash: "sha256-of-the-address",
    last_ip_enc: null,
    ip_history_json: [{ hash: "sha256-of-the-address", at: AT, event: "verify" }],
    country_code: "gb",
    country_name: "United Kingdom",
    city: null,
    region: null,
    isp: "an isp",
    asn: null,
    as_org: "an org",
    ip_type: "residential",
    is_vpn: false,
    is_proxy: false,
    is_tor: false,
    intel_checked_at: null,
    fingerprint_json: null,
    referrer: null,
    user_agent: null,
    revoked_at: null,
    notes: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as VerifyRecordRow;
}

/** the jobs the surface queued, so a test can see what it asked for. */
interface FakeHarness {
  readonly enqueued: { kind: string; payload: unknown }[];
}

function fakeDeps(
  overrides: Partial<UsersDeps> = {},
  harness: FakeHarness = { enqueued: [] },
): UsersDeps {
  const records = [makeRecord()];
  const jobRows: Record<string, unknown>[] = [];
  return {
    db: {
      query: async (sql: string) => {
        if (sql.includes("FROM jobs")) return jobRows;
        return [];
      },
      run: async () => {},
    } as unknown as UsersDeps["db"],
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async (kind: string, input: { guildId: string; payload?: unknown }) => {
        harness.enqueued.push({ kind, payload: input.payload });
        jobRows.push({
          id: `job-${harness.enqueued.length}`,
          guild_id: input.guildId,
          kind,
          status: "queued",
          requested_by: OWNER,
          payload_json: JSON.stringify(input.payload ?? null),
          progress_json: null,
          error_code: null,
          error_body: null,
          created_at: AT,
          started_at: null,
          finished_at: null,
          attempts: 0,
        });
        return { id: `job-${harness.enqueued.length}` };
      },
      eta: async () => null,
    } as unknown as UsersDeps["jobs"],
    now: () => Date.parse(AT),
    ipStorage: "hash",
    exportDir: "/tmp/snapback-users-test",
    authorize: async () => true,
    audit: async () => {},
    records: async (guildId) => records.filter((row) => row.guild_id === guildId),
    record: async (guildId, userId) =>
      records.find((row) => row.guild_id === guildId && row.user_id === userId) ?? null,
    member: async () => ({ state: "member", nickname: null, joinedAt: null }),
    ...overrides,
  };
}

function walk(node: unknown, visit: (n: { customID?: string }) => void): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { customID?: string; components?: unknown[] };
  visit(record);
  if (Array.isArray(record.components)) for (const child of record.components) walk(child, visit);
}

describe("the /users command group", () => {
  test("every documented subcommand is registered, once", () => {
    const names = usersCommands(fakeDeps())
      .map((command) => command.subcommand)
      .sort();
    expect(names).toEqual(["export", "lookup"]);
  });

  test("every page the group renders stays inside the component budget", async () => {
    const commands = usersCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: OWNER,
        options: { user: USER, scope: "records" },
      });
      expect(countComponents(result.page as ContainerComponent)).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  test("every id a page produces parses as a users control", async () => {
    const commands = usersCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: OWNER,
        options: { user: USER, scope: "records" },
      });
      const ids: string[] = [];
      walk(result.page, (node) => {
        if (typeof node.customID === "string") ids.push(node.customID);
      });
      for (const produced of ids) {
        const parsed = parseCustomId(produced);
        expect(parsed?.surface).toBe(USERS_SURFACE);
        expect(parsed?.guild).toBe(GUILD);
      }
    }
  });

  test("a person who is not an admin gets a refusal", async () => {
    const deps = fakeDeps({ authorize: async () => false });
    const lookup = usersCommands(deps).find((command) => command.subcommand === "lookup");
    const result = await lookup?.run({ guildId: GUILD, userId: USER, options: { user: USER } });
    expect(JSON.stringify(result?.page)).toContain("snapback admins");
  });
});

describe("the export", () => {
  test("it carries no token and no bare address", () => {
    const bundle = buildRecordsExport([makeRecord()], "hash", GUILD, AT);
    const json = recordsExportToJson(bundle);

    expect(json).not.toContain("ACCESS-TOKEN-CIPHERTEXT");
    expect(json).not.toContain("REFRESH-TOKEN-CIPHERTEXT");
    expect(json).not.toContain("access_token");
    expect(json).not.toContain("refresh_token");
    expect(json).not.toContain("203.0.113.7");
    // the hash the mode produced is what the file holds.
    expect(json).toContain("sha256-of-the-address");
  });

  test("the address is written in the form the storage mode produced", () => {
    const record = makeRecord({
      first_ip_hash: "sha256-of-the-address",
      first_ip_enc: "203.0.113.7",
      last_ip_hash: "sha256-of-the-address",
      last_ip_enc: "203.0.113.7",
    });

    const hashed = recordsExportToJson(buildRecordsExport([record], "hash", GUILD, AT));
    expect(hashed).not.toContain("203.0.113.7");
    expect(hashed).toContain("sha256-of-the-address");
    expect(hashed).toContain('"ip_storage": "hash"');

    const plain = recordsExportToJson(buildRecordsExport([record], "plaintext", GUILD, AT));
    expect(plain).toContain("203.0.113.7");
    expect(plain).toContain('"ip_storage": "plaintext"');
  });

  test("writing it out is a job, not an inline write", async () => {
    const harness: FakeHarness = { enqueued: [] };
    const deps = fakeDeps({}, harness);
    const exportCommand = usersCommands(deps).find((command) => command.subcommand === "export");
    await exportCommand?.run({ guildId: GUILD, userId: OWNER, options: { scope: "records" } });

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]?.kind).toBe("export");
    const payload = harness.enqueued[0]?.payload as { scope?: string };
    expect(payload.scope).toBe("records");
  });
});

describe("the record picker", () => {
  test("opens the record it names", async () => {
    const deps = fakeDeps();
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, deps);

    const lookup = usersCommands(deps).find((command) => command.subcommand === "lookup");
    const result = await lookup?.run({ guildId: GUILD, userId: OWNER, options: { user: USER } });
    const ids: string[] = [];
    walk(result?.page, (node) => {
      if (typeof node.customID === "string") ids.push(node.customID);
    });
    const selectId = ids.find((id) => id.includes(`:${USERS_ACTION.open}:`));
    expect(selectId).toBeDefined();

    const messages: string[] = [];
    const outcome = await router.route(
      selectId!,
      { userId: OWNER, guildId: GUILD, isOwner: true },
      {
        reply: async (request) => {
          messages.push(JSON.stringify(request.message));
        },
        openModal: async () => {},
        values: { [selectId!]: [USER] },
        source: "component",
      },
    );
    expect(outcome.kind).toBe("handled");
    expect(messages.join("")).toContain("the record for someone");
  });
});

describe("a record from another server", () => {
  test("is not reachable from this one", async () => {
    const elsewhere = makeRecord({
      guild_id: OTHER_GUILD,
      username: "elsewhere",
      email: "elsewhere@example.com",
    });
    // both reads are scoped to the guild, the way the wiring scopes them.
    const deps = fakeDeps({
      records: async () => [elsewhere],
      record: async (guildId, userId) =>
        elsewhere.guild_id === guildId && elsewhere.user_id === userId ? elsewhere : null,
    });
    const lookup = usersCommands(deps).find((command) => command.subcommand === "lookup");
    const result = await lookup?.run({ guildId: GUILD, userId: OWNER, options: { user: USER } });

    const text = JSON.stringify(result?.page);
    expect(text).toContain("no such record");
    expect(text).not.toContain("elsewhere@example.com");
    expect(text).not.toContain("elsewhere");
  });
});

describe("the boot assertion", () => {
  test("every spec has a handler, and every handler has a spec", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, fakeDeps());
    const registered = router.registeredKeys().filter((key) => key.startsWith(`${USERS_SURFACE}:`));
    expect(registered.sort()).toEqual(
      USERS_SPECS.map((spec) => `${spec.surface}:${spec.action}`).sort(),
    );
  });

  test("a gap in the surface fails the boot", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, fakeDeps());
    expect(() =>
      router.assertComplete([...USERS_SPECS, { surface: USERS_SURFACE, action: "ghost" }]),
    ).toThrow();
  });
});

describe("the custom id builder", () => {
  test("the cursor slot is always written", () => {
    const id = usersCustomId({
      guildId: GUILD,
      object: USERS_OBJECT.record,
      action: USERS_ACTION.export,
    });
    expect(id.split(":")).toHaveLength(6);
    expect(parseCustomId(id)?.cursor).toBe("");
  });
});
