// the restore plan (D4PLAN 12.1). the backup plus the operator's options, turned
// into an ordered list of operations with counts, and nothing written.
//
// it is what `/restore plan` shows and what the confirm page offers as "preview
// what will change". the order is the executor's order, because a plan whose
// order differs from the executor is worse than no plan.

import { listBackupAutomodsByBackup } from "../../db/queries/backup-automod.ts";
import { listBackupBansByBackup } from "../../db/queries/backup-bans.ts";
import { listBackupChannelsByBackup } from "../../db/queries/backup-channels.ts";
import { listBackupEmojisByBackup } from "../../db/queries/backup-emojis.ts";
import { listBackupEventsByBackup } from "../../db/queries/backup-events.ts";
import { listBackupMembersByBackup } from "../../db/queries/backup-members.ts";
import { listBackupMessagesByBackup } from "../../db/queries/backup-messages.ts";
import { listBackupChannelOverwritesByBackup } from "../../db/queries/backup-overwrites.ts";
import { listBackupRolesByBackup } from "../../db/queries/backup-roles.ts";
import { listBackupSoundsByBackup } from "../../db/queries/backup-sounds.ts";
import { listBackupStickersByBackup } from "../../db/queries/backup-stickers.ts";
import { listBackupThreadsByBackup } from "../../db/queries/backup-threads.ts";
import { getBackup } from "../../db/queries/backups.ts";
import type { Database } from "../../db/types.ts";
import { RESTORE_PHASES, type RestoreOptions, type RestorePhaseName } from "./types.ts";

export interface PlanOp {
  /** the phase this op belongs to, using the phase names in types.ts. */
  readonly phase: RestorePhaseName;
  /** what the op does, in the operator's words. */
  readonly what: string;
  /** how many items this op covers. */
  readonly count: number;
}

export interface RestorePlan {
  readonly ops: readonly PlanOp[];
  readonly counts: {
    readonly roles: number;
    readonly channels: number;
    readonly overwrites: number;
    readonly threads: number;
    readonly members: number;
    readonly messages: number;
    readonly bans: number;
    readonly emojis: number;
    readonly stickers: number;
    readonly sounds: number;
    readonly automod: number;
    readonly events: number;
  };
  /** the ops grouped by phase, in the order the phases run. */
  readonly phases: readonly { readonly phase: RestorePhaseName; readonly ops: readonly PlanOp[] }[];
  /** what the plan could not promise, said plainly. */
  readonly notes: readonly string[];
}

export async function buildPlan(
  db: Database,
  backupId: string,
  options: RestoreOptions,
): Promise<RestorePlan> {
  const backup = await getBackup(db, backupId);
  const notes: string[] = [];
  if (backup === null) {
    return {
      ops: [],
      counts: emptyCounts(),
      phases: RESTORE_PHASES.map((phase) => ({ phase, ops: [] })),
      notes: ["that backup is gone."],
    };
  }
  if (backup.self_check_json !== null && !backup.self_check_json.ok) {
    notes.push(
      `the backup is incomplete: ${backup.self_check_json.failures.length} failure(s). it still restores, and the restore warns.`,
    );
  }

  const [roles, channels, overwrites, threads, members, messages, bans] = await Promise.all([
    listBackupRolesByBackup(db, backupId),
    listBackupChannelsByBackup(db, backupId),
    listBackupChannelOverwritesByBackup(db, backupId),
    listBackupThreadsByBackup(db, backupId),
    listBackupMembersByBackup(db, backupId),
    listBackupMessagesByBackup(db, backupId),
    listBackupBansByBackup(db, backupId),
  ]);
  const [emojis, stickers, sounds, automod, events] = await Promise.all([
    listBackupEmojisByBackup(db, backupId),
    listBackupStickersByBackup(db, backupId),
    listBackupSoundsByBackup(db, backupId),
    listBackupAutomodsByBackup(db, backupId),
    listBackupEventsByBackup(db, backupId),
  ]);

  // a category is counted by its rows, and the people are counted by the roles
  // they hold: a member with no role still counts, and the plan says so.
  const everyone = roles.filter((role) => role.is_everyone).length;
  const categories = channels.filter((channel) => channel.type === 4).length;
  const otherChannels = channels.length - categories;
  const messageChannels = new Set(messages.map((message) => message.channel_source_id)).size;
  const plannedMessages = Math.min(
    messages.length,
    options.messageLimit * Math.max(1, messageChannels),
  );

  const ops: PlanOp[] = [];
  const add = (phase: RestorePhaseName, what: string, count: number): void => {
    if (count > 0) ops.push({ phase, what, count });
  };

  if (options.clearBefore) {
    ops.push({
      phase: "guild",
      what: "clear the target: its channels, its roles, and the bans the backup holds",
      count: bans.length,
    });
  }
  if (options.guild) add("guild", "restore the guild's settings and images", 1);
  if (options.emojis) add("emojis", "create emoji", emojis.length);
  if (options.stickers) add("emojis", "create sticker", stickers.length);
  if (options.sounds) add("emojis", "create soundboard sound", sounds.length);
  if (options.roles) {
    add("roles", "edit the @everyone role", everyone);
    add("roles", "create role", roles.length - everyone);
  }
  if (options.channels) {
    add("categories", "create category channel", categories);
    add("channels", "create channel", otherChannels);
  }
  if (options.overwrites) add("overwrites", "apply permission overwrite", overwrites.length);
  if (options.threads) add("threads", "create thread", threads.length);
  if (options.onboarding) {
    add("onboarding", "apply the onboarding prompts", backup.onboarding_json === null ? 0 : 1);
    add("onboarding", "apply the welcome screen", backup.welcome_screen_json === null ? 0 : 1);
  }
  if (options.automod) add("automod", "create auto-moderation rule", automod.length);
  if (options.events) add("events", "create scheduled event", events.length);
  if (options.members) {
    add(
      "members",
      options.memberMode === 1
        ? "set the roles of the members already here"
        : options.memberMode === 2
          ? "set the roles and the nicknames of the members already here"
          : "sync the members' roles, removing the ones the backup does not have",
      members.length,
    );
  }
  if (options.bans) add("bans", "apply ban", bans.length);
  if (options.messages) {
    add("messages", `post message, up to ${options.messageLimit} per channel`, plannedMessages);
  }

  if (options.messages && plannedMessages < messages.length) {
    notes.push(
      `${messages.length - plannedMessages} message(s) are beyond the ceiling and would not be posted.`,
    );
  }
  if (options.members && members.length > 0) {
    notes.push(
      "a bot cannot add a member. the members the target does not already have are not restored here.",
    );
  }
  if (options.messages && messages.length > 0) {
    notes.push(
      "the messages are posted through a webhook, so their timestamps are the restore time and the reply chains cannot be rethreaded.",
    );
  }

  return {
    ops,
    counts: {
      roles: roles.length,
      channels: channels.length,
      overwrites: overwrites.length,
      threads: threads.length,
      members: members.length,
      messages: messages.length,
      bans: bans.length,
      emojis: emojis.length,
      stickers: stickers.length,
      sounds: sounds.length,
      automod: automod.length,
      events: events.length,
    },
    phases: RESTORE_PHASES.map((phase) => ({
      phase,
      ops: ops.filter((op) => op.phase === phase),
    })),
    notes,
  };
}

function emptyCounts(): RestorePlan["counts"] {
  return {
    roles: 0,
    channels: 0,
    overwrites: 0,
    threads: 0,
    members: 0,
    messages: 0,
    bans: 0,
    emojis: 0,
    stickers: 0,
    sounds: 0,
    automod: 0,
    events: 0,
  };
}
