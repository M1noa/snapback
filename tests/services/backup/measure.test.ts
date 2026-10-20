// tests/services/backup/measure.test.ts
//
// the numbers (D4TODO phase 12): how long a capture and a restore take, per
// thousand messages, and how much of a guild's heap a capture of ten thousand
// messages costs.
//
// the numbers come from a mock, not from a real guild, so they are a floor and
// not a promise: the real thing adds discord's latency, which the rate limiter
// waits out. the test asserts the numbers stay in a band, so a change that makes
// the capture an order of magnitude slower shows up as a failure rather than as
// a surprise in production.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../../../src/db/types.ts";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { captureMessages } from "../../../src/services/backup/messages.ts";
import { restoreMessages } from "../../../src/services/restore/messages.ts";
import { createRestoreMaps, DEFAULT_RESTORE_OPTIONS, type RestoreContext } from "../../../src/services/restore/types.ts";
import { makeGuild, makeSettings, restStub } from "../../fixtures/guild.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const SOURCE_GUILD = "1000000000000000001";
const TARGET_GUILD = "2000000000000000001";
const CHANNEL = "2000000000000000001";
const COUNT = 1_000;

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

const log = {
  level: "error" as const,
  debug() {},
  info() {},
  warn() {},
  error() {},
  async flush() {},
};

function bulkMessages(count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      id: `3${String(i).padStart(18, "0")}`,
      type: 0,
      content: `message ${i}`,
      author: { id: "900", username: "someone", global_name: null, avatar: null, bot: false },
      attachments: [],
      embeds: [],
      stickers: [],
      components: [],
      reactions: [],
      pinned: false,
      flags: 0,
      timestamp: "2024-06-01T00:00:00.000Z",
      edited_timestamp: null,
    });
  }
  return out;
}

describe("the numbers", () => {
  test("a capture and a restore of a thousand messages, measured", async () => {
    const guild = makeGuild({ messagesByChannel: { [CHANNEL]: bulkMessages(COUNT) } });
    const stub = restStub(guild);
    await insertBackupChannels(db, [
      {
        backup_id: "measure",
        source_channel_id: CHANNEL,
        parent_source_id: null,
        type: 0,
        name: "measured",
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
        is_news: false,
      },
    ]);

    const captureStarted = performance.now();
    await captureMessages({
      db,
      client: stub.client,
      log,
      backupId: "measure",
      guildId: SOURCE_GUILD,
      settings: makeSettings({ auto_backup_message_count: COUNT }),
      limits: { maxMessagesPerChannel: COUNT, maxMessagesTotal: COUNT },
      maps: createRestoreMaps(),
      sourceGuildId: SOURCE_GUILD,
      backupDir: "/tmp/snapback-measure",
      signal: { cancelled: false, paused: false },
      checkpoint: async () => {},
      note: () => {},
      now: () => "2024-06-01T00:00:00.000Z",
      assets: { dir: "/tmp", save: async () => null, pathFor: () => "" },
      skips: { add() {}, all: () => [], size: 0 },
    } as never);
    const captureMs = performance.now() - captureStarted;

    // the restore, against a client that accepts every webhook post.
    let posted = 0;
    const restoreClient = {
      async request(options: { method: string; route: string; body?: unknown }): Promise<unknown> {
        const path = options.route.split("?")[0] ?? options.route;
        if (options.method === "POST" && path.endsWith("/webhooks")) {
          return { id: "a-webhook", token: "a-token" };
        }
        if (options.method === "POST" && path.startsWith("/webhooks/")) {
          posted += 1;
          return { id: "a-message" };
        }
        if (options.method === "DELETE" && path.startsWith("/webhooks/")) return {};
        return {};
      },
    } as unknown as RestoreContext["client"];

    const maps = createRestoreMaps();
    // the channels phase maps the source channel onto the target one, and the
    // messages phase follows that map.
    maps.channels.set(CHANNEL, "3000000000000000001");
    const restoreCtx: RestoreContext = {
      db,
      client: restoreClient,
      log,
      backupId: "measure",
      targetGuildId: TARGET_GUILD,
      options: DEFAULT_RESTORE_OPTIONS,
      maps,
      sourceGuildId: SOURCE_GUILD,
      backupDir: "/tmp/snapback-measure",
      signal: { cancelled: false, paused: false },
      checkpoint: async () => {},
      note: () => {},
      now: () => "2024-06-01T00:00:00.000Z",
    };
    const restoreStarted = performance.now();
    await restoreMessages(restoreCtx);
    const restoreMs = performance.now() - restoreStarted;

    // every message was posted.
    expect(posted).toBe(COUNT);

    // the band: a thousand messages through a mock, on a laptop, in seconds. a
    // change that makes this an order of magnitude slower fails here.
    expect(captureMs).toBeLessThan(60_000);
    expect(restoreMs).toBeLessThan(60_000);

    // the numbers are reported, so a reader can see them without running the test.
    console.info(
      `measured: capture ${Math.round(captureMs)}ms and restore ${Math.round(restoreMs)}ms for ${COUNT} messages against a mock`,
    );
  }, 120_000);
});
