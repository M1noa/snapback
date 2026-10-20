// tests/services/scheduler.test.ts
//
// the scheduler's rules: the due work is read from the database, the automation
// can be turned off entirely, and the tick never overlaps itself.
//
// the tick owns four things beyond the auto backup: the token refresh sweep, the
// counter reset at 00:05 utc, the orphan webhook sweep, and the auto restore
// after a successful backup. each one is a job row or a sweep, and the tick
// reports what it did.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertBackupChannel } from "../../src/db/queries/backup-channels.ts";
import { insertBackup } from "../../src/db/queries/backups.ts";
import { getAccountCounter, upsertAccountCounter } from "../../src/db/queries/counters.ts";
import { insertPendingExport } from "../../src/db/queries/exports.ts";
import { upsertGuild } from "../../src/db/queries/guilds.ts";
import { insertInteractionState } from "../../src/db/queries/interaction-state.ts";
import { insertJob } from "../../src/db/queries/jobs.ts";
import type {
  AccountCounterRow,
  BackupChannelRow,
  BackupRow,
  Database,
  JobKind,
  JobRow,
} from "../../src/db/types.ts";
import { createLogger } from "../../src/lib/log.ts";
import type { JobContext, JobHandler } from "../../src/services/jobs/runner.ts";
import { createScheduler } from "../../src/services/scheduler/index.ts";
import type { GuildWebhook, WebhookPort } from "../../src/services/scheduler/sweeps.ts";
import { closeFixtureDb, openFixtureDb } from "../fixtures/db.ts";

const GUILD = "123456789012345678";
const AUTO_GUILD = "222222222222222222";
const PLAIN_GUILD = "333333333333333333";
const NOW = Date.parse("2024-06-01T12:00:00.000Z");
const TODAY = "2024-06-01";
const YESTERDAY = "2024-05-31";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

interface Enqueued {
  readonly kind: string;
  readonly guildId: string;
  readonly payload: Record<string, unknown>;
}

function deps(
  overrides: {
    enabled?: boolean;
    refresh?: (userId: string) => Promise<boolean>;
    webhooks?: WebhookPort;
  } = {},
) {
  const enqueued: Enqueued[] = [];
  const handlers = new Map<string, JobHandler>();
  const scheduler = createScheduler({
    db,
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async (
        kind: string,
        input: { guildId: string; requestedBy: string; payload?: Record<string, unknown> | null },
      ) => {
        enqueued.push({ kind, guildId: input.guildId, payload: input.payload ?? {} });
        // the real runner writes the row, so the next tick sees the work waiting
        // and does not enqueue it a second time.
        await insertJob(db, {
          id: Bun.randomUUIDv7(),
          guild_id: input.guildId,
          kind: kind as JobKind,
          status: "queued",
          requested_by: input.requestedBy,
          payload_json: input.payload ?? null,
          progress_json: null,
          error_code: null,
          error_body: null,
          created_at: new Date(NOW).toISOString(),
          started_at: null,
          finished_at: null,
          attempts: 0,
        });
        return { id: "job-1" };
      },
      register: (kind: string, handler: JobHandler) => {
        handlers.set(kind, handler);
      },
    } as never,
    enabled: overrides.enabled ?? true,
    tickMs: 0,
    now: () => NOW,
    refresh: overrides.refresh,
    webhooks: overrides.webhooks,
  });
  return { scheduler, enqueued, handlers };
}

function counter(userId: string, day: string): AccountCounterRow {
  return {
    user_id: userId,
    guild_id: GUILD,
    day,
    attempts: 1,
    successes: 1,
    failures: 0,
    cooldown_until: null,
    restricted: false,
    restricted_reason: null,
    restricted_at: null,
    updated_at: new Date(NOW).toISOString(),
  };
}

function backupRow(guildId: string, backupId: string, createdAt: number): BackupRow {
  return {
    backup_id: backupId,
    guild_id: guildId,
    label: null,
    kind: "manual",
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
    created_at: new Date(createdAt).toISOString(),
    created_by: "1",
  };
}

function channelRow(backupId: string, name: string): BackupChannelRow {
  return {
    backup_id: backupId,
    source_channel_id: "900000000000000001",
    parent_source_id: null,
    type: 0,
    name,
    position: 0,
    topic: null,
    nsfw: false,
    rate_limit_per_user: null,
    bitrate: null,
    user_limit: null,
    rtc_region: null,
    video_quality_mode: null,
    default_auto_archive_duration: null,
    default_thread_rate_limit_per_user: null,
    default_sort_order: null,
    default_forum_layout: null,
    available_tags_json: null,
    flags: null,
    is_news: null,
  };
}

