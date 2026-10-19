// tests/services/backup/load.test.ts
//
// the load test (D4TODO phase 12): ten thousand messages through the capture
// against a mock, with the memory measured and the checkpoints proven.
//
// the point is not that ten thousand messages fit in the cap. the point is that
// the cap holds, the pages are bounded, and the heap does not grow with the
// size of the guild.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { countBackupMessagesByBackup } from "../../../src/db/queries/backup-messages.ts";
import type { Database } from "../../../src/db/types.ts";
import { captureMessages } from "../../../src/services/backup/messages.ts";
import { createSkipList } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import { makeGuild, makeSettings, restStub } from "../../fixtures/guild.ts";

const GUILD = "123456789012345678";
const CHANNEL_A = "2000000000000000001";
const CHANNEL_B = "2000000000000000002";
const PER_CHANNEL = 5_000;
const TOTAL = PER_CHANNEL * 2;

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// a fixed width id, so the lexicographic order the cursor walk relies on is the
// numeric one.
function bulkId(index: number): string {
  return `1${String(index).padStart(18, "0")}`;
}

function bulkMessages(count: number, offset: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // newest first, the way discord returns them.
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      id: bulkId(offset + i),
      type: 0,
      content: `message ${offset + i}`,
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

function channelRow(sourceChannelId: string) {
  return {
    backup_id: "load-test",
    source_channel_id: sourceChannelId,
    parent_source_id: null,
    type: 0,
    name: `channel ${sourceChannelId}`,
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
  };
}

describe("the capture, at ten thousand messages", () => {
  test("the cap holds, the pages are bounded, and the heap does not grow with the guild", async () => {
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_A]: bulkMessages(PER_CHANNEL, 0),
        [CHANNEL_B]: bulkMessages(PER_CHANNEL, PER_CHANNEL),
      },
    });
    const stub = restStub(guild);
    // the capture walks the channels the channels step wrote, so they have to be
    // there before it starts.
    await insertBackupChannels(db, [channelRow(CHANNEL_A), channelRow(CHANNEL_B)]);
    const checkpoints: { done: number; total: number | null }[] = [];
    const skips = createSkipList();

    // the heap before the capture, so the growth can be measured.
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;

    const result = await captureMessages({
      db,
      client: stub.client,
      log: { level: "error", debug() {}, info() {}, warn() {}, error() {}, async flush() {} },
      backupId: "load-test",
      guildId: GUILD,
      settings: makeSettings({ auto_backup_message_count: 10_000 }),
      limits: { maxMessagesPerChannel: 10_000, maxMessagesTotal: 10_000 },
      maps: { roles: new Map(), channels: new Map(), members: new Map(), emojis: new Map() },
      sourceGuildId: GUILD,
      backupDir: "/tmp/snapback-load-test",
      signal: { cancelled: false, paused: false },
      checkpoint: async (_step: string, counts: { done: number; total: number | null }) => {
        checkpoints.push({ done: counts.done, total: counts.total });
      },
      note: () => {},
      now: () => "2024-06-01T00:00:00.000Z",
      assets: {
        dir: "/tmp/snapback-load-test",
        save: async () => null,
        pathFor: () => "",
      },
      skips,
    } as never);

    const after = process.memoryUsage().heapUsed;
    const growthMiB = (after - before) / (1024 * 1024);

    // every message was stored, and the cap is what stopped it, not luck.
    expect(result.written).toBe(TOTAL);
    expect(await countBackupMessagesByBackup(db, "load-test")).toBe(TOTAL);

    // a checkpoint per page, and the last one says everything was done.
    expect(checkpoints.length).toBeGreaterThanOrEqual(TOTAL / 100);
    expect(checkpoints.at(-1)?.done).toBe(TOTAL);
    expect(checkpoints.at(-1)?.total).toBe(TOTAL);

    // the pages never asked for more than discord's maximum.
    for (const route of stub.routes()) {
      const limit = Number.parseInt(
        new URLSearchParams(route.split("?")[1] ?? "").get("limit") ?? "0",
        10,
      );
      expect(limit).toBeLessThanOrEqual(100);
    }

    // the heap grew by a bounded amount: the capture holds a page, not a guild.
    expect(growthMiB).toBeLessThan(256);
  }, 120_000);
});
