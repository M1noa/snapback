// queries/backup-purge.ts. deleting a backup means deleting every row that points
// at it.
//
// schema.sql declares no foreign keys, so a delete of the backups row orphans all
// thirteen child tables. one module owns the list, so a table added later is one
// line here rather than a quiet leak.

import type { Database } from "../types.ts";
import { deleteBackupAutomodsByBackup } from "./backup-automod.ts";
import { deleteBackupBansByBackup } from "./backup-bans.ts";
import { deleteBackupChannelsByBackup } from "./backup-channels.ts";
import { deleteBackupEmojisByBackup } from "./backup-emojis.ts";
import { deleteBackupEventsByBackup } from "./backup-events.ts";
import { deleteBackupMembersByBackup } from "./backup-members.ts";
import { deleteBackupMessagesByBackup } from "./backup-messages.ts";
import { deleteBackupChannelOverwritesByBackup } from "./backup-overwrites.ts";
import { deleteBackupRolesByBackup } from "./backup-roles.ts";
import { deleteBackupSoundsByBackup } from "./backup-sounds.ts";
import { deleteBackupStickersByBackup } from "./backup-stickers.ts";
import { deleteBackupTagsByBackup } from "./backup-tags.ts";
import { deleteBackupThreadsByBackup } from "./backup-threads.ts";
import { deleteBackup } from "./backups.ts";

// children first, the row last: if a delete fails half way, the backup row is
// still there to name what is left behind rather than a row pointing at nothing.
export async function purgeBackup(db: Database, backupId: string): Promise<void> {
  await deleteBackupRolesByBackup(db, backupId);
  await deleteBackupChannelsByBackup(db, backupId);
  await deleteBackupChannelOverwritesByBackup(db, backupId);
  await deleteBackupThreadsByBackup(db, backupId);
  await deleteBackupMembersByBackup(db, backupId);
  await deleteBackupMessagesByBackup(db, backupId);
  await deleteBackupBansByBackup(db, backupId);
  await deleteBackupEmojisByBackup(db, backupId);
  await deleteBackupStickersByBackup(db, backupId);
  await deleteBackupSoundsByBackup(db, backupId);
  await deleteBackupAutomodsByBackup(db, backupId);
  await deleteBackupEventsByBackup(db, backupId);
  await deleteBackupTagsByBackup(db, backupId);
  await deleteBackup(db, backupId);
}
