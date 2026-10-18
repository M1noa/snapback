// services/backup/channels.ts. D4PLAN 11 steps 7 and 8: guild channels (with
// their permission overwrites) and threads.
//
// categories (type 4) are written before their children, so a later reader always
// sees a parent it has already stored; parent_source_id is the source id, resolved
// on restore, never a local one (D4PLAN 11.3).
//
// nothing here throws because discord said no: a category that cannot be read
// records why in the skip list and the capture continues (types.ts).

import {
  insertBackupChannels,
  listBackupChannelsByBackup,
} from "../../db/queries/backup-channels.ts";
import { listBackupMembersByBackup } from "../../db/queries/backup-members.ts";
import { insertBackupChannelOverwrites } from "../../db/queries/backup-overwrites.ts";
import { listBackupRolesByBackup } from "../../db/queries/backup-roles.ts";
import { insertBackupThreads } from "../../db/queries/backup-threads.ts";
import type {
  BackupChannelOverwriteRow,
  BackupChannelRow,
  BackupMemberRow,
  BackupThreadRow,
  JsonObject,
  OverwriteTargetType,
  Skip,
} from "../../db/types.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import { type BackupContext, type Capture, included, type SkipList } from "./types.ts";

// the discord channel types this step writes to backup_channels (D4PLAN 11.3).
const GUILD_TEXT = 0;
const GUILD_CATEGORY = 4;
const GUILD_ANNOUNCEMENT = 5;
const GUILD_FORUM = 15;
const GUILD_MEDIA = 16;

// the parents whose archived threads we pull from: text, forum, media (step 8).
const THREAD_PARENT_TYPES: readonly number[] = [GUILD_TEXT, GUILD_FORUM, GUILD_MEDIA];

// archived thread lists paginate on `before`; a bad has_more must not loop forever.
const MAX_THREAD_PAGES = 20;
const THREAD_PAGE_SIZE = 100;

interface RawOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface RawChannel {
  id: string;
  type: number;
  name?: string | null;
  position?: number;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number | null;
  bitrate?: number | null;
  user_limit?: number | null;
  rtc_region?: string | null;
  video_quality_mode?: number | null;
  default_auto_archive_duration?: number | null;
  default_thread_rate_limit_per_user?: number | null;
  default_sort_order?: number | null;
  default_forum_layout?: number | null;
  available_tags?: JsonObject[];
  flags?: number | null;
  permission_overwrites?: RawOverwrite[];
}

interface RawThreadMetadata {
  archived?: boolean;
  locked?: boolean;
  auto_archive_duration?: number;
  archive_timestamp?: string;
}

interface RawThread {
  id: string;
  type: number;
  parent_id?: string | null;
  name?: string | null;
  rate_limit_per_user?: number | null;
  thread_metadata?: RawThreadMetadata;
  applied_tags?: string[];
}

interface ThreadListBody {
  threads?: RawThread[];
  has_more?: boolean;
}

