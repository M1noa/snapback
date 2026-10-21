// services/backup/messages.ts. D4PLAN 11 step 15 and 11.5: the message history,
// newest to oldest, under two ceilings.
//
// both ceilings are enforced here rather than trusted from a setting: the
// per-channel one is what the operator asked for, and the total one is the
// promise made to discord (parse-env.ts clamps it and refuses to raise it).

import { listBackupChannelsByBackup } from "../../db/queries/backup-channels.ts";
import { listBackupMembersByBackup } from "../../db/queries/backup-members.ts";
import { insertBackupMessages } from "../../db/queries/backup-messages.ts";
import { listBackupThreadsByBackup } from "../../db/queries/backup-threads.ts";
import type { BackupMessageRow, JsonObject } from "../../db/types.ts";
import type { BackupContext, Capture } from "./types.ts";
import { included, skipFor } from "./types.ts";

// the channel types whose history is a conversation: text, announcement, forum,
// media. threads are read from backup_threads and walked the same way.
const TEXT_CHANNEL_TYPES: readonly number[] = [0, 5, 15, 16];

// discord caps one page at 100; asking for more is a 50035.
const PAGE_LIMIT = 100;

interface RawAttachment {
  filename?: string;
  size?: number;
  content_type?: string;
  url?: string;
}

interface RawUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

interface RawMessage {
  id: string;
  type: number;
  content?: string | null;
  author?: RawUser;
  webhook_id?: string | null;
  embeds?: JsonObject[];
  attachments?: RawAttachment[];
  sticker_items?: JsonObject[];
  components?: JsonObject[];
  reactions?: JsonObject[];
  message_reference?: JsonObject;
  flags?: number;
  pinned?: boolean;
  timestamp?: string;
  edited_timestamp?: string | null;
}

interface StoredAttachment {
  url: string | null;
  path: string | null;
  size: number;
  contentType: string | null;
  filename: string;
}

// the channels worth walking: the captured text channels plus the captured
// threads, because a thread's messages are messages (11.5).
async function messageChannels(ctx: BackupContext): Promise<string[]> {
  const channels = await listBackupChannelsByBackup(ctx.db, ctx.backupId);
  const ids = channels
    .filter((channel) => TEXT_CHANNEL_TYPES.includes(channel.type))
    .map((channel) => channel.source_channel_id);
  const threads = await listBackupThreadsByBackup(ctx.db, ctx.backupId);
  return [...ids, ...threads.map((thread) => thread.source_thread_id)];
}

// the author's nickname in this guild, from the member list already captured. a
// webhook post has no member, so the lookup simply misses and stays null.
async function nicknames(ctx: BackupContext): Promise<Map<string, string>> {
  const members = await listBackupMembersByBackup(ctx.db, ctx.backupId);
  const names = new Map<string, string>();
  for (const member of members)
    if (member.nickname !== null) names.set(member.user_id, member.nickname);
  return names;
}

