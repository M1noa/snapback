// the message phase (D4PLAN 12.6). one webhook per channel, the messages
// oldest first, and the webhook deleted when the channel is done.
//
// what a webhook replay cannot do is said in the report rather than hidden: a
// webhook stamps its own time, it impersonates the author, and a reply cannot
// be rethreaded because the message it answered has a new id.

import { join } from "node:path";
import { listBackupChannelsByBackup } from "../../db/queries/backup-channels.ts";
import { listBackupMessagesByBackup } from "../../db/queries/backup-messages.ts";
import type { BackupMessageRow, JsonObject } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { type AssetProblem, contentTypeFor, readStoredAsset, uploadGuildIcon } from "./assets.ts";
import { phaseOk, type RestoreContext, type RestoreNote, type RestorePhase } from "./types.ts";

/** the webhook's name. every restored message reads as if it came from it. */
const WEBHOOK_NAME = "Snapback";
/** the job_progress cursor is written every this many messages (12.6). */
const CHECKPOINT_EVERY = 100;

interface Webhook {
  readonly id: string;
  readonly token: string;
}

interface ChannelPlan {
  readonly targetId: string;
  readonly label: string;
  readonly rows: readonly BackupMessageRow[];
}

interface AttachmentFile {
  readonly filename: string;
  readonly bytes: Buffer;
}

export const restoreMessages: RestorePhase = async (ctx) => {
  if (!ctx.options.messages) return phaseOk(0);

  const stored = await listBackupMessagesByBackup(ctx.db, ctx.backupId);
  if (stored.length === 0) return phaseOk(0);

  const notes: RestoreNote[] = [];
  const channels = await listBackupChannelsByBackup(ctx.db, ctx.backupId);
  const names = new Map(channels.map((channel) => [channel.source_channel_id, channel.name]));
  const label = (sourceId: string): string => names.get(sourceId) ?? sourceId;

  const plans = planChannels(ctx, stored, label, notes);
  const total = plans.reduce((sum, plan) => sum + plan.rows.length, 0);

  if (plans.length > 0) {
    notes.push(timestampNote(ctx));
    notes.push(authorNote());
    if (plans.some((plan) => plan.rows.some(isReply))) notes.push(replyNote());
  }

  // the cursor is written in order: two channels finishing together must not
  // write it out of order.
  let queue: Promise<void> = Promise.resolve();
  const checkpoint = (count: number): Promise<void> => {
    queue = queue.then(async () => {
      try {
        await ctx.checkpoint("messages", count, total);
      } catch (error) {
        notes.push({ what: "the progress checkpoint", why: why(error) });
      }
    });
    return queue;
  };

  const progress = { done: 0 };
  const avatar = await uploadGuildIcon(ctx, "icon", ctx.sourceGuildId);

  // the channels run in parallel, the messages inside one channel do not: each
  // channel's history has to read in order (12.6).
  await Promise.all(
    plans.map((plan) => replayChannel(ctx, plan, avatar, notes, progress, checkpoint)),
  );

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(progress.done, notes);
};

/**
 * one plan per channel, after the per-channel ceiling. the newest messages are
 * the ones worth having, so the ceiling keeps the end of the list and the older
 * ones are left out and counted.
 */