// categories first, then the rest grouped by parent and ordered by position, so a
// reader walking the rows in order never meets a child before its category.
function orderChannels(a: RawChannel, b: RawChannel): number {
  const aCategory = a.type === GUILD_CATEGORY ? 0 : 1;
  const bCategory = b.type === GUILD_CATEGORY ? 0 : 1;
  if (aCategory !== bCategory) return aCategory - bCategory;
  if (aCategory === 1) {
    const aParent = a.parent_id ?? "";
    const bParent = b.parent_id ?? "";
    if (aParent !== bParent) return aParent < bParent ? -1 : 1;
  }
  if ((a.position ?? 0) !== (b.position ?? 0)) return (a.position ?? 0) - (b.position ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toChannelRow(backupId: string, channel: RawChannel): BackupChannelRow {
  return {
    backup_id: backupId,
    source_channel_id: channel.id,
    parent_source_id: channel.parent_id ?? null,
    type: channel.type,
    name: channel.name ?? null,
    position: channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? false,
    rate_limit_per_user: channel.rate_limit_per_user ?? null,
    bitrate: channel.bitrate ?? null,
    user_limit: channel.user_limit ?? null,
    rtc_region: channel.rtc_region ?? null,
    video_quality_mode: channel.video_quality_mode ?? null,
    default_auto_archive_duration: channel.default_auto_archive_duration ?? null,
    default_thread_rate_limit_per_user: channel.default_thread_rate_limit_per_user ?? null,
    default_sort_order: channel.default_sort_order ?? null,
    default_forum_layout: channel.default_forum_layout ?? null,
    available_tags_json: channel.available_tags ?? null,
    flags: channel.flags ?? null,
    // the announcement type is the old guild-news channel; restore needs it spelled out
    is_news: channel.type === GUILD_ANNOUNCEMENT,
  };
}

// a member's name for an overwrite row. nickname reads best and username is always
// present, so the fallback chain never yields an empty string.
function memberName(member: BackupMemberRow): string {
  return member.nickname ?? member.global_name ?? member.username;
}

// allow and deny cross as decimal strings on the wire; keep them strings, because
// a bitfield above 2^53 would lose digits as a number (AGENTS.md rule 3).
function bits(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "0");
}

function toOverwriteRow(
  backupId: string,
  channel: RawChannel,
  overwrite: RawOverwrite,
  roleNames: ReadonlyMap<string, string>,
  memberNames: ReadonlyMap<string, string>,
  skips: SkipList,
): BackupChannelOverwriteRow {
  const targetType: OverwriteTargetType = overwrite.type === 1 ? "member" : "role";
  const known = targetType === "role" ? roleNames.get(overwrite.id) : memberNames.get(overwrite.id);

  if (known === undefined) {
    // the target is not a captured role or member, so there is no name to store
    // and the restore warns rather than guessing (D4PLAN 11.6).
    const skip: Skip = {
      category: "channels",
      what: `overwrite target ${overwrite.id} on ${channel.name ?? channel.id}`,
      why: "the overwrite's target was not captured as a role or a member",
    };
    skips.add(skip);
  }

  return {
    backup_id: backupId,
    source_channel_id: channel.id,
    target_type: targetType,
    source_target_id: overwrite.id,
    target_name: known ?? "",
    allow: bits(overwrite.allow),
    deny: bits(overwrite.deny),
  };
}

export const captureChannels: Capture = async (ctx) => {
  if (!included(ctx, "channels")) return { written: 0 };

  const raw = await ctx.client.request<RawChannel[]>({
    method: "GET",
    route: `/guilds/${ctx.guildId}/channels`,
  });

  const ordered = [...raw].sort(orderChannels);
  const channelRows = ordered.map((channel) => toChannelRow(ctx.backupId, channel));

  // overwrite target names come from what is already captured, never another call.
  const roles = await listBackupRolesByBackup(ctx.db, ctx.backupId);
  const members = await listBackupMembersByBackup(ctx.db, ctx.backupId);
  const roleNames = new Map(roles.map((role) => [role.source_role_id, role.name]));
  const memberNames = new Map(members.map((member) => [member.user_id, memberName(member)]));

  const overwriteRows: BackupChannelOverwriteRow[] = [];
  for (const channel of ordered) {
    for (const overwrite of channel.permission_overwrites ?? []) {
      overwriteRows.push(
        toOverwriteRow(ctx.backupId, channel, overwrite, roleNames, memberNames, ctx.skips),
      );
    }
  }

  // one insert call per table, never one per row (D4PLAN 11.4).
  await insertBackupChannels(ctx.db, channelRows);
  await insertBackupChannelOverwrites(ctx.db, overwriteRows);

  await ctx.checkpoint("channels", { done: 1, total: 1 });
  // overwrites are rows too, but the self-check compares channels with channels,
  // so the per-category count says what a channel count means here.
  return {
    written: channelRows.length + overwriteRows.length,
    counts: { channels: channelRows.length },
  };
};

function toThreadRow(backupId: string, thread: RawThread): BackupThreadRow {
  return {
    backup_id: backupId,
    source_thread_id: thread.id,
    source_parent_id: thread.parent_id ?? "",
    type: thread.type,
    name: thread.name ?? "",
    archived: thread.thread_metadata?.archived ?? false,
    locked: thread.thread_metadata?.locked ?? false,
    auto_archive_duration: thread.thread_metadata?.auto_archive_duration ?? null,
    rate_limit_per_user: thread.rate_limit_per_user ?? null,
    applied_tags_json: thread.applied_tags ?? null,
  };
}

// the oldest archive timestamp on a page, the `before` cursor for the next one.
// iso timestamps compare lexicographically.
function oldestArchive(threads: readonly RawThread[]): string | null {
  let oldest: string | null = null;
  for (const thread of threads) {
    const at = thread.thread_metadata?.archive_timestamp;
    if (typeof at === "string" && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest;
}

async function activeThreads(ctx: BackupContext): Promise<RawThread[]> {
  try {
    const body = await ctx.client.request<ThreadListBody>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/threads/active`,
    });
    return body.threads ?? [];
  } catch (error) {
    if (error instanceof DiscordApiError) {
      ctx.skips.add({
        category: "threads",
        what: "active threads",
        why: error.message,
      });
      return [];
    }
    throw error;
  }
}

async function archivedThreads(
  ctx: BackupContext,
  channel: BackupChannelRow,
  visibility: "public" | "private",
): Promise<RawThread[]> {
  const collected: RawThread[] = [];
  let before: string | null = null;

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const query =
      before === null
        ? `?limit=${THREAD_PAGE_SIZE}`
        : `?limit=${THREAD_PAGE_SIZE}&before=${encodeURIComponent(before)}`;
    const route = `/channels/${channel.source_channel_id}/threads/archived/${visibility}${query}`;

    let body: ThreadListBody;
    try {
      body = await ctx.client.request<ThreadListBody>({ method: "GET", route });
    } catch (error) {
      if (error instanceof DiscordApiError) {
        // a 403 on one channel's archived list is one skip, not a failed capture.
        ctx.skips.add({
          category: "threads",
          what: `${visibility} threads in ${channel.name ?? channel.source_channel_id}`,
          why: error.message,
        });
        return collected;
      }
      throw error;
    }

    const threads = body.threads ?? [];
    collected.push(...threads);
    if (body.has_more !== true || threads.length === 0) break;

    before = oldestArchive(threads);
    if (before === null) break;
  }

  return collected;
}

export const captureThreads: Capture = async (ctx) => {
  if (!included(ctx, "messages")) {
    // a thread with no messages is not restorable, so threads ride on messages.
    ctx.skips.add({
      category: "threads",
      what: "guild threads",
      why: "threads are captured only when messages are included, and messages are off",
    });
    return { written: 0 };
  }

  // threads read their parents from the captured channel rows, not a fresh request.
  const parents = (await listBackupChannelsByBackup(ctx.db, ctx.backupId)).filter((channel) =>
    THREAD_PARENT_TYPES.includes(channel.type),
  );

  const seen = new Map<string, RawThread>();
  for (const thread of await activeThreads(ctx)) seen.set(thread.id, thread);
  for (const parent of parents) {
    for (const visibility of ["public", "private"] as const) {
      for (const thread of await archivedThreads(ctx, parent, visibility)) {
        seen.set(thread.id, thread);
      }
    }
  }

  // thread types 10, 11 and 12 belong here and are never written to backup_channels.
  const rows = [...seen.values()].map((thread) => toThreadRow(ctx.backupId, thread));
  await insertBackupThreads(ctx.db, rows);

  await ctx.checkpoint("threads", { done: 1, total: 1 });
  return { written: rows.length };
};