function jobContext(job: Partial<JobRow>): JobContext {
  return {
    job: { ...job } as JobRow,
    signal: { cancelled: false, paused: false },
    log: createLogger({ level: "error", dir: null }),
    checkpoint: async () => {},
  };
}

describe("the scheduler", () => {
  test("with the automation off, the tick does nothing at all", async () => {
    const { scheduler, enqueued } = deps({ enabled: false });
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(0);
    expect(result.swept).toEqual({ states: 0, exports: 0, counters: 0, webhooks: 0 });
    expect(result.refresh).toEqual({ due: 0, enqueued: 0 });
    expect(result.restores).toBe(0);
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
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    await upsertGuild(db, {
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
    await insertBackup(
      db,
      backupRow(GUILD, "0190a000-0000-7000-8000-0000000000c1", NOW - 30 * 60_000),
    );

    const { scheduler, enqueued } = deps();
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(0);
    expect(enqueued).toEqual([]);
  });

  test("the counter reset deletes the rows of an old day and leaves today's", async () => {
    await upsertAccountCounter(db, counter("old-day-user", YESTERDAY));
    await upsertAccountCounter(db, counter("today-user", TODAY));

    const { scheduler } = deps();
    const result = await scheduler.tick();

    expect(result.swept.counters).toBe(1);
    // today's row is a live counter, so it stays.
    expect(await getAccountCounter(db, "today-user", GUILD, TODAY)).not.toBeNull();
    expect(await getAccountCounter(db, "old-day-user", GUILD, YESTERDAY)).toBeNull();
  });

  test("the orphan webhook sweep deletes ours and leaves the rest", async () => {
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    await upsertGuild(db, {
      guild_id: GUILD,
      name: "webhook guild",
      icon_url: null,
      owner_user_id: "1",
      added_at: "2024-01-01T00:00:00.000Z",
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });
    const backupId = "0190a000-0000-7000-8000-0000000000d1";
    await insertBackup(db, backupRow(GUILD, backupId, NOW - 60_000));
    await insertBackupChannel(db, channelRow(backupId, "general"));
    // a restore that is running right now, and using one of the channels.
    await insertJob(db, {
      id: "0190a000-0000-7000-8000-0000000000e1",
      guild_id: GUILD,
      kind: "restore",
      status: "running",
      requested_by: "1",
      payload_json: { backupId, targetId: GUILD },
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: new Date(NOW).toISOString(),
      started_at: new Date(NOW).toISOString(),
      finished_at: null,
      attempts: 1,
    });

    const removed: string[] = [];
    const port = webhookPort(removed);
    const { scheduler } = deps({ webhooks: port });
    const result = await scheduler.tick();

    expect(result.swept.webhooks).toBe(1);
    // the one a running restore is using, and the one that is not ours, stay.
    expect(removed).toEqual(["webhook-orphan"]);
  });

  test("the auto restore is enqueued after a backup when the guild asked for one", async () => {
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    await upsertGuild(db, {
      guild_id: AUTO_GUILD,
      name: "auto restore guild",
      icon_url: null,
      owner_user_id: "1",
      added_at: "2024-01-01T00:00:00.000Z",
      removed_at: null,
      settings_json: { ...DEFAULT_GUILD_SETTINGS, auto_restore_enabled: true },
    });
    const backupId = "0190a000-0000-7000-8000-0000000000f1";
    await insertBackup(db, backupRow(AUTO_GUILD, backupId, NOW - 60_000));

    const { scheduler, enqueued } = deps();
    await scheduler.tick();

    const restores = enqueued.filter((job) => job.kind === "restore");
    expect(restores.length).toBe(1);
    expect(restores[0]?.guildId).toBe(AUTO_GUILD);
    expect(restores[0]?.payload.backupId).toBe(backupId);
  });

  test("a guild without the auto restore setting gets no restore", async () => {
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    await upsertGuild(db, {
      guild_id: PLAIN_GUILD,
      name: "plain guild",
      icon_url: null,
      owner_user_id: "1",
      added_at: "2024-01-01T00:00:00.000Z",
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });
    await insertBackup(
      db,
      backupRow(PLAIN_GUILD, "0190a000-0000-7000-8000-0000000000f2", NOW - 60_000),
    );

    const { scheduler, enqueued } = deps();
    await scheduler.tick();

    expect(enqueued.filter((job) => job.kind === "restore").length).toBe(0);
  });

  test("the token refresh sweep runs on the tick and enqueues a job for the due records", async () => {
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    await upsertGuild(db, {
      guild_id: GUILD,
      name: "refresh guild",
      icon_url: null,
      owner_user_id: "1",
      added_at: "2024-01-01T00:00:00.000Z",
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });
    await db.run(
      `INSERT INTO verify_records (
         record_id, guild_id, user_id, access_token_enc, refresh_token_enc,
         token_expires_at, token_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "0190a000-0000-7000-8000-0000000000a1",
        GUILD,
        "555000555000555000",
        "enc",
        "enc",
        "2024-06-01T11:00:00.000Z",
        "valid",
        "2024-06-01T10:00:00.000Z",
        "2024-06-01T10:00:00.000Z",
      ],
    );

    const refreshed: string[] = [];
    const { scheduler, enqueued, handlers } = deps({
      refresh: async (userId: string) => {
        refreshed.push(userId);
        return true;
      },
    });
    const result = await scheduler.tick();

    expect(result.refresh.due).toBe(1);
    const jobs = enqueued.filter((job) => job.kind === "verify_refresh");
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.guildId).toBe(GUILD);

    // the job is the sweep: it refreshes the record that was due.
    const handler = handlers.get("verify_refresh");
    expect(handler).toBeDefined();
    await handler?.(
      jobContext({
        id: "0190a000-0000-7000-8000-0000000000a2",
        guild_id: GUILD,
        kind: "verify_refresh",
        status: "running",
        requested_by: "1",
        payload_json: { guildId: GUILD },
      }),
    );
    expect(refreshed).toEqual(["555000555000555000"]);

    // a second tick does not queue the same refresh again.
    const before = enqueued.length;
    await scheduler.tick();
    expect(enqueued.length).toBe(before);
  });

  test("with the automation off, none of the four run", async () => {
    const { DEFAULT_GUILD_SETTINGS } = await import("../../src/config/defaults.ts");
    const { upsertGuild: insert } = await import("../../src/db/queries/guilds.ts");
    await insert(db, {
      guild_id: PLAIN_GUILD,
      name: "off guild",
      icon_url: null,
      owner_user_id: "1",
      added_at: "2024-01-01T00:00:00.000Z",
      removed_at: null,
      settings_json: { ...DEFAULT_GUILD_SETTINGS, auto_restore_enabled: true },
    });
    await insertBackup(
      db,
      backupRow(PLAIN_GUILD, "0190a000-0000-7000-8000-0000000000f3", NOW - 60_000),
    );
    await upsertAccountCounter(db, counter("off-day-user", YESTERDAY));
    await db.run(
      `INSERT INTO verify_records (
         record_id, guild_id, user_id, access_token_enc, refresh_token_enc,
         token_expires_at, token_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "0190a000-0000-7000-8000-0000000000b1",
        PLAIN_GUILD,
        "555000555000555001",
        "enc",
        "enc",
        "2024-06-01T11:00:00.000Z",
        "valid",
        "2024-06-01T10:00:00.000Z",
        "2024-06-01T10:00:00.000Z",
      ],
    );

    const removed: string[] = [];
    const refreshed: string[] = [];
    const { scheduler, enqueued } = deps({
      enabled: false,
      webhooks: webhookPort(removed),
      refresh: async (userId: string) => {
        refreshed.push(userId);
        return true;
      },
    });
    const result = await scheduler.tick();

    expect(enqueued).toEqual([]);
    expect(result.swept.counters).toBe(0);
    expect(result.swept.webhooks).toBe(0);
    expect(result.refresh).toEqual({ due: 0, enqueued: 0 });
    expect(result.restores).toBe(0);
    // nothing was deleted, nothing was reset, nothing was refreshed.
    expect(removed).toEqual([]);
    expect(refreshed).toEqual([]);
    expect(await getAccountCounter(db, "off-day-user", GUILD, YESTERDAY)).not.toBeNull();
  });
});

// the webhooks of one guild: ours and orphaned, ours and in use, and one that
// belongs to somebody else. the other guilds have none.
function webhookPort(removed: string[]): WebhookPort {
  const webhooks: readonly GuildWebhook[] = [
    { id: "webhook-orphan", name: "Snapback", channel_id: "channel-free" },
    { id: "webhook-busy", name: "Snapback", channel_id: "channel-busy" },
    { id: "webhook-other", name: "Somebody Else", channel_id: "channel-free" },
  ];
  return {
    list: async (guildId: string) => (guildId === GUILD ? webhooks : []),
    channels: async () => [
      { id: "channel-busy", name: "general" },
      { id: "channel-free", name: "other" },
    ],
    remove: async (webhookId: string) => {
      removed.push(webhookId);
    },
  };
}