function planChannels(
  ctx: RestoreContext,
  stored: readonly BackupMessageRow[],
  label: (sourceId: string) => string,
  notes: RestoreNote[],
): ChannelPlan[] {
  // the query sorted by created_at, so the rows are already oldest first and
  // the order inside a channel is the order they were sent.
  const grouped = new Map<string, BackupMessageRow[]>();
  for (const row of stored) {
    const list = grouped.get(row.channel_source_id);
    if (list === undefined) grouped.set(row.channel_source_id, [row]);
    else list.push(row);
  }

  const limit = Math.max(0, ctx.options.messageLimit);
  const plans: ChannelPlan[] = [];

  for (const [sourceId, rows] of grouped) {
    const targetId = ctx.maps.channels.get(sourceId);
    if (targetId === undefined) {
      notes.push({
        what: `the messages in ${label(sourceId)}`,
        why: "the channel was not restored, so its messages were not replayed",
      });
      continue;
    }

    const kept = rows.slice(Math.max(0, rows.length - limit));
    const leftOut = rows.length - kept.length;
    if (leftOut > 0) {
      notes.push({
        what: `the messages in ${label(sourceId)}`,
        why: `the per-channel limit is ${limit}, so the newest ${kept.length} were replayed and ${leftOut} older ones were left out`,
      });
    }
    // a webhook is created only for a channel that has something to post.
    if (kept.length === 0) continue;
    plans.push({ targetId, label: label(sourceId), rows: kept });
  }

  return plans;
}

async function replayChannel(
  ctx: RestoreContext,
  plan: ChannelPlan,
  avatar: string | null,
  notes: RestoreNote[],
  progress: { done: number },
  checkpoint: (count: number) => Promise<void>,
): Promise<void> {
  let webhook: Webhook;
  try {
    webhook = await ctx.client.request<Webhook>({
      method: "POST",
      route: `/channels/${plan.targetId}/webhooks`,
      body: avatar === null ? { name: WEBHOOK_NAME } : { name: WEBHOOK_NAME, avatar },
    });
  } catch (error) {
    // no manage webhooks, or the channel is gone: the message phase stops for
    // this channel and the report says which one (12.8).
    notes.push({ what: `the webhook in ${plan.label}`, why: why(error) });
    return;
  }

  try {
    for (const row of plan.rows) {
      if (ctx.signal.cancelled) break;
      const posted = await postMessage(ctx, webhook, plan, row, notes);
      if (!posted) continue;
      progress.done += 1;
      if (progress.done % CHECKPOINT_EVERY === 0) await checkpoint(progress.done);
    }
  } finally {
    // the webhook goes even when a post failed, so an aborted restore does not
    // leave webhooks behind (12.6).
    try {
      await ctx.client.request({ method: "DELETE", route: `/webhooks/${webhook.id}` });
    } catch (error) {
      notes.push({ what: `the webhook in ${plan.label}`, why: why(error) });
    }
  }
}

async function postMessage(
  ctx: RestoreContext,
  webhook: Webhook,
  plan: ChannelPlan,
  row: BackupMessageRow,
  notes: RestoreNote[],
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    content: contentOf(ctx, row),
    username: displayName(row),
    // a replayed message must never ping anybody.
    allowed_mentions: { parse: [] },
  };
  if (row.author_avatar_url !== null) payload.avatar_url = row.author_avatar_url;
  if (row.embeds_json !== null && row.embeds_json.length > 0) payload.embeds = row.embeds_json;

  const attachments = row.attachments_json ?? [];
  const files: AttachmentFile[] = [];
  const missed: string[] = [];
  for (const attachment of attachments) {
    const found = await attachmentFile(ctx, attachment);
    if (found.file === null) {
      missed.push(`${found.filename} was not re-uploaded: ${found.why}`);
      continue;
    }
    files.push(found.file);
  }
  if (attachments.length > 0) {
    const parts = [
      ...(files.length > 0 ? [`re-uploaded ${files.map((file) => file.filename).join(", ")}`] : []),
      ...missed,
    ];
    notes.push({
      what: `the attachments of the message ${row.message_id} in ${plan.label}`,
      why: parts.join("; "),
    });
  }

  try {
    if (files.length === 0) {
      await ctx.client.request({
        method: "POST",
        route: `/webhooks/${webhook.id}/${webhook.token}`,
        body: payload,
      });
    } else {
      // discord takes a file in a multipart body: the message in payload_json
      // and the bytes in files[n], whose index is the attachment's id. the
      // client posts every body as json, so it needs to learn to pass a
      // FormData through before an attachment survives (src/discord/client.ts).
      const form = new FormData();
      form.set(
        "payload_json",
        JSON.stringify({
          ...payload,
          attachments: files.map((file, index) => ({ id: String(index), filename: file.filename })),
        }),
      );
      for (const [index, file] of files.entries()) {
        form.set(
          `files[${index}]`,
          new Blob([file.bytes], { type: contentTypeFor(file.filename) }),
          file.filename,
        );
      }
      await ctx.client.request({
        method: "POST",
        route: `/webhooks/${webhook.id}/${webhook.token}`,
        body: form,
      });
    }
    return true;
  } catch (error) {
    // a rejected payload is one message, not the whole channel (12.8).
    notes.push({ what: `the message ${row.message_id} in ${plan.label}`, why: why(error) });
    return false;
  }
}

