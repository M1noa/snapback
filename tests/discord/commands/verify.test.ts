// tests/discord/commands/verify.test.ts
//
// the /verify surface: the commands, the pages they render, and the two rules
// that matter most here. a restricted scope needs its acknowledgement, and
// erasing captured data is the owner's alone to do.

import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS } from "../../../src/config/defaults.ts";
import type { VerifyPanelRow, VerifyRecordRow } from "../../../src/db/types.ts";
import {
  VERIFY_ACTION,
  VERIFY_OBJECT,
  VERIFY_SPECS,
  VERIFY_SURFACE,
  type VerifyDeps,
  verifyCustomId,
} from "../../../src/discord/commands/verify/deps.ts";
import { registerVerifyHandlers } from "../../../src/discord/commands/verify/handlers.ts";
import { verifyCommands } from "../../../src/discord/commands/verify/index.ts";
import { SCOPES } from "../../../src/discord/commands/verify/pages.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId, Router } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";

const GUILD = "123456789012345678";
const USER = "987654321098765432";
const OWNER = "111111111111111111";

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
    oauth_scopes_json: ["identify", "email"],
    oauth_granted_at: "2024-06-01T00:00:00.000Z",
    oauth_last_checked_at: null,
    access_token_enc: "enc",
    refresh_token_enc: "enc",
    token_expires_at: null,
    token_status: "valid",
    first_ip_hash: "hash",
    first_ip_enc: null,
    last_ip_hash: "hash",
    last_ip_enc: null,
    ip_history_json: null,
    country_code: "gb",
    country_name: "United Kingdom",
    isp: "an isp",
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
    ...overrides,
  } as VerifyRecordRow;
}

function fakeDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  const records = [makeRecord()];
  const saved: unknown[] = [];
  const deleted: { userId: string; scope: string }[] = [];
  return {
    db: { query: async () => [] } as unknown as VerifyDeps["db"],
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async () => ({ id: "job-1" }),
    } as unknown as VerifyDeps["jobs"],
    now: () => 1_717_200_000_000,
    settings: async () => DEFAULT_GUILD_SETTINGS,
    state: new MemoryStateStore(),
    records: async (guildId) => records.filter((row) => row.guild_id === guildId),
    record: async (guildId, userId) =>
      records.find((row) => row.guild_id === guildId && row.user_id === userId) ?? null,
    panel: async (): Promise<VerifyPanelRow | null> => null,
    savePanel: async (input) => {
      saved.push(input);
      return { panel_id: "p1" } as VerifyPanelRow;
    },
    deleteRecord: async (input) => {
      deleted.push({ userId: input.userId, scope: input.scope });
      return { deleted: true, what: input.scope };
    },
    refresh: async () => ({ checked: 0, refreshed: 0, failed: 0 }),
    ownerId: OWNER,
    authorize: async () => true,
    audit: async () => {},
    ...overrides,
  };
}

function walk(node: unknown, visit: (n: { customID?: string }) => void): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { customID?: string; components?: unknown[] };
  visit(record);
  if (Array.isArray(record.components)) for (const child of record.components) walk(child, visit);
}

describe("the /verify command group", () => {
  test("every documented subcommand is registered, once", () => {
    const names = verifyCommands(fakeDeps())
      .map((command) => command.subcommand)
      .sort();
    expect(names).toEqual(["delete", "panel", "record", "records", "refresh"]);
  });

  test("every page the group renders stays inside the component budget", async () => {
    const commands = verifyCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: OWNER,
        options: { user: USER, scope: "record" },
      });
      expect(countComponents(result.page as ContainerComponent)).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  test("every id a page produces parses as a verify control", async () => {
    const commands = verifyCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: OWNER,
        options: { user: USER, scope: "record" },
      });
      const ids: string[] = [];
      walk(result.page, (node) => {
        if (typeof node.customID === "string") ids.push(node.customID);
      });
      for (const produced of ids) {
        const parsed = parseCustomId(produced);
        expect(parsed?.surface).toBe(VERIFY_SURFACE);
        expect(parsed?.guild).toBe(GUILD);
      }
    }
  });

  test("a person who is not an admin gets a refusal", async () => {
    const deps = fakeDeps({ authorize: async () => false });
    const records = verifyCommands(deps).find((command) => command.subcommand === "records");
    const result = await records?.run({ guildId: GUILD, userId: USER, options: {} });
    expect(JSON.stringify(result?.page)).toContain("snapback admins");
  });

  test("the scope list carries the consequence lines", () => {
    const identify = SCOPES.find((scope) => scope.key === "identify");
    expect(identify?.consequence).toContain("basic profile");
    const restricted = SCOPES.find((scope) => scope.key === "relationships.read");
    expect(restricted?.consequence).toContain("Social SDK");
  });

  test("only the owner may erase a record", async () => {
    const deps = fakeDeps();
    const remove = verifyCommands(deps).find((command) => command.subcommand === "delete");
    const refused = await remove?.run({
      guildId: GUILD,
      userId: USER,
      options: { user: USER, scope: "record" },
    });
    expect(JSON.stringify(refused?.page)).toContain("instance owner");

    const allowed = await remove?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { user: USER, scope: "record" },
    });
    expect(JSON.stringify(allowed?.page)).toContain("delete a record");
  });
});

describe("the boot assertion", () => {
  test("every spec has a handler, and every handler has a spec", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerVerifyHandlers(router, fakeDeps());
    const registered = router
      .registeredKeys()
      .filter((key) => key.startsWith(`${VERIFY_SURFACE}:`));
    expect(registered.sort()).toEqual(
      VERIFY_SPECS.map((spec) => `${spec.surface}:${spec.action}`).sort(),
    );
  });

  test("a gap in the surface fails the boot", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerVerifyHandlers(router, fakeDeps());
    expect(() =>
      router.assertComplete([...VERIFY_SPECS, { surface: VERIFY_SURFACE, action: "ghost" }]),
    ).toThrow();
  });
});

describe("the custom id builder", () => {
  test("the cursor slot is always written", () => {
    const id = verifyCustomId({
      guildId: GUILD,
      object: VERIFY_OBJECT.record,
      action: VERIFY_ACTION.delete,
    });
    expect(id.split(":")).toHaveLength(6);
    expect(parseCustomId(id)?.cursor).toBe("");
  });
});
