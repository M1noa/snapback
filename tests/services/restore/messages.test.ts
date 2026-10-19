// tests/services/restore/messages.test.ts
//
// the webhook replay (D4PLAN 12.6). the assertions are about the requests the
// phase made, the order it made them in, and what it said about what a
// restore cannot do: a webhook stamps its own time, it impersonates the
// author, and a reply cannot be rethreaded.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { insertBackupMessages } from "../../../src/db/queries/backup-messages.ts";
import type { BackupChannelRow, BackupMessageRow, Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { restoreMessages } from "../../../src/services/restore/messages.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
  type RestoreNote,
  type RestoreOptions,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const SOURCE_GUILD_ID = "1000000000000000001";
const TARGET_GUILD_ID = "1000000000000000002";
// the source channels and the target ids they were restored to.
const CHANNEL_ONE = "1000000000000000010";
const CHANNEL_TWO = "1000000000000000011";
const CHANNEL_EMPTY = "1000000000000000012";
const TARGET_ONE = "2000000000000000010";
const TARGET_TWO = "2000000000000000011";
const TARGET_EMPTY = "2000000000000000012";
// 2024-01-01T00:00:00.000Z, the second the fixture messages start.
const BASE_MS = 1_704_067_200_000;

let db: Database;
const dirs: string[] = [];

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapback-restore-messages-"));
  dirs.push(dir);
  return dir;
}

function channelRow(backupId: string, sourceId: string, name: string, position: number) {
  const row: BackupChannelRow = {
    backup_id: backupId,
    source_channel_id: sourceId,
    parent_source_id: null,
    type: 0,
    name,
    position,
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
  return row;
}

function messageRow(
  backupId: string,
  channelId: string,
  index: number,
  overrides: Partial<BackupMessageRow> = {},
): BackupMessageRow {
  return {
    backup_id: backupId,
    channel_source_id: channelId,
    message_id: `9${String(index).padStart(18, "0")}`,
    author_id: "1000000000000000040",
    author_username: "nickname",
    author_global_name: null,
    author_nickname: null,
    author_avatar_url: null,
    author_is_bot: false,
    author_webhook_id: null,
    content: `message ${index}`,
    embeds_json: null,
    attachments_json: null,
    stickers_json: null,
    components_json: null,
    reactions_json: null,
    reference_json: null,
    thread_source_id: null,
    flags: null,
    pinned: false,
    type: 0,
    created_at: new Date(BASE_MS + index * 1000).toISOString(),
    edited_at: null,
    ...overrides,
  };
}

interface Recorded {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
}

interface Recorder {
  readonly client: DiscordClient;
  readonly calls: Recorded[];
  /** the ids the webhook creates handed back, in order. */
  readonly webhookIds: string[];
}

function recorder(options: { fail?: (method: string, route: string) => unknown } = {}): Recorder {
  const calls: Recorded[] = [];
  const webhookIds: string[] = [];
  const client = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push({ method: opts.method, route: opts.route, body: opts.body });
      const failure = options.fail?.(opts.method, opts.route);
      if (failure !== undefined) throw failure;
      if (opts.method === "POST" && opts.route.endsWith("/webhooks")) {
        webhookIds.push(`8${String(webhookIds.length + 1).padStart(18, "0")}`);
        return { id: webhookIds[webhookIds.length - 1], token: `token-${webhookIds.length}` } as T;
      }
      return {} as T;
    },
  } as unknown as DiscordClient;
  return { client, calls, webhookIds };
}

interface Harness {
  readonly ctx: RestoreContext;
  readonly notes: RestoreNote[];
  readonly checkpoints: { phase: string; done: number; total: number | null }[];
}

