// services/import/formats.ts
// reading a backup someone else wrote. three sources are accepted: our own json
// bundle, which is the only lossless one; restorecord's public download, whose
// shape is copied from their endpoint and not guessed; and a lenient reader for
// anything that looks like either, which is how a vaultcord file is taken because
// vaultcord publishes no format anywhere we could read.
//
// nothing here talks to discord and nothing here writes. a parsed json value goes
// in, backup rows come out, and the job inserts them and seals.
//
// restorecord's download carries no channel ids (only parentId), so a channel's
// parent cannot be resolved inside the file. that is their format's limit: the
// parent is dropped and the seal records it as skipped, never guessed by position.

import type { BackupChannelRow, BackupRoleRow, BackupRow, Skip } from "../../db/types.ts";
import { type ExportBundle, isExportBundle } from "../export/json.ts";

export type ImportFormat = "snapback" | "restorecord" | "vaultcord";
/** "auto" reads the file and decides; anything else is the caller's override. */
export type ImportFormatChoice = ImportFormat | "auto";

export const IMPORT_FORMATS: readonly ImportFormat[] = ["snapback", "restorecord", "vaultcord"];

export type ImportErrorCode =
  | "SB_IMPORT_MALFORMED"
  | "SB_IMPORT_FORMAT"
  | "SB_IMPORT_EMPTY"
  | "SB_IMPORT_NO_FILE";

const IMPORT_MESSAGES: Record<ImportErrorCode, string> = {
  SB_IMPORT_MALFORMED: "that file is not a backup snapback can read",
  SB_IMPORT_FORMAT: "that file is not the format it was said to be",
  SB_IMPORT_EMPTY: "that backup holds no roles and no channels",
  SB_IMPORT_NO_FILE: "an import needs a file",
};

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode) {
    super(`${code}: ${IMPORT_MESSAGES[code]}`);
    this.name = "ImportError";
    this.code = code;
  }
}

/** narrows an option or payload value to a format, or throws the fixed error. */
export function parseImportFormat(value: unknown): ImportFormatChoice {
  if (value === undefined || value === null || value === "" || value === "auto") return "auto";
  if (value === "snapback" || value === "restorecord" || value === "vaultcord") return value;
  throw new ImportError("SB_IMPORT_FORMAT");
}

/** everything a file gave us, already shaped as backup rows. */
export interface ImportedBackup {
  readonly format: ImportFormat;
  readonly name: string | null;
  readonly iconUrl: string | null;
  /** the source row, when the file carries a whole one. the job re-keys it. */
  readonly row: BackupRow | null;
  readonly roles: readonly BackupRoleRow[];
  readonly channels: readonly BackupChannelRow[];
  /** the complete child set, for the lossless format only. */
  readonly bundle: ExportBundle | null;
  readonly skips: readonly Skip[];
}

/** reads one parsed json value into rows, honouring an override when given. */
export function readBackup(
  value: unknown,
  choice: ImportFormatChoice,
  backupId: string,
): ImportedBackup {
  const format = choice === "auto" ? detectFormat(value) : choice;

  if (format === "snapback") {
    if (!isExportBundle(value)) throw new ImportError("SB_IMPORT_MALFORMED");
    return readNative(value, backupId);
  }
  return readGeneric(value, format, backupId);
}

export function detectFormat(value: unknown): ImportFormat {
  if (isExportBundle(value)) return "snapback";
  const node = asObject(value);
  if (node === null) throw new ImportError("SB_IMPORT_MALFORMED");
  const backup = asObject(node.backup);
  const envelope = backup ?? node;
  if (!Array.isArray(envelope.channels) && !Array.isArray(envelope.roles)) {
    throw new ImportError("SB_IMPORT_MALFORMED");
  }
  // their download wraps the guild in { success, backup } and stamps it. the
  // keys are enough to tell it from a file we know less about.
  if (node.success === true && typeof envelope.createdAt === "string") return "restorecord";
  return "vaultcord";
}

/** a snapback bundle keeps everything, so nothing is skipped but the files. */
function readNative(bundle: ExportBundle, backupId: string): ImportedBackup {
  return {
    format: "snapback",
    name: bundle.backup.guild_name,
    iconUrl: bundle.backup.icon_url,
    row: { ...bundle.backup, backup_id: backupId },
    roles: bundle.roles.map((row) => ({ ...row, backup_id: backupId })),
    channels: bundle.channels.map((row) => ({ ...row, backup_id: backupId })),
    bundle,
    skips: [
      {
        category: "assets",
        what: "the files the original backup kept on disk",
        why: "an import reads one json file, so role icons and emojis keep the urls it carries",
      },
    ],
  };
}

interface GuildFile {
  readonly channels: readonly unknown[];
  readonly roles: readonly unknown[];
  readonly name: string | null;
  readonly icon: string | null;
}

// both foreign formats put the guild at the top or under "backup", and both name
// channels and roles the same way. ids appear only in files that carry them.
function guildFile(value: unknown): GuildFile {
  const node = asObject(value);
  if (node === null) throw new ImportError("SB_IMPORT_MALFORMED");
  const envelope = asObject(node.backup) ?? node;
  const guild = asObject(envelope.guild) ?? asObject(node.guild);
  const channels = asArray(envelope.channels) ?? asArray(node.channels) ?? [];
  const roles = asArray(envelope.roles) ?? asArray(node.roles) ?? [];
  if (channels.length === 0 && roles.length === 0) throw new ImportError("SB_IMPORT_EMPTY");

  return {
    channels,
    roles,
    name: text(envelope.name) ?? text(node.name) ?? text(guild?.name),
    icon: httpUrl(text(envelope.icon) ?? text(node.icon) ?? text(guild?.icon)),
  };
}

