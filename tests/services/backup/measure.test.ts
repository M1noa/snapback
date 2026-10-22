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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { listBackupMessagesByBackup } from "../../../src/db/queries/backup-messages.ts";
import type { Database } from "../../../src/db/types.ts";
import { createAssetStore } from "../../../src/services/backup/assets.ts";
import { captureMessages } from "../../../src/services/backup/messages.ts";
import { createSkipList } from "../../../src/services/backup/types.ts";
import { restoreMessages } from "../../../src/services/restore/messages.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import { makeGuild, makeSettings, restStub } from "../../fixtures/guild.ts";

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
  verbose() {},
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

  // the fourth number (D4TODO phase 12). a real channel's rate depends on the age
  // of its urls, which a mock cannot have, so this measures the two halves that a
  // mock can hold: how many attachments the capture counts as preserved, and how
  // many of those the restore actually re-posts. the live rate then falls out of a
  // real backup's own `attachments` skips (docs/measurements.md).
  test("attachments: every one the capture kept is one the restore posts", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapback-measure-att-"));
    const BACKUP = "measure-attachments";
    const MESSAGES = 100;
    const everyMessageHas = 1;

    // one in two url is dead, which is the shape an expired cdn url takes: the
    // download throws, the store records a null, and the row keeps the url.
    const fetchImpl = async (url: string) => {
      if (url.includes("/dead/")) throw new Error("404");
      return { bytes: new Uint8Array(16), contentType: "image/png", size: 16 };
    };

    const messages: Record<string, unknown>[] = [];
    for (let i = MESSAGES - 1; i >= 0; i--) {
      const live = i % 2 === 0;
      messages.push({
        id: `3${String(i).padStart(18, "0")}`,
        type: 0,
        content: `message ${i}`,
        author: { id: "900", username: "someone", global_name: null, avatar: null, bot: false },
        attachments: [
          {
            id: `4${String(i).padStart(18, "0")}`,
            filename: `shot-${i}.png`,
            size: 16,
            content_type: "image/png",
            url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${live ? "live" : "dead"}/shot-${i}.png`,
          },
        ],
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

    const guild = makeGuild({ messagesByChannel: { [CHANNEL]: messages } });
    const stub = restStub(guild);
    await insertBackupChannels(db, [
      {
        backup_id: BACKUP,
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

    const skips = createSkipList();
    const assets = createAssetStore({
      dir: join(root, BACKUP),
      maxBytes: 1024,
      fetchImpl: fetchImpl as never,
    });
    await captureMessages({
      db,
      client: stub.client,
      log,
      backupId: BACKUP,
      guildId: SOURCE_GUILD,
      settings: makeSettings({ auto_backup_message_count: MESSAGES }),
      limits: { maxMessagesPerChannel: MESSAGES, maxMessagesTotal: MESSAGES },
      maps: createRestoreMaps(),
      sourceGuildId: SOURCE_GUILD,
      backupDir: root,
      signal: { cancelled: false, paused: false },
      checkpoint: async () => {},
      note: () => {},
      now: () => "2024-06-01T00:00:00.000Z",
      assets,
      skips,
    } as never);

    const rows = await listBackupMessagesByBackup(db, BACKUP);
    const kept = rows.filter((row) =>
      ((row.attachments_json ?? []) as { path?: string | null }[]).some((a) => a.path),
    );
    const lost = skips.all().filter((skip) => skip.category === "attachments");

    // the accounting is the number: every message had one attachment, and the skip
    // list names exactly the half whose url was dead.
    expect(rows).toHaveLength(MESSAGES);
    expect(lost).toHaveLength(MESSAGES * everyMessageHas - kept.length);
    expect(kept).toHaveLength(MESSAGES / 2);

    // the restore, against a client that records what the form carried.
    const posted: { files: number }[] = [];
    const restoreClient = {
      async request(options: { method: string; route: string; body?: unknown }): Promise<unknown> {
        const path = options.route.split("?")[0] ?? options.route;
        if (options.method === "POST" && path.endsWith("/webhooks")) {
          return { id: "a-webhook", token: "a-token" };
        }
        if (options.method === "POST" && path.startsWith("/webhooks/")) {
          // a message with files travels as multipart, so count the files[n] parts.
          const body = options.body;
          const files =
            body instanceof FormData
              ? [...body.keys()].filter((key) => key.startsWith("files[")).length
              : 0;
          posted.push({ files });
          return { id: "a-message" };
        }
        return {};
      },
    } as unknown as RestoreContext["client"];

    const maps = createRestoreMaps();
    maps.channels.set(CHANNEL, "3000000000000000001");
    await restoreMessages({
      db,
      client: restoreClient,
      log,
      backupId: BACKUP,
      targetGuildId: TARGET_GUILD,
      options: DEFAULT_RESTORE_OPTIONS,
      maps,
      sourceGuildId: SOURCE_GUILD,
      backupDir: root,
      signal: { cancelled: false, paused: false },
      checkpoint: async () => {},
      note: () => {},
      now: () => "2024-06-01T00:00:00.000Z",
    });

    // every message was posted, and exactly the kept attachments travelled with them.
    expect(posted).toHaveLength(MESSAGES);
    const files = posted.reduce((total, one) => total + one.files, 0);
    expect(files).toBe(kept.length);

    rmSync(root, { recursive: true, force: true });
  }, 120_000);
});
