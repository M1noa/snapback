// tests/services/backup/messages.test.ts
//
// the message-history capture (D4PLAN 11.5). the module reads its channel list
// from backup_channels, so every test seeds the captured channels first and, when
// a nickname matters, the members. assertions are behavioural: the row that
// landed, the route requested, the skip recorded, the count returned.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertBackupChannels } from "../../../src/db/queries/backup-channels.ts";
import { insertBackupMembers } from "../../../src/db/queries/backup-members.ts";
import { listBackupMessagesByBackup } from "../../../src/db/queries/backup-messages.ts";
import type {
  BackupChannelRow,
  BackupMemberRow,
  BackupMessageRow,
  Database,
} from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureMessages } from "../../../src/services/backup/messages.ts";
import type { AssetStore, BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_GENERAL,
  CHANNEL_MEMES,
  type FixtureGuild,
  makeContext,
  makeGuild,
  makeSettings,
  type RestStub,
  restStub,
  USER_BOT,
  USER_NICK,
  USER_PENDING,
} from "../../fixtures/guild.ts";

const T0 = "2024-01-01T00:00:00.000Z";
const WEBHOOK_ID = "1000000000000000300";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// 19 digits, so an id sorts as a string and none is a safe integer.
function bigId(n: number): string {
  return `9${String(n).padStart(18, "0")}`;
}

function backupId(): string {
  return Bun.randomUUIDv7();
}

type CtxOptions = Parameters<typeof makeContext>[0];

// a context whose client is a stub we hold, so the test can read routes()/calls().
function context(options: CtxOptions): { ctx: BackupContext; stub: RestStub } {
  const stub = restStub(options.guild);
  const ctx: BackupContext = { ...makeContext(options), client: stub.client };
  return { ctx, stub };
}

function channelRow(
  id: string,
  sourceChannelId: string,
  type: number,
  position: number,
): BackupChannelRow {
  return {
    backup_id: id,
    source_channel_id: sourceChannelId,
    parent_source_id: null,
    type,
    name: null,
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
}

function memberRow(id: string, userId: string, nickname: string | null): BackupMemberRow {
  return {
    backup_id: id,
    user_id: userId,
    username: "user",
    global_name: null,
    discriminator: null,
    nickname,
    avatar_url: null,
    joined_at: null,
    is_bot: false,
    role_ids_json: [],
    pending: false,
    timed_out_until: null,
    premium_since: null,
    flags: null,
    source_role_names_json: [],
  };
}

// a raw message payload, the shape the endpoint returns. discord sends newest
// first, so callers build their arrays in descending id order.
function rawMessage(
  messageId: string,
  type: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: messageId,
    type,
    content: "",
    channel_id: CHANNEL_GENERAL,
    author: user(USER_NICK, "nickname"),
    attachments: [],
    embeds: [],
    sticker_items: [],
    components: [],
    reactions: [],
    pinned: false,
    flags: 0,
    timestamp: T0,
    edited_timestamp: null,
    ...overrides,
  };
}

function user(userId: string, username: string): Record<string, unknown> {
  return { id: userId, username, global_name: null, avatar: null, bot: false };
}

function messagesIn(guild: FixtureGuild, channelId: string): Record<string, unknown>[] {
  return guild.messagesByChannel[channelId] ?? [];
}

function seedGeneralDb(id: string): Promise<void> {
  return insertBackupChannels(db, [channelRow(id, CHANNEL_GENERAL, 0, 0)]);
}

function findRow(rows: BackupMessageRow[], messageId: string): BackupMessageRow | undefined {
  return rows.find((row) => row.message_id === messageId);
}