/** the stored attachment's bytes, or why there are none. */
async function attachmentFile(
  ctx: RestoreContext,
  attachment: JsonObject,
): Promise<{ file: AttachmentFile | null; filename: string; why: string }> {
  const filename = typeof attachment.filename === "string" ? attachment.filename : "attachment";
  const stored = typeof attachment.path === "string" ? attachment.path : null;

  // the capture records the exact relative path; the plain name is the
  // fallback for a row that only kept the filename.
  const roots = [join(ctx.backupDir, ctx.backupId), ctx.backupDir];
  const candidates = [
    ...roots.map((root) => (stored === null ? null : join(root, stored))),
    ...roots.map((root) => join(root, "assets", "attachment", filename)),
  ].filter((candidate): candidate is string => candidate !== null);

  let why = "the file is not in the backup";
  for (const candidate of candidates) {
    const read = await readStoredAsset(ctx, candidate);
    if (read.bytes !== null) return { file: { filename, bytes: read.bytes }, filename, why: "" };
    why = problemWhy(read.problem);
  }
  return { file: null, filename, why };
}

function problemWhy(problem: AssetProblem | null): string {
  if (problem === "too-large") return "the file is over the size ceiling";
  if (problem === "outside") return "the file is not in the backup's asset directory";
  return "the file is not in the backup";
}

/** the content, with the original time appended when the operator asked for it. */
function contentOf(ctx: RestoreContext, row: BackupMessageRow): string {
  const content = row.content ?? "";
  if (!ctx.options.timestampSuffix) return content;
  const seconds = epochSeconds(row.created_at);
  if (seconds === null) return content;
  // discord's own relative timestamp, rendered in the reader's timezone.
  return `${content}\n-# originally sent <t:${seconds}:f>`;
}

function epochSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** the name the author had in the guild: nickname, then display name, then username. */
function displayName(row: BackupMessageRow): string {
  const name = row.author_nickname ?? row.author_global_name ?? row.author_username;
  return name === "" ? WEBHOOK_NAME : name;
}

// a reply points at a message whose id changed, so it cannot be rethreaded.
function isReply(row: BackupMessageRow): boolean {
  return row.reference_json !== null || row.type === 19;
}

function timestampNote(ctx: RestoreContext): RestoreNote {
  return {
    what: "the original timestamps",
    why: ctx.options.timestampSuffix
      ? "discord stamps a webhook message when it is posted, so the original time is appended to the content instead of being kept"
      : "discord stamps a webhook message when it is posted, so the original times are not preserved",
  };
}

function authorNote(): RestoreNote {
  return {
    what: "the message authors",
    why: `the messages are posted by a webhook named ${WEBHOOK_NAME}, so they read as the webhook and not as their original author`,
  };
}

function replyNote(): RestoreNote {
  return {
    what: "the reply chains",
    why: "a reply cannot be rethreaded because the message it answered has a new id, so the replies were posted as plain messages",
  };
}

// discord's own words when discord is the one that said no (AGENTS.md rule 5).
function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}
