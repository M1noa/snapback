// what the /restore surface needs, and the one builder for its custom ids.

import type { GuildSettings } from "../../../config/defaults.ts";
import type { BackupRow, Database } from "../../../db/types.ts";
import type { CustomIdSpec } from "../../../discord/interactions/router.ts";
import type { StateStore } from "../../../discord/interactions/state.ts";
import type { Logger } from "../../../lib/log.ts";
import type { JobRunner } from "../../../services/jobs/runner.ts";
import type { RestoreOptions } from "../../../services/restore/types.ts";
import { customID } from "../../components/row.ts";

export const RESTORE_SURFACE = "restore";

/** the object slot, one per surface a control lives on. */
export const RESTORE_OBJECT = {
  select: "select",
  confirm: "confirm",
  clear: "clear",
  plan: "plan",
  job: "job",
} as const;

/** the action slot, per object. */
export const RESTORE_ACTION = {
  /** the selection page's submit: the ticked categories become the options. */
  submit: "submit",
  /** the confirm page's button, carrying the nonce. */
  confirm: "confirm",
  /** the "clear target first" button, which opens the modal. */
  open: "open",
  /** the destructive page's button, carrying the nonce. */
  clear: "clear",
  /** the modal's submit, carrying the nonce. */
  typed: "typed",
  /** the preview button. */
  plan: "plan",
  /** the job page's buttons. */
  refresh: "refresh",
  cancel: "cancel",
} as const;

export interface RestoreCustomIdInput {
  readonly guildId: string;
  readonly object: (typeof RESTORE_OBJECT)[keyof typeof RESTORE_OBJECT];
  readonly action: string;
  readonly cursor?: string;
}

export function restoreCustomId(input: RestoreCustomIdInput): string {
  return customID({
    surface: RESTORE_SURFACE,
    guild: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.cursor ?? "",
  });
}

export interface RestoreDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly jobs: JobRunner;
  readonly now: () => number;
  /** the source guild's settings, which carry the restore defaults. */
  readonly settings: (guildId: string) => Promise<GuildSettings>;
  /** the confirm nonce and the selection payload. */
  readonly state: StateStore;
  /** the backups of this guild, for the picker. */
  readonly backups: (guildId: string) => Promise<BackupRow[]>;
  /** the guilds the bot is in, for the target picker. */
  readonly guilds: () => Promise<{ id: string; name: string | null }[]>;
  /** the backup by id, scoped to the guild that owns it. */
  readonly lookup: (guildId: string, backupId: string) => Promise<BackupRow | null>;
  /** re-checked on every interaction (AGENTS.md rule 8). */
  readonly authorize: (userId: string, guildId: string) => Promise<boolean>;
  readonly audit: (input: {
    guildId: string;
    actorUserId: string;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  /** the plan, for the dry run. */
  readonly plan: (backupId: string, options: RestoreOptions) => Promise<unknown>;
}

export const RESTORE_SPECS: readonly CustomIdSpec[] = [
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.submit },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.confirm },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.open },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.clear },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.typed },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.plan },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.refresh },
  { surface: RESTORE_SURFACE, action: RESTORE_ACTION.cancel },
];
