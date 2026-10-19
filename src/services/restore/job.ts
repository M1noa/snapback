// the restore job (D4PLAN 12.2). the phases run in the plan's order, each one
// checkpointed, so a kill mid-restore resumes from the last phase rather than
// starting over.

import { getBackup } from "../../db/queries/backups.ts";
import type { Database } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import type { Logger } from "../../lib/log.ts";
import type { JobHandler } from "../jobs/runner.ts";
import { runRestore } from "./index.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
  type RestoreOptions,
} from "./types.ts";

export interface RestoreJobDeps {
  readonly db: Database;
  readonly client: DiscordClient;
  readonly log: Logger;
  /** where the backup's asset files live. */
  readonly backupDir: string;
  readonly now?: () => string;
}

interface RestorePayload {
  readonly backupId?: string;
  readonly targetId?: string;
  readonly options?: Partial<RestoreOptions>;
}

export function createRestoreJobHandler(deps: RestoreJobDeps): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload_json ?? {}) as RestorePayload;
    const backupId = payload.backupId ?? "";
    const targetId = payload.targetId ?? ctx.job.guild_id;
    const options: RestoreOptions = { ...DEFAULT_RESTORE_OPTIONS, ...(payload.options ?? {}) };

    const backup = backupId === "" ? null : await getBackup(deps.db, backupId);
    const restoreCtx: RestoreContext = {
      db: deps.db,
      client: deps.client,
      log: ctx.log,
      backupId,
      targetGuildId: targetId,
      options,
      maps: createRestoreMaps(),
      sourceGuildId: backup?.guild_id ?? ctx.job.guild_id,
      backupDir: deps.backupDir,
      signal: ctx.signal,
      checkpoint: async (phase, done, total) => {
        await ctx.checkpoint(phase, { done, total });
      },
      note: (what, why) => {
        ctx.log.warn("restore note", { what, why });
      },
      now: deps.now ?? (() => new Date().toISOString()),
    };

    const report = await runRestore(restoreCtx);
    ctx.log.info("restore finished", {
      backupId,
      targetGuildId: targetId,
      cancelled: report.cancelled,
      phases: report.phases.map((phase) => `${phase.phase}:${phase.outcome}`).join(" "),
    });
  };
}
