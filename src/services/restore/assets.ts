// the restore's asset helpers (D4PLAN 12.6, 12.3).
//
// the capture writes every asset into the backup's own assets/ tree, and the
// restore reads the bytes back from there. a cdn url is signed and expires, so
// a url on its own restores nothing (D4PLAN 5.1).
//
// two shapes come out of here: a data uri, for the places discord takes image
// data inside a json body (the guild icon and the banner go in the same patch
// as the rest, 12.3), and the raw bytes, for the place that needs a multipart
// upload (a webhook message's attachments).

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { RestoreContext } from "./types.ts";

/**
 * the ceiling a restored file must fit under. it mirrors the default
 * MAX_ASSET_BYTES (config/parse-env.ts): the restore context does not carry
 * the configured value, so the default is what it applies.
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});

/** why a stored asset could not be read, in the operator's words. */
export type AssetProblem = "outside" | "missing" | "too-large";

export interface AssetRead {
  readonly bytes: Buffer | null;
  readonly problem: AssetProblem | null;
}

/** the content type discord should be told about, from the file's extension. */
export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// the capture writes assets under <backupDir>/<backupId>/assets/. a backup
// handed over as its own directory has them at <backupDir>/assets. both are
// accepted, because which one ctx.backupDir is depends on the caller.
function assetRoots(ctx: RestoreContext): string[] {
  return [join(ctx.backupDir, ctx.backupId, "assets"), join(ctx.backupDir, "assets")];
}

/** the file's bytes, or why there are none. */
export async function readStoredAsset(ctx: RestoreContext, filePath: string): Promise<AssetRead> {
  const target = resolve(filePath);
  const roots = assetRoots(ctx).map((root) => resolve(root));
  if (!roots.some((root) => isInside(root, target))) return { bytes: null, problem: "outside" };

  let size: number;
  try {
    size = (await stat(target)).size;
  } catch {
    return { bytes: null, problem: "missing" };
  }
  if (size > MAX_ASSET_BYTES) return { bytes: null, problem: "too-large" };

  try {
    return { bytes: await readFile(target), problem: null };
  } catch {
    return { bytes: null, problem: "missing" };
  }
}

/**
 * the file as a data uri, for a json body. null when the file is not in the
 * backup's asset tree or is over the ceiling; the caller says which.
 */
export async function uploadAsset(
  ctx: RestoreContext,
  filePath: string,
  filename: string,
): Promise<string | null> {
  const read = await readStoredAsset(ctx, filePath);
  if (read.bytes === null) return null;
  return `data:${contentTypeFor(filename)};base64,${read.bytes.toString("base64")}`;
}

/**
 * the guild's own image as a data uri, ready for the guild patch body (12.3:
 * the icon goes in with the colour, never in a separate upload call).
 *
 * kind is the image ("icon", "banner", ...); sourceId is the guild it came
 * from, which the capture puts in the file name when the backup holds more
 * than one guild image.
 */
export async function uploadGuildIcon(
  ctx: RestoreContext,
  kind: string,
  sourceId: string,
): Promise<string | null> {
  const file = await findGuildAsset(ctx, kind, sourceId);
  if (file === null) return null;
  return uploadAsset(ctx, file, basename(file));
}

async function findGuildAsset(
  ctx: RestoreContext,
  kind: string,
  sourceId: string,
): Promise<string | null> {
  for (const root of assetRoots(ctx)) {
    const dir = join(root, "guild");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      // the backup holds no guild image of this kind.
      continue;
    }
    const file =
      files.find((entry) => stem(entry) === `${sourceId}-${kind}`) ??
      files.find((entry) => stem(entry) === kind) ??
      files.find((entry) => stem(entry).startsWith(`${kind}-`)) ??
      files.find((entry) => entry.startsWith(kind));
    if (file !== undefined) return join(dir, file);
  }
  return null;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
