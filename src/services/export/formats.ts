// services/export/formats.ts
// the shapes a backup can be written out as. "json" is our own bundle, which is
// the only lossless one. "restorecord" emits the public backup object that
// restorecord's own download endpoint serves, so a snapback backup can be handed
// to anyone expecting that file.
//
// the restorecord shape is copied from their endpoint, not guessed:
// references/restorecord-new/pages/api/v2/self/servers/[serverid]/backup/index.ts
// it carries names, types, positions, and permission bitfields and no ids, so
// nothing in it can be re-parented or matched by id later. that is their format's
// limit, not ours, and it is stated in the export page rather than hidden.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExportBundle } from "./json.ts";
import { ExportError, writeExport } from "./json.ts";

export type ExportFormat = "json" | "restorecord";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["json", "restorecord"];

/** narrows an option or payload value to a format, or throws the fixed error. */
export function parseExportFormat(value: unknown): ExportFormat {
  if (value === "json" || value === "restorecord") return value;
  throw new ExportError("SB_EXPORT_FORMAT");
}

// the restorecord channel type is a discord channel type number, which is what
// backup_channels.type already holds, so it passes through untouched.
interface RestorecordChannel {
  name: string | null;
  type: number;
  position: number;
  parentId: string | null;
  topic: string | null;
  nsfw: boolean;
  userLimit: number | null;
  createdAt: string;
}

interface RestorecordRole {
  name: string;
  color: number;
  hoist: boolean;
  permissions: string;
  mentionable: boolean;
  position: number;
  isEveryone: boolean;
  createdAt: string;
}

export interface RestorecordBackup {
  success: true;
  backup: {
    name: string;
    icon: string | null;
    channels: RestorecordChannel[];
    roles: RestorecordRole[];
    createdAt: string;
  };
}

// we do not store when each role or channel was created, only when the backup
// ran, so every createdAt is the backup's own. saying so beats inventing times.
export function bundleToRestorecord(bundle: ExportBundle): RestorecordBackup {
  const at = bundle.backup.created_at;
  return {
    success: true,
    backup: {
      name: bundle.backup.guild_name ?? bundle.backup.label ?? bundle.backup.backup_id,
      icon: bundle.backup.icon_url,
      channels: bundle.channels.map((channel) => ({
        name: channel.name,
        type: channel.type,
        position: channel.position,
        parentId: channel.parent_source_id,
        topic: channel.topic,
        nsfw: channel.nsfw,
        userLimit: channel.user_limit,
        createdAt: at,
      })),
      roles: bundle.roles.map((role) => ({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        permissions: role.permissions,
        mentionable: role.mentionable,
        position: role.position,
        isEveryone: role.is_everyone,
        createdAt: at,
      })),
      createdAt: at,
    },
  };
}

// writes the bundle as format under dir and returns the absolute path and byte
// length. same contract as writeExport, so the job does not branch past this call.
export async function writeFormattedExport(
  bundle: ExportBundle,
  dir: string,
  format: ExportFormat,
): Promise<{ path: string; bytes: number }> {
  if (format === "json") return await writeExport(bundle, dir);

  const json = `${JSON.stringify(bundleToRestorecord(bundle), null, 2)}\n`;
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, "restorecord.json");
  await writeFile(path, json, "utf8");
  return { path, bytes: Buffer.byteLength(json, "utf8") };
}
