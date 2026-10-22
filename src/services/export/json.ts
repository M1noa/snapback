// services/export/json.ts
// the backup JSON export (D4PLAN 17.3): one sealed backup, every child row, and
// the asset directory beside it. this module handles no secrets at all. a backup
// row and its children carry ids, names, urls, and bitfield strings, never a
// token, so nothing here redacts and nothing carries a redaction header.
//
// every child list is read through its query module, never with inline sql, so
// the export shape cannot drift from the tables. those list queries each end in
// an ORDER BY over the row's own id, which is what makes the same backup
// serialise byte for byte identically no matter what order the rows were written
// in. the golden-file test compares bytes and depends on exactly that.

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as automodQueries from "../../db/queries/backup-automod.ts";
import * as banQueries from "../../db/queries/backup-bans.ts";
import * as channelQueries from "../../db/queries/backup-channels.ts";
import * as emojiQueries from "../../db/queries/backup-emojis.ts";
import * as eventQueries from "../../db/queries/backup-events.ts";
import * as memberQueries from "../../db/queries/backup-members.ts";
import * as messageQueries from "../../db/queries/backup-messages.ts";
import * as overwriteQueries from "../../db/queries/backup-overwrites.ts";
import * as roleQueries from "../../db/queries/backup-roles.ts";
import * as soundQueries from "../../db/queries/backup-sounds.ts";
import * as stickerQueries from "../../db/queries/backup-stickers.ts";
import * as threadQueries from "../../db/queries/backup-threads.ts";
import { getBackup } from "../../db/queries/backups.ts";
import type {
  BackupAutomodRow,
  BackupBanRow,
  BackupChannelOverwriteRow,
  BackupChannelRow,
  BackupEmojiRow,
  BackupEventRow,
  BackupMemberRow,
  BackupMessageRow,
  BackupRoleRow,
  BackupRow,
  BackupSoundRow,
  BackupStickerRow,
  BackupThreadRow,
  Database,
} from "../../db/types.ts";

// the child tables of a backup, as an export carries them. backup_tags is not
// here: tags are restore-time filters over rows this bundle already holds.
export interface ExportBundle {
  schema_version: number;
  exported_at: string;
  backup: BackupRow;
  roles: BackupRoleRow[];
  channels: BackupChannelRow[];
  overwrites: BackupChannelOverwriteRow[];
  threads: BackupThreadRow[];
  members: BackupMemberRow[];
  messages: BackupMessageRow[];
  bans: BackupBanRow[];
  emojis: BackupEmojiRow[];
  stickers: BackupStickerRow[];
  sounds: BackupSoundRow[];
  automod: BackupAutomodRow[];
  events: BackupEventRow[];
}

// our own export errors. one code, one fixed message (AGENTS.md errors).
export type ExportErrorCode = "SB_EXPORT_NO_BACKUP" | "SB_EXPORT_MALFORMED" | "SB_EXPORT_FORMAT";

const EXPORT_MESSAGES: Record<ExportErrorCode, string> = {
  SB_EXPORT_NO_BACKUP: "the backup to export does not exist",
  SB_EXPORT_MALFORMED: "the file is not a snapback export bundle",
  SB_EXPORT_FORMAT: "that is not a format snapback writes",
};

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode) {
    super(`${code}: ${EXPORT_MESSAGES[code]}`);
    this.name = "ExportError";
    this.code = code;
  }
}

/** the child array keys, so readExport validates the top-level shape in one pass. */
const CHILD_KEYS = [
  "roles",
  "channels",
  "overwrites",
  "threads",
  "members",
  "messages",
  "bans",
  "emojis",
  "stickers",
  "sounds",
  "automod",
  "events",
] as const;

// reads one sealed backup and every row under it. the lists are awaited in turn,
// not in parallel: one duckdb connection runs one statement at a time.
export async function buildExport(
  db: Database,
  backupId: string,
  options: { now?: () => string } = {},
): Promise<ExportBundle> {
  const backup = await getBackup(db, backupId);
  if (backup === null) throw new ExportError("SB_EXPORT_NO_BACKUP");

  const roles = await roleQueries.listBackupRolesByBackup(db, backupId);
  const channels = await channelQueries.listBackupChannelsByBackup(db, backupId);
  const overwrites = await overwriteQueries.listBackupChannelOverwritesByBackup(db, backupId);
  const threads = await threadQueries.listBackupThreadsByBackup(db, backupId);
  const members = await memberQueries.listBackupMembersByBackup(db, backupId);
  const messages = await messageQueries.listBackupMessagesByBackup(db, backupId);
  const bans = await banQueries.listBackupBansByBackup(db, backupId);
  const emojis = await emojiQueries.listBackupEmojisByBackup(db, backupId);
  const stickers = await stickerQueries.listBackupStickersByBackup(db, backupId);
  const sounds = await soundQueries.listBackupSoundsByBackup(db, backupId);
  const automod = await automodQueries.listBackupAutomodsByBackup(db, backupId);
  const events = await eventQueries.listBackupEventsByBackup(db, backupId);

  // injected in tests so exported_at is not clock-dependent (D4PLAN 20).
  const now = options.now ?? (() => new Date().toISOString());
  return {
    schema_version: backup.schema_version,
    exported_at: now(),
    backup,
    roles,
    channels,
    overwrites,
    threads,
    members,
    messages,
    bans,
    emojis,
    stickers,
    sounds,
    automod,
    events,
  };
}

// deterministic bytes: the keys are inserted in the order ExportBundle declares
// them and JSON.stringify keeps that order, so two runs of the same backup
// produce the same text. one trailing newline so a diff stays clean.
export function bundleToJson(bundle: ExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// writes backup.json under dir, creating dir if it is missing, and returns the
// absolute path and the byte length. when the caller hands us the backup's own
// directory, its asset tree is copied alongside so the export stands alone. a
// backup with no assets is not an error and not a skip: there is simply no tree.
export async function writeExport(
  bundle: ExportBundle,
  dir: string,
  options: { backupDir?: string } = {},
): Promise<{ path: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const json = bundleToJson(bundle);
  const path = resolve(dir, "backup.json");
  await writeFile(path, json, "utf8");

  if (options.backupDir !== undefined) {
    const assets = join(options.backupDir, "assets");
    if (await pathExists(assets)) {
      await cp(assets, join(dir, "assets"), { recursive: true });
    }
  }

  return { path, bytes: Buffer.byteLength(json, "utf8") };
}

// parse and check the top-level shape. a file that is not a bundle throws the
// fixed error rather than handing back half an object the caller would index.
export async function readExport(path: string): Promise<ExportBundle> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExportError("SB_EXPORT_MALFORMED");
  }
  if (!isExportBundle(parsed)) throw new ExportError("SB_EXPORT_MALFORMED");
  return parsed;
}

// the shallow check the contract needs: the scalars, a backup object, and every
// child entry an array. the row shapes are the query modules' to guarantee.
function isExportBundle(value: unknown): value is ExportBundle {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.schema_version !== "number") return false;
  if (typeof record.exported_at !== "string") return false;
  if (record.backup === null || typeof record.backup !== "object") return false;
  return CHILD_KEYS.every((key) => Array.isArray(record[key]));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