function harness(options: {
  backupId: string;
  client: DiscordClient;
  backupDir: string;
  restore?: Partial<RestoreOptions>;
}): Harness {
  const notes: RestoreNote[] = [];
  const checkpoints: { phase: string; done: number; total: number | null }[] = [];
  const maps = createRestoreMaps();
  maps.channels.set(CHANNEL_ONE, TARGET_ONE);
  maps.channels.set(CHANNEL_TWO, TARGET_TWO);
  maps.channels.set(CHANNEL_EMPTY, TARGET_EMPTY);

  const ctx: RestoreContext = {
    db,
    client: options.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: options.backupId,
    targetGuildId: TARGET_GUILD_ID,
    options: { ...DEFAULT_RESTORE_OPTIONS, ...options.restore },
    maps,
    sourceGuildId: SOURCE_GUILD_ID,
    backupDir: options.backupDir,
    signal: { cancelled: false, paused: false },
    checkpoint: async (phase, done, total) => {
      checkpoints.push({ phase, done, total });
    },
    note: (what, why) => {
      notes.push({ what, why });
    },
    now: () => "2024-01-01T00:00:00.000Z",
  };
  return { ctx, notes, checkpoints };
}

function posts(calls: Recorded[]): Recorded[] {
  return calls.filter(
    (call) =>
      call.method === "POST" &&
      call.route.includes("/webhooks/") &&
      !call.route.endsWith("/webhooks"),
  );
}

function bodies(calls: Recorded[]): Record<string, unknown>[] {
  return posts(calls).map((call) => call.body as Record<string, unknown>);
}

function noteText(notes: RestoreNote[], what: string): string {
  return notes
    .filter((note) => note.what === what)
    .map((note) => note.why)
    .join(" | ");
}

