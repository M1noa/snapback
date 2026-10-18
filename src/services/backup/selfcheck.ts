// the self-check and the seal (D4PLAN 11.6).
//
// a backup that fails its own validation is still stored, marked incomplete, with
// the specific failures listed in /backup info. it restores, the restore warns.
// the failure mode this prevents is a partial backup nobody notices until the
// day it is needed.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import * as automodDb from "../../db/queries/backup-automod.ts";
import * as bansDb from "../../db/queries/backup-bans.ts";
import * as channelsDb from "../../db/queries/backup-channels.ts";
import * as emojisDb from "../../db/queries/backup-emojis.ts";
import * as eventsDb from "../../db/queries/backup-events.ts";
import * as membersDb from "../../db/queries/backup-members.ts";
import * as messagesDb from "../../db/queries/backup-messages.ts";
import * as overwritesDb from "../../db/queries/backup-overwrites.ts";
import * as rolesDb from "../../db/queries/backup-roles.ts";
import * as soundsDb from "../../db/queries/backup-sounds.ts";
import * as stickersDb from "../../db/queries/backup-stickers.ts";
import * as threadsDb from "../../db/queries/backup-threads.ts";
import { getBackup, updateBackup } from "../../db/queries/backups.ts";
import type { BackupRow, Database, SelfCheck, Skip } from "../../db/types.ts";
import type { CountedCategory } from "./types.ts";

/** the counts each capture step reported. compared against what is really stored. */
export type RecordedCounts = Readonly<Record<CountedCategory, number>>;

export interface SelfCheckResult {
  readonly ok: boolean;
  readonly failures: string[];
}

/** what is really in the tables, for the sealed row and for the count check. */
export interface StoredCounts extends RecordedCounts {
  readonly bans: number;
  readonly emojis: number;
  readonly stickers: number;
  readonly sounds: number;
  readonly automod: number;
  readonly events: number;
}

export async function runSelfCheck(
  db: Database,
  backupId: string,
  recorded: RecordedCounts,
): Promise<SelfCheckResult> {
  const failures: string[] = [];

  const roles = await rolesDb.listBackupRolesByBackup(db, backupId);
  const channels = await channelsDb.listBackupChannelsByBackup(db, backupId);
  const threads = await threadsDb.listBackupThreadsByBackup(db, backupId);

  const roleIds = new Set(roles.map((role) => role.source_role_id));
  const channelIds = new Set(channels.map((channel) => channel.source_channel_id));
  // a message can live in a thread, so a thread id is a valid channel of origin.
  const places = new Set([...channelIds, ...threads.map((thread) => thread.source_thread_id)]);

  // every channel's parent is captured, or the channel is top level. a parent id
  // with no row is a channel the restore would have to guess a home for.
  for (const channel of channels) {
    if (channel.parent_source_id !== null && !channelIds.has(channel.parent_source_id)) {
      failures.push(
        `channel ${channel.source_channel_id} (${channel.name ?? "unnamed"}) has parent ${channel.parent_source_id}, which is not in this backup`,
      );
    }
  }

  // every overwrite target resolves to a captured role or member, or it was
  // already recorded as unresolved (an empty name) by the channels step.
  const memberIds = new Set(
    (await membersDb.listBackupMembersByBackup(db, backupId)).map((member) => member.user_id),
  );
  for (const overwrite of await overwritesDb.listBackupChannelOverwritesByBackup(db, backupId)) {
    if (overwrite.target_name !== null && overwrite.target_name !== "") continue;
    const known =
      overwrite.target_type === "role"
        ? roleIds.has(overwrite.source_target_id)
        : memberIds.has(overwrite.source_target_id);
    if (!known) {
      failures.push(
        `overwrite on channel ${overwrite.source_channel_id} targets ${overwrite.target_type} ${overwrite.source_target_id}, which is not in this backup and has no name to fall back on`,
      );
    }
  }

  // every member's role ids are captured. only checked when roles were captured at
  // all: with the roles include turned off, every member would "fail" for a reason
  // the operator chose on purpose.
  if (roleIds.size > 0) {
    for (const member of await membersDb.listBackupMembersByBackup(db, backupId)) {
      const missing = member.role_ids_json.filter((id) => !roleIds.has(id));
      if (missing.length > 0) {
        failures.push(
          `member ${member.user_id} carries ${missing.length} role(s) that are not in this backup: ${missing.join(", ")}`,
        );
      }
    }
  }

  // every message knows where it came from.
  for (const message of await messagesDb.listBackupMessagesByBackup(db, backupId)) {
    if (!places.has(message.channel_source_id)) {
      failures.push(
        `message ${message.message_id} is in channel ${message.channel_source_id}, which is not in this backup`,
      );
    }
  }

  // the counts on the row are the counts that are really there.
  const actual = await countRows(db, backupId);
  for (const key of ["roles", "channels", "members", "messages"] as const) {
    if (recorded[key] !== actual[key]) {
      failures.push(`recorded ${recorded[key]} ${key}, ${actual[key]} stored`);
    }
  }

  return { ok: failures.length === 0, failures };
}

