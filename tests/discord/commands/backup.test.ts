// tests/discord/commands/backup.test.ts
//
// the /backup surface: the command definitions, the pages they render, and the
// rules the surface rests on (a scoped lookup, a one-time nonce, a component
// count inside the budget, and a boot assertion that covers every id).

import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS } from "../../../src/config/defaults.ts";
import type { BackupRow } from "../../../src/db/types.ts";
import {
  BACKUP_ACTION,
  BACKUP_OBJECT,
  BACKUP_SPECS,
  BACKUP_SURFACE,
  type BackupDeps,
  backupCustomId,
} from "../../../src/discord/commands/backup/deps.ts";
import { registerBackupHandlers } from "../../../src/discord/commands/backup/handlers.ts";
import { backupCommands, expectedConfirm } from "../../../src/discord/commands/backup/index.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId, Router } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { DEFAULT_RETENTION } from "../../../src/services/retention/index.ts";

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

function fakeDeps(overrides: Partial<BackupDeps> = {}): BackupDeps {
  const backups = [makeBackup()];
  return {
    // the job page reads the job row; an empty result is the "that job is gone"
    // page, which is a page this test can still render.
    db: { query: async () => [] } as unknown as BackupDeps["db"],
    client: {} as BackupDeps["client"],
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async () => ({ id: "job-1" }),
      eta: async () => null,
      pause: async () => {},
      resume: async () => {},
      cancel: async () => {},
    } as unknown as BackupDeps["jobs"],
    now: () => 1_717_200_000_000,
    retention: async () => ({ ...DEFAULT_RETENTION, guild_id: GUILD }),
    settings: async () => DEFAULT_GUILD_SETTINGS,
    state: new MemoryStateStore(),
    limits: { maxMessagesPerChannel: 1000, maxMessagesTotal: 10_000 },
    backupDir: "/tmp/snapback-backup-test",
    exportDir: "/tmp/snapback-export-test",
    authorize: async () => true,
    audit: async () => {},
    lookup: async (guildId, backupId) =>
      backups.find((row) => row.backup_id === backupId && row.guild_id === guildId) ?? null,
    lookupAll: async (guildId) => backups.filter((row) => row.guild_id === guildId),
    ...overrides,
  };
}

function walk(node: unknown, visit: (n: { customID?: string }) => void): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { customID?: string; components?: unknown[] };
  visit(record);
  if (Array.isArray(record.components)) for (const child of record.components) walk(child, visit);
}

describe("the /backup command group", () => {
  test("every documented subcommand is registered, once", () => {
    const commands = backupCommands(fakeDeps());
    const names = commands.map((command) => command.subcommand).sort();
    expect(names).toEqual(["create", "delete", "export", "info", "list", "prune"]);
    for (const command of commands) {
      expect(command.group).toBe("backup");
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test("the option that names a backup is marked for autocomplete", () => {
    const commands = backupCommands(fakeDeps());
    const info = commands.find((command) => command.subcommand === "info");
    const option = info?.options?.find((entry) => entry.name === "backup");
    expect(option?.autocomplete).toBe(true);
  });

  test("every page the group renders stays inside the component budget", async () => {
    const deps = fakeDeps();
    const commands = backupCommands(deps);
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: USER,
        options: { backup: "0190a000-0000-7000-8000-000000000001", confirm: "nightly" },
      });
      expect(countComponents(result.page as ContainerComponent)).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  test("every id a page produces parses as a backup control", async () => {
    const deps = fakeDeps();
    const commands = backupCommands(deps);
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: USER,
        options: { backup: "0190a000-0000-7000-8000-000000000001", confirm: "nightly" },
      });
      const ids: string[] = [];
      walk(result.page, (node) => {
        if (typeof node.customID === "string") ids.push(node.customID);
      });
      for (const produced of ids) {
        const parsed = parseCustomId(produced);
        expect(parsed?.surface).toBe(BACKUP_SURFACE);
        expect(parsed?.guild).toBe(GUILD);
      }
    }
  });

  test("a person who is not an admin gets a refusal, not the data", async () => {
    const deps = fakeDeps({ authorize: async () => false });
    const commands = backupCommands(deps);
    const list = commands.find((command) => command.subcommand === "list");
    const result = await list?.run({ guildId: GUILD, userId: USER, options: {} });
    expect(result?.ephemeral).toBe(true);
    const text = JSON.stringify(result?.page);
    expect(text).toContain("snapback admins");
    expect(text).not.toContain("nightly");
  });

  test("a backup from another guild is not found", async () => {
    const deps = fakeDeps();
    const commands = backupCommands(deps);
    const info = commands.find((command) => command.subcommand === "info");
    const result = await info?.run({
      guildId: "999999999999999999",
      userId: USER,
      options: { backup: "0190a000-0000-7000-8000-000000000001" },
    });
    // the list page, not the backup: the id is not reachable from that guild.
    const text = JSON.stringify(result?.page);
    expect(text).not.toContain("nightly");
  });

  test("the delete command arms only when the typed value matches exactly", () => {
    expect(expectedConfirm(makeBackup())).toBe("nightly");
    expect(expectedConfirm(makeBackup({ label: null }))).toBe("0190a000");
  });
});

describe("the boot assertion", () => {
  test("every spec has a handler, and every handler has a spec", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerBackupHandlers(router, fakeDeps());

    const registered = router.registeredKeys();
    for (const spec of BACKUP_SPECS) {
      expect(registered).toContain(`${spec.surface}:${spec.action}`);
    }
    const backupKeys = registered.filter((key) => key.startsWith(`${BACKUP_SURFACE}:`));
    expect(backupKeys.sort()).toEqual(BACKUP_SPECS.map((s) => `${s.surface}:${s.action}`).sort());
  });

  test("a gap in the surface fails the boot", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerBackupHandlers(router, fakeDeps());
    expect(() =>
      router.assertComplete([...BACKUP_SPECS, { surface: BACKUP_SURFACE, action: "ghost" }]),
    ).toThrow();
  });
});

describe("the custom id builder", () => {
  test("the cursor slot is always written, so every id is six segments", () => {
    const withCursor = backupCustomId({
      guildId: GUILD,
      object: BACKUP_OBJECT.info,
      action: BACKUP_ACTION.delete,
      cursor: "abc",
    });
    const without = backupCustomId({
      guildId: GUILD,
      object: BACKUP_OBJECT.list,
      action: BACKUP_ACTION.page,
    });
    expect(withCursor.split(":")).toHaveLength(6);
    expect(without.split(":")).toHaveLength(6);
    expect(parseCustomId(withCursor)?.cursor).toBe("abc");
    expect(parseCustomId(without)?.cursor).toBe("");
  });
});
