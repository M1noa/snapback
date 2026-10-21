// what the /backup surface needs, and the one builder for its custom ids.
//
// the surface is its own namespace (sb:backup:...), so the boot assertion can tell
// a backup control from a setup one and a gap in either stops the start
// (D4PLAN 9.3).

import type { GuildSettings } from "../../../config/defaults.ts";
import type { BackupRow, Database, RetentionRow } from "../../../db/types.ts";

import type { DiscordClient } from "../../../discord/client.ts";
import type { CustomIdSpec } from "../../../discord/interactions/router.ts";
import type { StateStore } from "../../../discord/interactions/state.ts";
import type { Logger } from "../../../lib/log.ts";
import type { JobRunner } from "../../../services/jobs/runner.ts";
import { customID } from "../../components/row.ts";

export const BACKUP_SURFACE = "backup";

/** the object slot, one per surface a control lives on. */
export const BACKUP_OBJECT = {
  list: "list",
  info: "info",
  job: "job",
  del: "del",
  prune: "prune",
  create: "create",
} as const;

/** the action slot, per object. a stray verb here is a boot failure, not a 404. */
export const BACKUP_ACTION = {
  page: "page",
  select: "select",
  delete: "delete",
  confirm: "confirm",
  prune: "prune",
  policy: "policy",
  refresh: "refresh",
  pause: "pause",
  cancel: "cancel",
  export: "export",
} as const;

export interface BackupCustomIdInput {
  readonly guildId: string;
  readonly object: (typeof BACKUP_OBJECT)[keyof typeof BACKUP_OBJECT];
  readonly action: string;
  readonly cursor?: string;
}

/** the only builder for this surface. the cursor slot is always written, so every
 *  id is six segments and the router can read every one of them (D4PLAN 9.3). */
export function backupCustomId(input: BackupCustomIdInput): string {
  return customID({
    surface: BACKUP_SURFACE,
    guild: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.cursor ?? "",
  });
}

export interface BackupDeps {
  readonly db: Database;
  readonly client: DiscordClient;
  readonly log: Logger;
  readonly jobs: JobRunner;
  /** epoch ms. injected so a page's relative timestamps are testable. */
  readonly now: () => number;
  readonly retention: (guildId: string) => Promise<RetentionRow>;
  /** the policy's only writer. prune reads a row nobody could create, so the
   *  numbers are set from the page that uses them (D4PLAN 17.2). */
  readonly saveRetention: (row: RetentionRow) => Promise<void>;
  readonly settings: (guildId: string) => Promise<GuildSettings>;
  /** the confirm nonce and the selection payload live here, never in a customID. */
  readonly state: StateStore;
  readonly backupDir: string;
  readonly exportDir: string;
  /** re-checked on every interaction: a control rendered for an admin last week
   *  must fail closed today (AGENTS.md rule 8). */
  readonly authorize: (userId: string, guildId: string) => Promise<boolean>;
  /** record the action, so a destructive press is traceable (D4PLAN 5.1). */
  readonly audit: (input: {
    guildId: string;
    actorUserId: string;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  /** one backup by id, and every backup in the guild. a lookup is scoped to the
   *  guild, so a backup from another server is not reachable from here. */
  readonly lookup: (guildId: string, backupId: string) => Promise<BackupRow | null>;
  readonly lookupAll: (guildId: string) => Promise<BackupRow[]>;
}

/** every (surface, action) pair this build produces from a backup control. */
export const BACKUP_SPECS: readonly CustomIdSpec[] = [
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.page },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.refresh },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.select },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.delete },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.confirm },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.prune },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.policy },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.export },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.pause },
  { surface: BACKUP_SURFACE, action: BACKUP_ACTION.cancel },
];