// a custom avatar is <hash>.<ext>, gif when the hash is animated. no avatar is
// null: the restore recomputes the default rather than storing a guess (11.4).
function authorAvatar(user: RawUser | undefined): string | null {
  const hash = user?.avatar;
  if (user === undefined || typeof hash !== "string" || hash === "") return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${hash}.${ext}`;
}

async function storeAttachment(ctx: BackupContext, raw: RawAttachment): Promise<StoredAttachment> {
  const url = typeof raw.url === "string" ? raw.url : null;
  const filename = raw.filename ?? "attachment";
  const size = typeof raw.size === "number" ? raw.size : 0;
  const contentType = raw.content_type ?? null;

  const stored = url === null ? null : await ctx.assets.save("attachment", filename, url);
  if (stored === null) {
    // over the ceiling, gone, or never fetchable. recorded as a skip so a restore
    // says "this attachment could not be preserved" instead of dropping it in
    // silence (11.1). this is a limitation, not an error.
    ctx.skips.add({
      category: "messages",
      what: `${filename} (${size} bytes)`,
      why:
        url === null
          ? "discord sent no url for this attachment"
          : "over the size ceiling or the url had already expired",
    });
  }

  return { url, path: stored?.path ?? null, size, contentType, filename };
}

async function toMessageRow(
  ctx: BackupContext,
  channelId: string,
  message: RawMessage,
  nicks: ReadonlyMap<string, string>,
): Promise<BackupMessageRow> {
  const author = message.author;
  const authorId = author?.id ?? "";
  const attachments: StoredAttachment[] = [];
  for (const raw of message.attachments ?? []) attachments.push(await storeAttachment(ctx, raw));

  return {
    backup_id: ctx.backupId,
    channel_source_id: channelId,
    message_id: message.id,
    author_id: authorId,
    author_username: author?.username ?? "",
    author_global_name: author?.global_name ?? null,
    author_nickname: nicks.get(authorId) ?? null,
    author_avatar_url: authorAvatar(author),
    author_is_bot: author?.bot === true,
    author_webhook_id: message.webhook_id ?? null,
    content: message.content ?? null,
    embeds_json: message.embeds ?? null,
    // an empty list is stored as null: nothing was there, which is not the same
    // as an attachment that failed to download.
    attachments_json: attachments.length === 0 ? null : (attachments as unknown as JsonObject[]),
    stickers_json: message.sticker_items ?? null,
    components_json: message.components ?? null,
    reactions_json: message.reactions ?? null,
    reference_json: message.message_reference ?? null,
    thread_source_id: null,
    flags: message.flags ?? null,
    pinned: message.pinned === true,
    type: message.type,
    created_at: message.timestamp ?? ctx.now(),
    edited_at: message.edited_timestamp ?? null,
  };
}

export const captureMessages: Capture = async (ctx) => {
  if (!included(ctx, "messages")) {
    ctx.skips.add({
      category: "messages",
      what: "all messages",
      why: "messages are turned off in /setup backup",
    });
    return { written: 0 };
  }

  const perChannel = Math.min(
    ctx.settings.auto_backup_message_count,
    ctx.settings.backup_max_messages_per_channel,
  );
  const total = ctx.settings.backup_max_messages_total;

  const types = new Set(ctx.settings.backup_message_types);
  const nicks = await nicknames(ctx);
  const channels = await messageChannels(ctx);

  // one counter for the whole capture, incremented in one place. counting inside a
  // parallel map is the race this shape avoids (D4TODO phase 5).
  let stored = 0;

  for (const channelId of channels) {
    let before: string | null = null;
    let inChannel = 0;

    while (inChannel < perChannel && stored < total) {
      const remaining = Math.min(perChannel - inChannel, total - stored, PAGE_LIMIT);
      const query =
        before === null
          ? `?limit=${remaining}`
          : `?limit=${remaining}&before=${encodeURIComponent(before)}`;
      const route = `/channels/${channelId}/messages${query}`;

      let page: RawMessage[];
      try {
        page = await ctx.client.request<RawMessage[]>({ method: "GET", route });
      } catch (error) {
        ctx.skips.add(skipFor("messages", `history in channel ${channelId}`, error));
        break;
      }

      // the type filter runs before anything is stored: a join or a boost was
      // filtered on purpose, so it is not a skip (11.5).
      const kept = (Array.isArray(page) ? page : []).filter((message) => types.has(message.type));

      const rows: BackupMessageRow[] = [];
      for (const message of kept) {
        if (stored >= total || inChannel >= perChannel) break;
        rows.push(await toMessageRow(ctx, channelId, message, nicks));
        stored += 1;
        inChannel += 1;
      }
      await insertBackupMessages(ctx.db, rows);

      // discord returns newest first, so the oldest id on the page is the cursor
      // for the next one. a short page means the channel is exhausted; a page of
      // filtered-out noise still advances the cursor, so no page is read twice.
      const oldest = page[page.length - 1];
      // the checkpoint is per page, so a capture that is interrupted says how far
      // it got rather than only which step it was in.
      await ctx.checkpoint("messages", { done: stored, total });
      if (oldest === undefined || page.length < remaining) break;
      before = oldest.id;
    }
  }

  return { written: stored, counts: { messages: stored } };
};
