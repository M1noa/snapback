// the backup job (D4PLAN 11). a job is a row, and this is the handler that runs
// it: the same pipeline the command would have run, with a checkpoint per step so
// a restart resumes instead of starting over.

import type { GuildSettings } from "../../config/defaults.ts";
import type { Database } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import type { Logger } from "../../lib/log.ts";
import type { JobHandler } from "../jobs/runner.ts";
import { runBackup } from "./index.ts";

export interface BackupJobDeps {
  readonly db: Database;
  readonly client: DiscordClient;
  readonly log: Logger;
  /** the guild's settings, read fresh: a capture must not use a stale include set. */
  readonly settings: (guildId: string) => Promise<GuildSettings>;
  readonly backupDir: string;
  readonly maxAssetBytes: number;
}

interface BackupPayload {
  readonly label?: string | null;
  readonly kind?: "manual" | "auto" | "pre_restore";
  readonly include?: Partial<GuildSettings["backup_include"]>;
  readonly messageLimit?: number;
}

export function createBackupJobHandler(deps: BackupJobDeps): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload_json ?? {}) as BackupPayload;
    const stored = await deps.settings(ctx.job.guild_id);

    // the per-run overrides win over the stored ones, and the stored ones win over
    // the defaults. a capture never reads a setting from anywhere else.
    const settings: GuildSettings = {
      ...stored,
      backup_include: { ...stored.backup_include, ...(payload.include ?? {}) },
      auto_backup_message_count: payload.messageLimit ?? stored.auto_backup_message_count,
    };

    const result = await runBackup(
      {
        db: deps.db,
        client: deps.client,
        log: ctx.log,
        checkpoint: ctx.checkpoint,
      },
      {
        guildId: ctx.job.guild_id,
        kind: payload.kind ?? "manual",
        createdBy: ctx.job.requested_by,
        label: payload.label ?? null,
        settings,
        backupDir: deps.backupDir,
        maxAssetBytes: deps.maxAssetBytes,
      },
    );

    // a backup that failed its own check is stored and marked, not thrown: the
    // restore warns, and the operator sees the failures in /backup info.
    ctx.log.info("backup finished", {
      backupId: result.backup.backup_id,
      complete: result.check.ok,
      failures: result.check.failures.length,
      roles: result.counts.roles,
      channels: result.counts.channels,
      members: result.counts.members,
      messages: result.counts.messages,
    });
  };
}
