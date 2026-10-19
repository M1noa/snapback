// the thread phase (D4PLAN 12.2 step 7, D4TODO phase 6).
//
// a thread needs its parent, so it runs after the channels phase (12.2). an
// announcement thread is skipped: its first message would have to exist before
// the thread does, and the messages phase runs last (12.8).
//
// archived and locked are re-applied after the create. the archive timestamp is
// the restore time, because discord does not accept an old one, and the note
// says so rather than letting the operator believe the age survived.

import { listBackupChannelsByBackup } from "../../db/queries/backup-channels.ts";
import { listBackupThreadsByBackup } from "../../db/queries/backup-threads.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestorePhase } from "./types.ts";

const THREAD_ANNOUNCEMENT = 10;
const THREAD_PUBLIC = 11;
const THREAD_PRIVATE = 12;

const GUILD_FORUM = 15;
const GUILD_MEDIA = 16;

/** the auto-archive durations discord accepts, in minutes. */
const ARCHIVE_DURATIONS = [60, 1440, 4320, 10080] as const;

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

/** the accepted duration closest to the captured one. */
function nearestDuration(minutes: number): number {
  let best: number = ARCHIVE_DURATIONS[0];
  for (const value of ARCHIVE_DURATIONS) {
    if (Math.abs(value - minutes) < Math.abs(best - minutes)) best = value;
  }
  return best;
}

export const restoreThreads: RestorePhase = async (ctx) => {
  if (!ctx.options.threads) return phaseOk(0);

  const rows = await listBackupThreadsByBackup(ctx.db, ctx.backupId);
  if (rows.length === 0) return phaseOk(0);

  // the parent types, so tags go only where discord accepts them.
  const channels = await listBackupChannelsByBackup(ctx.db, ctx.backupId);
  const parentTypes = new Map(channels.map((row) => [row.source_channel_id, row.type]));

  const notes: { what: string; why: string }[] = [];
  let count = 0;

  for (const row of rows) {
    const what = `the thread "${row.name}"`;

    if (row.type === THREAD_ANNOUNCEMENT) {
      notes.push({
        what,
        why: "an announcement thread needs its first message to exist before the thread does, and the messages phase runs last, so it was skipped",
      });
      continue;
    }
    if (row.type !== THREAD_PUBLIC && row.type !== THREAD_PRIVATE) {
      notes.push({ what, why: `discord has no thread of type ${row.type}, so it was skipped` });
      continue;
    }

    const parent = ctx.maps.channels.get(row.source_parent_id);
    if (parent === undefined) {
      notes.push({
        what,
        why: "its parent channel was not created in the target, so it was skipped",
      });
      continue;
    }

    const body: Record<string, unknown> = { name: row.name, type: row.type };

    let duration = row.auto_archive_duration;
    if (duration !== null) {
      const nearest = nearestDuration(duration);
      if (nearest !== duration) {
        notes.push({
          what,
          why: `the auto-archive duration ${duration} is not one discord accepts, so ${nearest} was used`,
        });
        duration = nearest;
      }
      body.auto_archive_duration = duration;
    }
    if (row.rate_limit_per_user !== null) body.rate_limit_per_user = row.rate_limit_per_user;

    const parentType = parentTypes.get(row.source_parent_id);
    if (
      row.applied_tags_json !== null &&
      row.applied_tags_json.length > 0 &&
      (parentType === GUILD_FORUM || parentType === GUILD_MEDIA)
    ) {
      body.applied_tags = row.applied_tags_json;
    }

    let threadId: string;
    try {
      const created = await ctx.client.request<{ id: string }>({
        method: "POST",
        route: `/channels/${parent}/threads`,
        body,
      });
      threadId = created.id;
      ctx.maps.channels.set(row.source_thread_id, threadId);
      count += 1;
    } catch (error) {
      notes.push({ what, why: why(error) });
      continue;
    }

    if (row.archived === false && row.locked === false) continue;

    const patch: Record<string, unknown> = { archived: row.archived, locked: row.locked };
    if (duration !== null) patch.auto_archive_duration = duration;
    try {
      await ctx.client.request({
        method: "PATCH",
        route: `/channels/${threadId}`,
        body: patch,
      });
    } catch (error) {
      notes.push({ what, why: why(error) });
    }
    if (row.archived) {
      notes.push({
        what,
        why: "the archived state was re-applied, but the archive timestamp is the restore time because discord does not accept an old one",
      });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
};