describe("restore messages", () => {
  test("creates one webhook per channel, posts oldest first, deletes the webhook", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [
      channelRow(backupId, CHANNEL_ONE, "general", 0),
      channelRow(backupId, CHANNEL_TWO, "memes", 1),
    ]);
    await insertBackupMessages(db, [
      messageRow(backupId, CHANNEL_ONE, 1, { content: "first" }),
      messageRow(backupId, CHANNEL_ONE, 2, { content: "second" }),
      messageRow(backupId, CHANNEL_TWO, 3, { content: "third" }),
    ]);

    const rec = recorder();
    const { ctx } = harness({ backupId, client: rec.client, backupDir: tempDir() });
    const result = await restoreMessages(ctx);

    expect(result.count).toBe(3);
    // one webhook per channel, and one delete per webhook.
    const creates = rec.calls.filter(
      (call) => call.method === "POST" && call.route.endsWith("/webhooks"),
    );
    expect(creates.map((call) => call.route).sort()).toEqual([
      `/channels/${TARGET_ONE}/webhooks`,
      `/channels/${TARGET_TWO}/webhooks`,
    ]);
    expect(creates[0]?.body).toEqual({ name: "Snapback" });

    const deletes = rec.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(2);
    // the delete names the webhook the create handed back.
    expect(deletes.map((call) => call.route).sort()).toEqual(
      rec.webhookIds.map((id) => `/webhooks/${id}`).sort(),
    );

    // the messages of a channel are posted oldest first.
    const first = bodies(rec.calls).filter((body) => body.content === "first");
    const second = bodies(rec.calls).filter((body) => body.content === "second");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const order = bodies(rec.calls).map((body) => body.content);
    expect(order.indexOf("first")).toBeLessThan(order.indexOf("second"));
  });

  test("posts a reply as a plain message and says the reply chains are not preserved", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [
      messageRow(backupId, CHANNEL_ONE, 1, { content: "the parent" }),
      messageRow(backupId, CHANNEL_ONE, 2, {
        content: "the reply",
        type: 19,
        reference_json: { message_id: "900000000000000000", channel_id: CHANNEL_ONE },
      }),
    ]);

    const rec = recorder();
    const { ctx, notes } = harness({ backupId, client: rec.client, backupDir: tempDir() });
    const result = await restoreMessages(ctx);

    expect(result.count).toBe(2);
    const reply = bodies(rec.calls).find((body) => body.content === "the reply");
    expect(reply).toBeDefined();
    // no reference is carried over: the target's id changed.
    expect(reply?.message_reference).toBeUndefined();
    expect(reply?.reference).toBeUndefined();

    // said once, not once per reply.
    const said = noteText(notes, "the reply chains");
    expect(said).toContain("rethread");
    expect(notes.filter((note) => note.what === "the reply chains")).toHaveLength(1);
  });

  test("appends the timestamp suffix only when the option is on", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [messageRow(backupId, CHANNEL_ONE, 1, { content: "hello" })]);

    const without = recorder();
    const plain = await restoreMessages(
      harness({ backupId, client: without.client, backupDir: tempDir() }).ctx,
    );
    expect(plain.count).toBe(1);
    expect(bodies(without.calls)[0]?.content).toBe("hello");

    const withSuffix = recorder();
    const suffixed = await restoreMessages(
      harness({
        backupId,
        client: withSuffix.client,
        backupDir: tempDir(),
        restore: { timestampSuffix: true },
      }).ctx,
    );
    expect(suffixed.count).toBe(1);
    expect(bodies(withSuffix.calls)[0]?.content).toBe("hello\n-# originally sent <t:1704067201:f>");
  });

  test("sends allowed_mentions with an empty parse list", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [messageRow(backupId, CHANNEL_ONE, 1)]);

    const rec = recorder();
    await restoreMessages(harness({ backupId, client: rec.client, backupDir: tempDir() }).ctx);

    expect(bodies(rec.calls)[0]?.allowed_mentions).toEqual({ parse: [] });
  });

  test("keeps the newest messages when the per-channel limit bites and notes the leftover", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [
      messageRow(backupId, CHANNEL_ONE, 1, { content: "oldest" }),
      messageRow(backupId, CHANNEL_ONE, 2, { content: "middle" }),
      messageRow(backupId, CHANNEL_ONE, 3, { content: "newest" }),
    ]);

    const rec = recorder();
    const { ctx, notes } = harness({
      backupId,
      client: rec.client,
      backupDir: tempDir(),
      restore: { messageLimit: 2 },
    });
    const result = await restoreMessages(ctx);

    expect(result.count).toBe(2);
    const content = bodies(rec.calls).map((body) => body.content);
    expect(content).toEqual(["middle", "newest"]);
    expect(noteText(notes, "the messages in general")).toContain("left out");
  });

  test("does not create a webhook for a channel with no messages", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [
      channelRow(backupId, CHANNEL_ONE, "general", 0),
      channelRow(backupId, CHANNEL_EMPTY, "empty", 1),
    ]);
    await insertBackupMessages(db, [messageRow(backupId, CHANNEL_ONE, 1)]);

    const rec = recorder();
    const { ctx } = harness({ backupId, client: rec.client, backupDir: tempDir() });
    await restoreMessages(ctx);

    const creates = rec.calls.filter(
      (call) => call.method === "POST" && call.route.endsWith("/webhooks"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.route).toBe(`/channels/${TARGET_ONE}/webhooks`);
  });

  test("the webhook is created with the guild icon as its avatar", async () => {
    const backupId = Bun.randomUUIDv7();
    const backupDir = tempDir();
    const guildDir = join(backupDir, backupId, "assets", "guild");
    mkdirSync(guildDir, { recursive: true });
    writeFileSync(join(guildDir, "icon.png"), "hello");

    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [messageRow(backupId, CHANNEL_ONE, 1)]);

    const rec = recorder();
    const { ctx } = harness({ backupId, client: rec.client, backupDir });
    await restoreMessages(ctx);

    const create = rec.calls.find(
      (call) => call.method === "POST" && call.route.endsWith("/webhooks"),
    );
    expect(create?.body).toEqual({
      name: "Snapback",
      avatar: "data:image/png;base64,aGVsbG8=",
    });
  });

  test("deletes the webhook even when a post fails", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [messageRow(backupId, CHANNEL_ONE, 1)]);

    const rec = recorder({
      fail: (method, route) =>
        method === "POST" && route.includes("/webhooks/") && !route.endsWith("/webhooks")
          ? new DiscordApiError({
              status: 400,
              route,
              method,
              body: JSON.stringify({ code: 50035, message: "Invalid Form Body" }),
            })
          : undefined,
    });
    const { ctx, notes } = harness({ backupId, client: rec.client, backupDir: tempDir() });
    const result = await restoreMessages(ctx);

    expect(result.count).toBe(0);
    const deletes = rec.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    // discord's own words, not a paraphrase.
    expect(noteText(notes, "the message 9000000000000000001 in general")).toContain("50035");
  });

  test("writes the checkpoint every 100 messages", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    const rows: BackupMessageRow[] = [];
    for (let index = 0; index < 250; index += 1)
      rows.push(messageRow(backupId, CHANNEL_ONE, index));
    await insertBackupMessages(db, rows);

    const rec = recorder();
    const { ctx, checkpoints } = harness({ backupId, client: rec.client, backupDir: tempDir() });
    const result = await restoreMessages(ctx);

    expect(result.count).toBe(250);
    expect(checkpoints.map((entry) => entry.done)).toEqual([100, 200]);
    expect(checkpoints.every((entry) => entry.phase === "messages")).toBe(true);
    expect(checkpoints[0]?.total).toBe(250);
  });

  test("re-uploads the attachments that are in the backup and reports the ones that are not", async () => {
    const backupId = Bun.randomUUIDv7();
    const backupDir = tempDir();
    const attachmentDir = join(backupDir, backupId, "assets", "attachment");
    mkdirSync(attachmentDir, { recursive: true });
    writeFileSync(join(attachmentDir, "shot.png"), "bytes");

    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [
      messageRow(backupId, CHANNEL_ONE, 1, {
        content: "with a file",
        attachments_json: [
          {
            url: "https://cdn.discordapp.com/attachments/1/2/shot.png",
            path: "assets/attachment/shot.png",
            size: 5,
            contentType: "image/png",
            filename: "shot.png",
          },
        ],
      }),
      messageRow(backupId, CHANNEL_ONE, 2, {
        content: "with a missing file",
        attachments_json: [
          { url: null, path: null, size: 5, contentType: "image/png", filename: "gone.png" },
        ],
      }),
    ]);

    const rec = recorder();
    const { ctx, notes } = harness({ backupId, client: rec.client, backupDir });
    const result = await restoreMessages(ctx);

    expect(result.count).toBe(2);
    const withFile = posts(rec.calls)[0];
    expect(withFile?.body instanceof FormData).toBe(true);
    const form = withFile?.body as FormData;
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    const payload = JSON.parse(String(form.get("payload_json"))) as Record<string, unknown>;
    expect(payload.attachments).toEqual([{ id: "0", filename: "shot.png" }]);

    const said = noteText(notes, "the attachments of the message 9000000000000000001 in general");
    expect(said).toContain("re-uploaded shot.png");
    const missed = noteText(notes, "the attachments of the message 9000000000000000002 in general");
    expect(missed).toContain("gone.png was not re-uploaded");
  });

  test("says plainly that the timestamps and the authors are not preserved", async () => {
    const backupId = Bun.randomUUIDv7();
    await insertBackupChannels(db, [channelRow(backupId, CHANNEL_ONE, "general", 0)]);
    await insertBackupMessages(db, [messageRow(backupId, CHANNEL_ONE, 1)]);

    const rec = recorder();
    const { ctx, notes } = harness({ backupId, client: rec.client, backupDir: tempDir() });
    await restoreMessages(ctx);

    expect(noteText(notes, "the original timestamps")).toContain("not preserved");
    expect(noteText(notes, "the message authors")).toContain("webhook");
    // every note the phase made was handed to the context too.
    expect(notes.length).toBeGreaterThan(0);
  });
});
