// the capture contract (D4PLAN 11). every category lives in its own module, takes
// one context, and returns how many rows it wrote. nothing throws because of a
// missing permission or a 404 on an optional endpoint: a category that cannot be
// read records why in the skip list and the backup continues, so a partial backup
// is visibly partial rather than silently partial (11.6).

import type { GuildSettings } from "../../config/defaults.ts";
import type { Database, Skip } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";

// one thing a step could not capture, named so a person can act on it. the shape
// is db/types.ts's, because it ends up stored in self_check_json.skipped.
export type { Skip };

export interface SkipList {
  add(skip: Skip): void;
  /** in the order they happened, frozen. */
  all(): readonly Skip[];
  get size(): number;
}

export function createSkipList(): SkipList {
  const items: Skip[] = [];
  return {
    add(skip) {
      items.push(skip);
    },
    all: () => Object.freeze([...items]),
    get size() {
      return items.length;
    },
  };
}

/**
 * a skip for something a step could not read. when discord is the one that said
 * no, the reason is discord's own code and message, never a paraphrase (rule 5).
 */
export function skipFor(category: string, what: string, error: unknown): Skip {
  if (error instanceof DiscordApiError) {
    return { category, what, why: formatDiscordError(error).said };
  }
  return { category, what, why: error instanceof Error ? error.message : String(error) };
}

/** which directory an asset belongs in under backups/<id>/assets/. */
export type AssetKind = "guild" | "role" | "emoji" | "sticker" | "sound" | "attachment";

export interface StoredAsset {
  /** the cdn url the bytes came from, kept beside the path (D4PLAN 5.1). */
  readonly url: string;
  /** relative to backups/<backup_id>/. */
  readonly path: string;
  readonly bytes: number;
}

export interface AssetStore {
  /** the absolute directory this backup's assets live in. */
  readonly dir: string;
  /**
   * downloads url into assets/<kind>/<name> and returns the stored asset, or null
   * when it is over maxBytes, already gone, or not a cdn url. a null here is a
   * recorded limitation, not an error.
   */
  save(kind: AssetKind, name: string, url: string | null): Promise<StoredAsset | null>;
  /**
   * the path save() would use, without downloading. deterministic, so a restore
   * finds a file whose row stores only the url.
   */
  pathFor(kind: AssetKind, name: string, url: string): string;
}

/** the four categories the self-check compares a step's report against the db. */
export type CountedCategory = "roles" | "channels" | "members" | "messages";

/** what one step wrote, for the job's progress row and the final counts. */
export interface CaptureResult {
  /** rows written to the database by this step, across every table it touched. */
  readonly written: number;
  /**
   * per-category totals, when a step writes more than the counted table (the
   * channels step writes overwrites too, and those are not channels). absent means
   * `written` is the count for this step's category.
   */
  readonly counts?: Partial<Record<CountedCategory, number>>;
}

export interface CaptureCounts {
  readonly done: number;
  /** null while the total is not yet known (paginating has no fixed end). */
  readonly total: number | null;
}

/** the .env ceilings a capture must not exceed. clamped in config/parse-env.ts. */
export interface BackupLimits {
  readonly maxMessagesPerChannel: number;
  readonly maxMessagesTotal: number;
}

export interface BackupContext {
  readonly db: Database;
  /** every discord call goes through this (AGENTS.md rule 6). */
  readonly client: DiscordClient;
  readonly log: Logger;
  readonly backupId: string;
  readonly guildId: string;
  /** the guild's settings, already read: the include set and the ceilings live here. */
  readonly settings: GuildSettings;
  /** the .env ceilings, which a guild's settings may tighten but never raise. */
  readonly limits: BackupLimits;
  readonly assets: AssetStore;
  readonly skips: SkipList;
  /**
   * called per step and per page so a crash resumes rather than restarts
   * (D4PLAN 11). the job runner owns the row; this only reports.
   */
  readonly checkpoint: (step: string, counts: CaptureCounts) => Promise<void>;
  /** iso timestamp, injectable so a test is not clock-dependent. */
  readonly now: () => string;
}

/** one capture step. ordered by services/backup/index.ts, never by a step itself. */
export type Capture = (ctx: BackupContext) => Promise<CaptureResult>;

/**
 * the version of the captured payload, written to backups.schema_version and to
 * an export bundle. bumped when the shape of a captured row changes in a way a
 * restore has to know about, never because the code changed.
 */
export const BACKUP_SCHEMA_VERSION = 1;

/** the include set keys, by the D4PLAN 11 category name. */
export function included(
  ctx: BackupContext,
  category: keyof GuildSettings["backup_include"],
): boolean {
  return ctx.settings.backup_include[category];
}