describe("captureMessages", () => {
  test("stores the fixture's messages and reports the count it wrote", async () => {
    const id = backupId();
    const guild = makeGuild();
    await seedGeneralDb(id);
    const { ctx } = context({ db, guild, backupId: id });

    const result = await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const types = new Set(makeSettings().backup_message_types);
    const expected = messagesIn(guild, CHANNEL_GENERAL).filter((m) =>
      types.has(Number(m.type)),
    ).length;

    expect(result.written).toBe(rows.length);
    expect(result.counts?.messages).toBe(rows.length);
    expect(rows.length).toBe(expected);
  });

  test("the first request is limit=min(100, remaining) with no before", async () => {
    const id = backupId();
    const guild = makeGuild();
    await seedGeneralDb(id);
    const { ctx, stub } = context({ db, guild, backupId: id });

    await captureMessages(ctx);

    expect(stub.calls()[0]?.method).toBe("GET");
    expect(stub.calls()[0]?.route).toBe(`/channels/${CHANNEL_GENERAL}/messages?limit=100`);
  });

  test("the cursor advances: the second page carries before=<oldest of the first>", async () => {
    const id = backupId();
    const many = Array.from({ length: 150 }, (_, i) =>
      rawMessage(bigId(150 - i), 0, { content: `m${150 - i}` }),
    );
    const guild = makeGuild({ messagesByChannel: { [CHANNEL_GENERAL]: many } });
    await seedGeneralDb(id);
    const settings = makeSettings({ auto_backup_message_count: 150 });
    const { ctx, stub } = context({ db, guild, backupId: id, settings });

    const result = await captureMessages(ctx);

    const oldestOfFirst = bigId(51); // index 99 of 150, the 100th newest
    const calls = stub.calls().filter((call) => call.route.includes("/messages"));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.route).toBe(`/channels/${CHANNEL_GENERAL}/messages?limit=100`);
    expect(calls[1]?.route).toBe(
      `/channels/${CHANNEL_GENERAL}/messages?limit=50&before=${oldestOfFirst}`,
    );
    // two distinct pages, never the same one twice.
    expect(new Set(calls.map((call) => call.route)).size).toBe(2);
    expect(result.written).toBe(150);
  });

  test("the per-channel cap stops at the setting and asks only for what is left", async () => {
    const id = backupId();
    const guild = makeGuild();
    await seedGeneralDb(id);
    const settings = makeSettings({ auto_backup_message_count: 2 });
    const { ctx, stub } = context({ db, guild, backupId: id, settings });

    const result = await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const calls = stub.calls().filter((call) => call.route.includes("/messages"));
    expect(rows).toHaveLength(2);
    expect(result.written).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe(`/channels/${CHANNEL_GENERAL}/messages?limit=2`);
  });

  test("the global cap stores exactly the total and stops", async () => {
    const id = backupId();
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [rawMessage(bigId(4), 0, { content: "a" }), rawMessage(bigId(3), 0)],
        [CHANNEL_MEMES]: [rawMessage(bigId(6), 0, { content: "c" }), rawMessage(bigId(5), 0)],
      },
    });
    await insertBackupChannels(db, [
      channelRow(id, CHANNEL_GENERAL, 0, 0),
      channelRow(id, CHANNEL_MEMES, 0, 1),
    ]);
    const { ctx, stub } = context({
      db,
      guild,
      backupId: id,
      settings: makeSettings({ backup_max_messages_total: 3 }),
    });

    const result = await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const calls = stub.calls().filter((call) => call.route.includes("/messages"));
    expect(rows).toHaveLength(3);
    expect(result.written).toBe(3);
    expect(rows.filter((row) => row.channel_source_id === CHANNEL_GENERAL)).toHaveLength(2);
    expect(rows.filter((row) => row.channel_source_id === CHANNEL_MEMES)).toHaveLength(1);
    // one request per channel, the second asking for the single allowance left.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.route).toBe(`/channels/${CHANNEL_MEMES}/messages?limit=1`);
  });

  test("a filtered type is not stored and records no skip, a reply keeps its reference", async () => {
    const id = backupId();
    const guild = makeGuild();
    await seedGeneralDb(id);
    const { ctx } = context({ db, guild, backupId: id });

    await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const replyRaw = messagesIn(guild, CHANNEL_GENERAL).find((m) => m.type === 19);
    const joinRaw = messagesIn(guild, CHANNEL_GENERAL).find((m) => m.type === 7);
    if (replyRaw === undefined || joinRaw === undefined) throw new Error("fixture drift");

    expect(findRow(rows, String(joinRaw.id))).toBeUndefined();
    const reply = findRow(rows, String(replyRaw.id));
    expect(reply?.type).toBe(19);
    expect(reply?.reference_json).toEqual(replyRaw.message_reference as Record<string, unknown>);
    // the filter is deliberate, so nothing was skipped.
    expect(ctx.skips.all()).toHaveLength(0);
  });

  test("a reply whose parent is not in the fixture still stores its reference", async () => {
    const id = backupId();
    const parent = "1000000000000000999";
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [
          rawMessage(bigId(80), 19, {
            content: "a reply",
            message_reference: { message_id: parent, channel_id: CHANNEL_GENERAL },
          }),
        ],
      },
    });
    await seedGeneralDb(id);
    const { ctx } = context({ db, guild, backupId: id });

    await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const row = findRow(rows, bigId(80));
    expect(row?.reference_json).toEqual({ message_id: parent, channel_id: CHANNEL_GENERAL });
    expect(ctx.skips.all()).toHaveLength(0);
  });

  test("a message with empty content and two reactions is stored with both", async () => {
    const id = backupId();
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [
          rawMessage(bigId(80), 0, {
            content: "",
            reactions: [
              { emoji: { id: null, name: "\u{1F44D}" }, count: 2 },
              { emoji: { id: "1000000000000000060", name: "party" }, count: 1 },
            ],
          }),
        ],
      },
    });
    await seedGeneralDb(id);
    const { ctx } = context({ db, guild, backupId: id });

    await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const row = findRow(rows, bigId(80));
    expect(row?.content).toBe("");
    expect(row?.reactions_json).toHaveLength(2);
  });

  test("an accepted attachment stores the path, a refused one keeps the url and skips", async () => {
    const acceptedId = backupId();
    const guild = makeGuild();
    await seedGeneralDb(acceptedId);
    const accepted = context({ db, guild, backupId: acceptedId });

    const attachmentRaw = messagesIn(guild, CHANNEL_GENERAL).find(
      (m) => Array.isArray(m.attachments) && (m.attachments as unknown[]).length > 0,
    );
    if (attachmentRaw === undefined) throw new Error("fixture drift");
    const attachment = (attachmentRaw.attachments as Record<string, unknown>[])[0];

    await captureMessages(accepted.ctx);
    const acceptedRows = await listBackupMessagesByBackup(db, acceptedId);
    const acceptedRow = findRow(acceptedRows, String(attachmentRaw.id));
    const stored = (acceptedRow?.attachments_json ?? [])[0];
    expect(stored?.path).toBe("assets/attachment/shot.png");
    expect(stored?.url).toBe(attachment?.url);
    expect(accepted.ctx.skips.all()).toHaveLength(0);

    // a store that refuses everything: url kept, no path, exactly one skip.
    const refusedId = backupId();
    const refusedGuild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [
          rawMessage(bigId(80), 0, {
            attachments: [
              {
                id: bigId(99),
                filename: "shot.png",
                size: 4096,
                content_type: "image/png",
                url: `https://cdn.discordapp.com/attachments/${CHANNEL_GENERAL}/shot.png`,
              },
            ],
          }),
        ],
      },
    });
    await seedGeneralDb(refusedId);
    const refusing: AssetStore = {
      dir: "/tmp/snapback-refusing-assets",
      save: async () => null,
      pathFor: (kind, name) => `assets/${kind}/${name}`,
    };
    const refused = context({ db, guild: refusedGuild, backupId: refusedId, assets: refusing });

    await captureMessages(refused.ctx);
    const refusedRows = await listBackupMessagesByBackup(db, refusedId);
    const refusedRow = findRow(refusedRows, bigId(80));
    const refusedAttachment = (refusedRow?.attachments_json ?? [])[0];
    expect(refusedAttachment?.path).toBeNull();
    expect(refusedAttachment?.url).toBe(
      `https://cdn.discordapp.com/attachments/${CHANNEL_GENERAL}/shot.png`,
    );
    const skips = refused.ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.why).toBe("over the size ceiling or the url had already expired");
    // its own category, so the preservation rate is countable from the skips.
    expect(skips[0]?.category).toBe("attachments");
  });

  test("author_nickname comes from the captured member row, null when there is none", async () => {
    const id = backupId();
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [
          rawMessage(bigId(80), 0, { content: "from nick", author: user(USER_NICK, "nickname") }),
          rawMessage(bigId(79), 0, {
            content: "from other",
            author: user(USER_PENDING, "pending"),
          }),
        ],
      },
    });
    await seedGeneralDb(id);
    await insertBackupMembers(db, [memberRow(id, USER_NICK, "nick in this guild")]);
    const { ctx } = context({ db, guild, backupId: id });

    await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    expect(findRow(rows, bigId(80))?.author_nickname).toBe("nick in this guild");
    expect(findRow(rows, bigId(79))?.author_nickname).toBeNull();
  });

  test("a webhook author stores its webhook id and no nickname", async () => {
    const id = backupId();
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [
          rawMessage(bigId(80), 0, {
            content: "webhook post",
            webhook_id: WEBHOOK_ID,
            author: { id: USER_BOT, username: "hook", global_name: null, avatar: null, bot: true },
          }),
        ],
      },
    });
    await seedGeneralDb(id);
    const { ctx } = context({ db, guild, backupId: id });

    await captureMessages(ctx);

    const rows = await listBackupMessagesByBackup(db, id);
    const row = findRow(rows, bigId(80));
    expect(row?.author_webhook_id).toBe(WEBHOOK_ID);
    expect(row?.author_nickname).toBeNull();
  });

  test("the include gate writes nothing, makes no request, and records one skip", async () => {
    const id = backupId();
    const guild = makeGuild();
    await seedGeneralDb(id);
    const base = makeSettings();
    const settings = makeSettings({
      backup_include: { ...base.backup_include, messages: false },
    });
    const { ctx, stub } = context({ db, guild, backupId: id, settings });

    const result = await captureMessages(ctx);

    expect(result.written).toBe(0);
    expect(result.counts).toBeUndefined();
    expect(stub.calls()).toHaveLength(0);
    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("messages");
    expect(skips[0]?.why).toBe("messages are turned off in /setup backup");
    expect(await listBackupMessagesByBackup(db, id)).toHaveLength(0);
  });

  test("a 403 on one channel is one skip and the other channel still captures", async () => {
    const id = backupId();
    const guild = makeGuild({
      messagesByChannel: {
        [CHANNEL_GENERAL]: [rawMessage(bigId(4), 0, { content: "g" })],
        [CHANNEL_MEMES]: [rawMessage(bigId(6), 0, { content: "m" })],
      },
    });
    await insertBackupChannels(db, [
      channelRow(id, CHANNEL_GENERAL, 0, 0),
      channelRow(id, CHANNEL_MEMES, 0, 1),
    ]);
    const { ctx, stub } = context({ db, guild, backupId: id });

    stub.fail(
      `GET /channels/${CHANNEL_GENERAL}/messages`,
      new DiscordApiError({
        status: 403,
        route: `/channels/${CHANNEL_GENERAL}/messages`,
        method: "GET",
        body: JSON.stringify({ code: 50001, message: "Missing Access" }),
      }),
    );

    const result = await captureMessages(ctx);

    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("messages");
    expect(skips[0]?.what).toBe(`history in channel ${CHANNEL_GENERAL}`);
    expect(skips[0]?.why).toBe("50001 Missing Access");

    const rows = await listBackupMessagesByBackup(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel_source_id).toBe(CHANNEL_MEMES);
    expect(result.written).toBe(1);
  });
});
