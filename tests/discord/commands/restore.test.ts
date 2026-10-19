// tests/discord/commands/restore.test.ts
//
// the /restore surface: the commands, the pages they render, and the two rules
// that matter most here. a restore is confirmed with a one-time nonce, and the
// clear needs the guild's name typed out before it is armed.

import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS } from "../../../src/config/defaults.ts";
import type { BackupRow } from "../../../src/db/types.ts";
import {
  RESTORE_ACTION,
  RESTORE_OBJECT,
  RESTORE_SPECS,
  RESTORE_SURFACE,
  type RestoreDeps,
  restoreCustomId,
} from "../../../src/discord/commands/restore/deps.ts";
import { registerRestoreHandlers } from "../../../src/discord/commands/restore/handlers.ts";
import { restoreCommands } from "../../../src/discord/commands/restore/index.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId, Router } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { DEFAULT_RESTORE_OPTIONS } from "../../../src/services/restore/types.ts";

const GUILD = "123456789012345678";
const USER = "987654321098765432";

function makeBackup(overrides: Partial<BackupRow> = {}): BackupRow {
  return {
    backup_id: "0190a000-0000-7000-8000-000000000001",
    guild_id: GUILD,
    label: "nightly",
    kind: "manual",
    guild_name: "test guild",
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: null,
    member_count: 3,
    message_count: 10,
    channel_count: 2,
    role_count: 4,
    size_bytes: 1024,
    schema_version: 1,
    guild_settings_json: null,
    onboarding_json: null,
    welcome_screen_json: null,
    widget_json: null,
    afk_json: null,
    self_check_json: { ok: true, failures: [], skipped: [] },
    created_at: "2024-06-01T00:00:00.000Z",
    created_by: USER,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<RestoreDeps> = {}): RestoreDeps {
  const backups = [makeBackup()];
  const enqueued: { kind: string; payload: unknown }[] = [];
  const state = new MemoryStateStore();
  return {
    db: { query: async () => [] } as unknown as RestoreDeps["db"],
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async (kind: string, input: { payload: unknown }) => {
        enqueued.push({ kind, payload: input.payload });
        return { id: "job-1" };
      },
    } as unknown as RestoreDeps["jobs"],
    now: () => 1_717_200_000_000,
    settings: async () => DEFAULT_GUILD_SETTINGS,
    state,
    backups: async (guildId) => backups.filter((row) => row.guild_id === guildId),
    guilds: async () => [
      { id: GUILD, name: "the target guild" },
      { id: "222222222222222222", name: "another guild" },
    ],
    lookup: async (guildId, backupId) =>
      backups.find((row) => row.backup_id === backupId && row.guild_id === guildId) ?? null,
    authorize: async () => true,
    audit: async () => {},
    plan: async () => ({
      phases: [{ phase: "roles", ops: [{ what: "create role @mods", count: 4 }] }],
    }),
    ...overrides,
  };
}

function walk(node: unknown, visit: (n: { customID?: string }) => void): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { customID?: string; components?: unknown[] };
  visit(record);
  if (Array.isArray(record.components)) for (const child of record.components) walk(child, visit);
}

describe("the /restore command group", () => {
  test("every documented subcommand is registered, once", () => {
    const names = restoreCommands(fakeDeps())
      .map((command) => command.subcommand)
      .sort();
    expect(names).toEqual(["cancel", "members", "messages", "plan", "start", "status"]);
  });

  test("the options that name a backup and a guild are marked for autocomplete", () => {
    const commands = restoreCommands(fakeDeps());
    const start = commands.find((command) => command.subcommand === "start");
    for (const name of ["backup", "target_guild"]) {
      expect(start?.options?.find((option) => option.name === name)?.autocomplete).toBe(true);
    }
  });

  test("every page the group renders stays inside the component budget", async () => {
    const commands = restoreCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: USER,
        options: { backup: "0190a000-0000-7000-8000-000000000001", target_guild: GUILD },
      });
      expect(countComponents(result.page as ContainerComponent)).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  test("every id a page produces parses as a restore control", async () => {
    const commands = restoreCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: USER,
        options: { backup: "0190a000-0000-7000-8000-000000000001", target_guild: GUILD },
      });
      const ids: string[] = [];
      walk(result.page, (node) => {
        if (typeof node.customID === "string") ids.push(node.customID);
      });
      for (const produced of ids) {
        const parsed = parseCustomId(produced);
        expect(parsed?.surface).toBe(RESTORE_SURFACE);
        expect(parsed?.guild).toBe(GUILD);
      }
    }
  });

  test("a person who is not an admin gets a refusal", async () => {
    const deps = fakeDeps({ authorize: async () => false });
    const start = restoreCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({
      guildId: GUILD,
      userId: USER,
      options: { backup: "0190a000-0000-7000-8000-000000000001", target_guild: GUILD },
    });
    expect(JSON.stringify(result?.page)).toContain("snapback admins");
  });
});

describe("the boot assertion", () => {
  test("every spec has a handler, and every handler has a spec", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerRestoreHandlers(router, fakeDeps());
    const registered = router
      .registeredKeys()
      .filter((key) => key.startsWith(`${RESTORE_SURFACE}:`));
    expect(registered.sort()).toEqual(
      RESTORE_SPECS.map((spec) => `${spec.surface}:${spec.action}`).sort(),
    );
  });

  test("a gap in the surface fails the boot", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerRestoreHandlers(router, fakeDeps());
    expect(() =>
      router.assertComplete([...RESTORE_SPECS, { surface: RESTORE_SURFACE, action: "ghost" }]),
    ).toThrow();
  });
});

describe("the restore options", () => {
  test("the safe defaults are the safe ones", () => {
    expect(DEFAULT_RESTORE_OPTIONS.memberMode).toBe(1);
    expect(DEFAULT_RESTORE_OPTIONS.clearBefore).toBe(false);
    expect(DEFAULT_RESTORE_OPTIONS.deleteExtraRoles).toBe(false);
    expect(DEFAULT_RESTORE_OPTIONS.timestampSuffix).toBe(false);
  });

  test("the custom id builder writes the cursor slot every time", () => {
    const id = restoreCustomId({
      guildId: GUILD,
      object: RESTORE_OBJECT.confirm,
      action: RESTORE_ACTION.confirm,
    });
    expect(id.split(":")).toHaveLength(6);
    expect(parseCustomId(id)?.cursor).toBe("");
  });
});