function readGeneric(value: unknown, format: ImportFormat, backupId: string): ImportedBackup {
  const file = guildFile(value);

  const roles = file.roles
    .map((node, index) => readRole(node, backupId, index))
    .filter((row): row is BackupRoleRow => row !== null);
  const channels = file.channels
    .map((node, index) => readChannel(node, backupId, index))
    .filter((row): row is BackupChannelRow => row !== null);

  const skips: Skip[] = [];
  const parenting = resolveParents(channels);
  if (parenting.lost > 0) {
    skips.push({
      category: "channels",
      what: `${parenting.lost} channel parent link(s)`,
      why: parenting.why,
    });
  }
  if (file.channels.length > channels.length) {
    skips.push({
      category: "channels",
      what: `${file.channels.length - channels.length} channel(s)`,
      why: "the file gives them no usable type",
    });
  }
  if (file.roles.length > roles.length) {
    skips.push({
      category: "roles",
      what: `${file.roles.length - roles.length} role(s)`,
      why: "the file gives them no usable name",
    });
  }
  skips.push({
    category: "members",
    what: "members, messages, and their files",
    why: "this format carries a server's shape only, so a restore rebuilds roles and channels and nobody's history",
  });
  if (format === "vaultcord") {
    skips.push({
      category: "format",
      what: "the exact vaultcord layout",
      why: "vaultcord publishes no format, so the file is read for the keys both known formats use",
    });
  }

  return {
    format,
    name: file.name,
    iconUrl: file.icon,
    row: null,
    roles,
    channels: parenting.channels,
    bundle: null,
    skips,
  };
}

// ids come from the file when it has them. a file without ids gets stand-ins, so
// nothing downstream ever sees an empty key, and no stand-in can collide with a
// real snowflake because it carries a dash.
function readRole(node: unknown, backupId: string, index: number): BackupRoleRow | null {
  const role = asObject(node);
  if (role === null) return null;
  const name = text(role.name)?.trim();
  if (name === undefined || name === "") return null;

  return {
    backup_id: backupId,
    source_role_id:
      idOf(role, ["id", "roleId", "source_role_id", "sourceRoleId"]) ?? `rc-role-${index}`,
    name,
    color: channelNumber(role.color) ?? 0,
    hoist: role.hoist === true,
    mentionable: role.mentionable === true,
    position: integer(role.position) ?? index,
    // a bitfield read as a number loses precision past 2^53, so only a decimal
    // string or an exact integer is trusted. anything else is nothing.
    permissions: permissionsOf(role.permissions),
    is_everyone: role.isEveryone === true || role.everyone === true,
    is_bot_managed: role.managed === true,
    bot_id: null,
    integration_id: null,
    icon_url: null,
    unicode_emoji: null,
    tags_json: null,
  };
}

function readChannel(node: unknown, backupId: string, index: number): BackupChannelRow | null {
  const channel = asObject(node);
  if (channel === null) return null;
  const type = integer(channel.type);
  if (type === null || type < 0 || type > 16) return null;

  return {
    backup_id: backupId,
    source_channel_id:
      idOf(channel, ["id", "channelId", "source_channel_id", "sourceChannelId"]) ??
      `rc-channel-${index}`,
    parent_source_id: text(channel.parentId) ?? text(channel.parent_id) ?? null,
    type,
    name: text(channel.name),
    position: integer(channel.position) ?? index,
    topic: text(channel.topic),
    nsfw: channel.nsfw === true,
    rate_limit_per_user: integer(channel.rateLimitPerUser) ?? integer(channel.rate_limit_per_user),
    bitrate: integer(channel.bitrate),
    user_limit: integer(channel.userLimit) ?? integer(channel.user_limit),
    rtc_region: text(channel.rtcRegion) ?? text(channel.rtc_region),
    video_quality_mode: integer(channel.videoQualityMode) ?? integer(channel.video_quality_mode),
    default_auto_archive_duration:
      integer(channel.defaultAutoArchiveDuration) ?? integer(channel.default_auto_archive_duration),
    default_thread_rate_limit_per_user:
      integer(channel.defaultThreadRateLimitPerUser) ??
      integer(channel.default_thread_rate_limit_per_user),
    default_sort_order: integer(channel.defaultSortOrder) ?? integer(channel.default_sort_order),
    default_forum_layout:
      integer(channel.defaultForumLayout) ?? integer(channel.default_forum_layout),
    available_tags_json: null,
    flags: integer(channel.flags),
    is_news: null,
  };
}

// a parent is kept only when it names a channel in the same file. the self-check
// would refuse the row otherwise, and inventing an order is worse than saying so.
function resolveParents(channels: readonly BackupChannelRow[]): {
  channels: readonly BackupChannelRow[];
  lost: number;
  why: string;
} {
  const known = new Set(channels.map((row) => row.source_channel_id));
  let lost = 0;
  const resolved = channels.map((row) => {
    if (row.parent_source_id === null) return row;
    if (known.has(row.parent_source_id)) return row;
    lost++;
    return { ...row, parent_source_id: null };
  });
  return {
    channels: resolved,
    lost,
    why:
      lost > 0 && channels.some((row) => row.source_channel_id.startsWith("rc-"))
        ? "the file names a parent but carries no channel id to resolve it to (restorecord's download has none), so those channels sit at the top level"
        : "the file names a parent that is not in the file",
  };
}

function idOf(node: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return null;
}

function permissionsOf(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : "0";
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return "0";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function channelNumber(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function httpUrl(value: string | null): string | null {
  if (value === null) return null;
  return value.startsWith("https://") || value.startsWith("http://") ? value : null;
}
