// the shared parts of the /backup surface: the access check, the lookups, and the
// three pages a command and a control both render.
//
// every read is scoped to the guild. a backup id from another server is not
// reachable from here, so an id pasted from another guild finds nothing.

import { listPendingExportsByGuild } from "../../../db/queries/exports.ts";
import { getJob } from "../../../db/queries/jobs.ts";
import type { BackupRow, JobRow } from "../../../db/types.ts";
import { countRows } from "../../../services/backup/selfcheck.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import {
  type CommandContext,
  type CommandResult,
  formatBytes,
  relativeTimestamp,
} from "../types.ts";
import { BACKUP_ACTION, BACKUP_OBJECT, type BackupDeps, backupCustomId } from "./deps.ts";
import { infoPage, jobPage, LIST_PAGE_SIZE, listPage } from "./pages.ts";

// where a finished export landed. the job row holds no path, so the pending
// export the job wrote is the record of it. matched on the backup id in the
// payload, which is exact, rather than on the newest row in the guild. an
// export nobody can find is the same as one that never ran.
async function exportNote(deps: BackupDeps, job: JobRow): Promise<string | null> {
  if (job.kind !== "export" || job.status !== "succeeded") return null;
  const backupId = (job.payload_json as { backupId?: unknown } | null)?.backupId;
  if (typeof backupId !== "string") return null;

  const rows = await listPendingExportsByGuild(deps.db, job.guild_id);
  const row = rows.find(
    (candidate) =>
      candidate.kind === "backup" &&
      (candidate.scope_json as { backupId?: unknown } | null)?.backupId === backupId,
  );
  if (row === undefined) return null;

  const format = (row.scope_json as { format?: unknown } | null)?.format;
  const label = typeof format === "string" ? format : "json";
  return `file: \`${row.file_path}\` · ${label} · ${formatBytes(row.size_bytes)} · removed ${relativeTimestamp(Date.parse(row.expires_at))}`;
}

/** null when the person may act, and the refusal page when they may not. */
export async function refusal(
  deps: BackupDeps,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  if (await deps.authorize(ctx.userId, ctx.guildId)) return null;
  return {
    page: failurePage(
      "not your server's backups",
      "only this server's snapback admins can read or change its backups.",
      undefined,
      "ask one of this server's snapback admins, or the instance owner, for access.",
    ),
    ephemeral: true,
  };
}

/** one backup in this guild, or null. an id from another guild is not found. */
export async function lookupBackup(
  deps: BackupDeps,
  guildId: string,
  backupId: string,
): Promise<BackupRow | null> {
  if (backupId === "") return null;
  return await deps.lookup(guildId, backupId);
}

/** the list page for one page number. */
export async function listPageFor(
  deps: BackupDeps,
  guildId: string,
  page: number,
): Promise<ReturnType<typeof listPage>> {
  const all = await deps.lookupAll(guildId);
  const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = all.slice((current - 1) * LIST_PAGE_SIZE, current * LIST_PAGE_SIZE);

  return listPage({
    guildId,
    rows,
    page: current,
    total: all.length,
    selectId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.list,
      action: BACKUP_ACTION.select,
    }),
    prevId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.list,
      action: BACKUP_ACTION.page,
      cursor: String(Math.max(1, current - 1)),
    }),
    nextId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.list,
      action: BACKUP_ACTION.page,
      cursor: String(Math.min(pages, current + 1)),
    }),
    createId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.list,
      action: BACKUP_ACTION.refresh,
      cursor: String(current),
    }),
  });
}

/** one backup in detail: the counts, the self-check, and the three actions. */
export async function infoPageFor(
  deps: BackupDeps,
  guildId: string,
  row: BackupRow,
): Promise<ReturnType<typeof infoPage>> {
  const counts = await countRows(deps.db, row.backup_id);
  const contents = [
    `threads, bans, emojis, stickers, sounds, automod rules and events: ${counts.bans} ban(s), ${counts.emojis} emoji(s), ${counts.stickers} sticker(s), ${counts.sounds} sound(s), ${counts.automod} rule(s), ${counts.events} event(s)`,
  ];

  return infoPage({
    guildId,
    backup: row,
    contents,
    deleteId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.info,
      action: BACKUP_ACTION.delete,
      cursor: row.backup_id,
    }),
    exportId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.info,
      action: BACKUP_ACTION.export,
      cursor: row.backup_id,
    }),
    listId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.list,
      action: BACKUP_ACTION.page,
      cursor: "1",
    }),
  });
}

/** a job's page. the ETA appears only once there is progress to compute one. */
export async function jobPageFor(
  deps: BackupDeps,
  guildId: string,
  jobId: string,
): Promise<ReturnType<typeof jobPage>> {
  const job: JobRow | null = await getJob(deps.db, jobId);
  if (job === null) {
    return jobPage({
      job: {
        id: jobId,
        guild_id: guildId,
        kind: "backup",
        status: "failed",
        requested_by: "",
        payload_json: null,
        progress_json: null,
        error_code: "SB_JOB_MISSING",
        error_body: "the job row is gone",
        created_at: new Date(deps.now()).toISOString(),
        started_at: null,
        finished_at: null,
        attempts: 0,
      },
      guildId,
      etaSeconds: null,
      refreshId: backupCustomId({
        guildId,
        object: BACKUP_OBJECT.job,
        action: BACKUP_ACTION.refresh,
        cursor: jobId,
      }),
      pauseId: backupCustomId({
        guildId,
        object: BACKUP_OBJECT.job,
        action: BACKUP_ACTION.pause,
        cursor: jobId,
      }),
      cancelId: backupCustomId({
        guildId,
        object: BACKUP_OBJECT.job,
        action: BACKUP_ACTION.cancel,
        cursor: jobId,
      }),
      infoId: null,
    });
  }

  return jobPage({
    job,
    guildId,
    etaSeconds: await deps.jobs.eta(jobId),
    note: await exportNote(deps, job),
    refreshId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.job,
      action: BACKUP_ACTION.refresh,
      cursor: jobId,
    }),
    pauseId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.job,
      action: BACKUP_ACTION.pause,
      cursor: jobId,
    }),
    cancelId: backupCustomId({
      guildId,
      object: BACKUP_OBJECT.job,
      action: BACKUP_ACTION.cancel,
      cursor: jobId,
    }),
    infoId: null,
  });
}
