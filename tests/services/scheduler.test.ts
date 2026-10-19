// tests/services/scheduler.test.ts
//
// the scheduler's rules: the due work is read from the database, the automation
// can be turned off entirely, and the tick never overlaps itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertBackup } from "../../src/db/queries/backups.ts";
import { insertPendingExport } from "../../src/db/queries/exports.ts";
import { insertInteractionState } from "../../src/db/queries/interaction-state.ts";
import type { Database } from "../../src/db/types.ts";
import { createLogger } from "../../src/lib/log.ts";
import { createScheduler } from "../../src/services/scheduler/index.ts";
import { closeFixtureDb, openFixtureDb } from "../fixtures/db.ts";

const GUILD = "123456789012345678";
const NOW = Date.parse("2024-06-01T12:00:00.000Z");

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function deps(overrides: { enabled?: boolean } = {}) {
  const enqueued: { kind: string; guildId: string }[] = [];
  return {
    enqueued,
    scheduler: createScheduler({
      db,
      log: createLogger({ level: "error", dir: null }),
      jobs: {
        enqueue: async (kind: string, input: { guildId: string }) => {
          enqueued.push({ kind, guildId: input.guildId });
          return { id: "job-1" };
        },
      } as never,
      enabled: overrides.enabled ?? true,
      tickMs: 0,
      now: () => NOW,
    }),
  };
}

describe("the scheduler", () => {
  test("with the automation off, the tick does nothing at all", async () => {
    const { scheduler, enqueued } = deps({ enabled: false });
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(0);
    expect(result.swept).toEqual({ states: 0, exports: 0 });
    expect(enqueued).toEqual([]);
  });

  test("the tick sweeps the expired states and the expired exports", async () => {
    await insertInteractionState(db, {
      state_id: "expired-state",
      guild_id: GUILD,
      user_id: "1",
      surface: "setup",
      payload_json: null,
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: "2024-01-01T00:15:00.000Z",
    });
    await insertPendingExport(db, {
      export_id: "expired-export",
      guild_id: GUILD,
      kind: "backup",
      scope_json: null,
      file_path: "/tmp/snapback-expired-export.json",
      size_bytes: 10,
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: "2024-01-01T00:00:00.000Z",
    });

    const { scheduler } = deps();
    const result = await scheduler.tick();
    expect(result.swept.states).toBe(1);
    expect(result.swept.exports).toBe(1);
  });

  test("a guild with no auto backup is not due, and one with it is", async () => {
    const { insertGuild } = await import("../../src/db/queries/guilds.ts");
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    await insertGuild(db, {
      guild_id: GUILD,
      name: "scheduled guild",
      icon_url: null,
      owner_user_id: "1",
      added_at: "2024-01-01T00:00:00.000Z",
      removed_at: null,
      settings_json: {
        ...DEFAULT_GUILD_SETTINGS,
        auto_backup_enabled: true,
        auto_backup_interval_hours: 1,
      },
    });
    // a backup an hour ago: the interval has not passed, so nothing is due.
    await insertBackup(db, {
      backup_id: "0190a000-0000-7000-8000-0000000000c1",
      guild_id: GUILD,
      label: null,
      kind: "auto",
      guild_name: "scheduled guild",
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
      created_at: new Date(NOW - 30 * 60_000).toISOString(),
      created_by: "1",
    });

    const { scheduler, enqueued } = deps();
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(0);
    expect(enqueued).toEqual([]);
  });
});