/** what is really in the tables, for the sealed row and for the count check. */
export async function countRows(db: Database, backupId: string): Promise<StoredCounts> {
  return {
    roles: await rolesDb.countBackupRolesByBackup(db, backupId),
    channels: await channelsDb.countBackupChannelsByBackup(db, backupId),
    members: await membersDb.countBackupMembersByBackup(db, backupId),
    messages: await messagesDb.countBackupMessagesByBackup(db, backupId),
    bans: await bansDb.countBackupBansByBackup(db, backupId),
    emojis: await emojisDb.countBackupEmojisByBackup(db, backupId),
    stickers: await stickersDb.countBackupStickersByBackup(db, backupId),
    sounds: await soundsDb.countBackupSoundsByBackup(db, backupId),
    automod: await automodDb.countBackupAutomodsByBackup(db, backupId),
    events: await eventsDb.countBackupEventsByBackup(db, backupId),
  };
}

export interface SealInput {
  readonly db: Database;
  readonly backupId: string;
  readonly recorded: RecordedCounts;
  readonly skips: readonly Skip[];
  /** the backup's directory on disk, walked for size_bytes. null when none. */
  readonly assetDir: string | null;
  /** step-level failures the pipeline already knows about, folded into the check. */
  readonly extraFailures?: readonly string[];
}

export interface SealResult {
  readonly backup: BackupRow;
  readonly check: SelfCheckResult;
}

/**
 * writes the final counts, the on-disk size, and the self-check onto the row. this
 * is what makes a backup sealed: self_check_json goes from null to a value, and
 * listOpenBackups stops seeing it.
 */
export async function sealBackup(input: SealInput): Promise<SealResult> {
  const existing = await getBackup(input.db, input.backupId);
  if (existing === null) {
    throw new Error(`SB_BACKUP_MISSING: no backup row ${input.backupId} to seal`);
  }

  const check = await runSelfCheck(input.db, input.backupId, input.recorded);
  const counts = await countRows(input.db, input.backupId);

  // a step that threw is a failure of the backup even when the counts happen to
  // agree, so it is folded in here rather than left in the skip list alone.
  const extra = input.extraFailures ?? [];
  const failures = [...check.failures, ...extra];

  // the skip list is stored with the check: "incomplete" is never a mystery.
  const selfCheck: SelfCheck = {
    ok: failures.length === 0,
    failures,
    skipped: [...input.skips],
  };

  const backup: BackupRow = {
    ...existing,
    member_count: counts.members,
    message_count: counts.messages,
    channel_count: counts.channels,
    role_count: counts.roles,
    size_bytes: input.assetDir === null ? 0 : await directoryBytes(input.assetDir),
    self_check_json: selfCheck,
  };
  await updateBackup(input.db, backup);
  return { backup, check };
}

// the bytes on disk, not a sum of what the downloads reported: a file that was
// written and then half-removed is a real disk cost.
async function directoryBytes(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // no directory is not a failure: a guild with no assets has no asset directory.
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await stat(path).catch(() => null);
    if (info === null) continue;
    total += info.isDirectory() ? await directoryBytes(path) : info.size;
  }
  return total;
}
