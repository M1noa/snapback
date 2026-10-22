// the scheduler (D4PLAN 17.1). one tick, and the due work is read from the
// database rather than kept in a timer, so a restart does not lose a schedule and
// two processes do not double-fire it.
//
// the tick is 15 seconds. it decides what is due and hands each job to the
// runner, which is what serialises them per guild.
//
// the work it owns: an auto backup per guild on its own interval, an auto
// restore after a successful backup, the token refresh sweep, the counter reset
// at 00:05 utc, the orphan webhook sweep, and the expiry sweeps.

import { readGuildSettings } from "../../config/defaults.ts";
import { listBackupsByGuild } from "../../db/queries/backups.ts";
import { listActiveGuilds } from "../../db/queries/guilds.ts";
import { listJobsByGuild } from "../../db/queries/jobs.ts";
import { deleteEventsBefore } from "../../db/queries/tracked-events.ts";
import { listDueRecords } from "../../db/queries/verify-records.ts";
import type { BackupRow, Database, JobKind, JobRow } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import { sweepExpiredExports } from "../export/sweep.ts";
import type { JobHandler, JobRunner } from "../jobs/runner.ts";
import { DEFAULT_RESTORE_OPTIONS } from "../restore/types.ts";
import { sweepExpiredStates } from "../state-sweep.ts";
import { refreshDue } from "../verify/refresh.ts";
import {
  counterResetAt,
  resetOldCounters,
  sweepOrphanWebhooks,
  utcDay,
  WEBHOOK_SWEEP_INTERVAL_MS,
  type WebhookPort,
} from "./sweeps.ts";

export interface SchedulerOptions {
  readonly db: Database;
  readonly log: Logger;
  readonly jobs: JobRunner;
  /** the whole automation is off. a pure manual deployment sets this false. */
  readonly enabled: boolean;
  /** how often the tick runs, in ms. 0 disables the timer (the tests use it). */
  readonly tickMs?: number;
  readonly now?: () => number;
  /** refreshes the token of one user. without it the refresh job is neither
   *  registered nor enqueued, because there is nothing to refresh with. */
  readonly refresh?: (userId: string) => Promise<boolean>;
  /** discord's webhooks and channels, for the orphan sweep. without it the
   *  sweep does not run. */
  readonly webhooks?: WebhookPort;
}

export interface Scheduler {
  /** run the tick now, and report what it did. */
  tick(): Promise<TickResult>;
  start(): void;
  stop(): void;
}

export interface TickResult {
  /** the work the tick found due. */
  readonly due: number;
  /** the work the tick handed to the runner. */
  readonly enqueued: number;
  /** what was swept, and how much. */
  readonly swept: {
    readonly states: number;
    readonly exports: number;
    readonly counters: number;
    readonly webhooks: number;
    /** the timeline rows past the guild's keep_days (19.5). */
    readonly tracking: number;
  };
  /** the token refresh: the records that were due, and the jobs that went out. */
  readonly refresh: { readonly due: number; readonly enqueued: number };
  /** the auto restores that were enqueued. */
  readonly restores: number;
}

const DEFAULT_TICK_MS = 15_000;
/** how many records one refresh sweep looks at. the same ceiling the sweep
 *  itself uses. */
const REFRESH_BATCH = 1_000;

function emptyResult(): TickResult {
  return {
    due: 0,
    enqueued: 0,
    swept: { states: 0, exports: 0, counters: 0, webhooks: 0, tracking: 0 },
    refresh: { due: 0, enqueued: 0 },
    restores: 0,
  };
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // the day the counter reset last ran, and when the webhooks were last swept.
  // both are caches of an idempotent job: losing them costs one extra run.
  let lastResetDay: string | null = null;
  let lastWebhookSweep: number | null = null;
  let lastTrackingDay: string | null = null;

  // the refresh job is ours: the tick enqueues it, the handler runs the sweep
  // over the guild's records (D4PLAN 13.5).
  if (options.refresh !== undefined) {
    options.jobs.register(
      "verify_refresh",
      refreshJobHandler({
        db: options.db,
        log: options.log,
        refresh: options.refresh,
        now,
      }),
    );
  }

  // the counter reset runs once a day, at 00:05 utc.
  const maybeResetCounters = async (at: number): Promise<number> => {
    const day = utcDay(at);
    if (at < counterResetAt(at) || lastResetDay === day) return 0;
    const removed = await resetOldCounters(options.db, at);
    lastResetDay = day;
    return removed;
  };

  // the orphan webhook sweep runs at startup and every six hours after that.
  const maybeSweepWebhooks = async (at: number): Promise<number> => {
    if (options.webhooks === undefined) return 0;
    if (lastWebhookSweep !== null && at - lastWebhookSweep < WEBHOOK_SWEEP_INTERVAL_MS) {
      return 0;
    }
    const guilds = await listActiveGuilds(options.db);
    const result = await sweepOrphanWebhooks({
      db: options.db,
      log: options.log,
      port: options.webhooks,
      guildIds: guilds.map((row) => row.guild_id),
    });
    lastWebhookSweep = at;
    return result.deleted;
  };

  // the timeline's own retention (19.5): once a day, in the same tick as the
  // backups, its count reported on its own.
  const maybeSweepTracking = async (at: number): Promise<number> => {
    const day = utcDay(at);
    if (lastTrackingDay === day) return 0;
    const guilds = await listSchedulableGuilds(options.db);
    let removed = 0;
    for (const guild of guilds) {
      if (guild.trackedKeepDays === null) continue;
      const cutoff = new Date(at - guild.trackedKeepDays * 86_400_000).toISOString();
      removed += await deleteEventsBefore(options.db, guild.guildId, cutoff);
    }
    lastTrackingDay = day;
    return removed;
  };

  const tick = async (): Promise<TickResult> => {
    if (!options.enabled) {
      return emptyResult();
    }
    // one tick at a time: a slow tick must not overlap the next one.
    if (running) return emptyResult();
    running = true;
    try {
      const at = now();
      const expired = await sweepExpiredExports(options.db, at, options.log);
      const states = await sweepExpiredStates(options.db, at);
      const counters = await maybeResetCounters(at);
      const webhooks = await maybeSweepWebhooks(at);
      const tracking = await maybeSweepTracking(at);

      // the due work: an auto backup per guild, an auto restore after a
      // successful backup, and the token refresh sweep. each one is a job row,
      // so it survives a restart.
      const due = await dueWork(options.db, at, options.refresh !== undefined);
      let enqueued = 0;
      let refreshEnqueued = 0;
      let restores = 0;
      for (const item of due.items) {
        await options.jobs.enqueue(item.kind, {
          guildId: item.guildId,
          requestedBy: item.requestedBy,
          payload: item.payload,
        });
        enqueued += 1;
        if (item.kind === "verify_refresh") refreshEnqueued += 1;
        if (item.kind === "restore") restores += 1;
      }

      const result: TickResult = {
        due: due.items.length,
        enqueued,
        swept: { states, exports: expired.removed, counters, webhooks, tracking },
        refresh: { due: due.refreshRecords, enqueued: refreshEnqueued },
        restores,
      };
      options.log.info("the scheduler tick finished", {
        due: result.due,
        enqueued: result.enqueued,
        states: result.swept.states,
        exports: result.swept.exports,
        counters: result.swept.counters,
        webhooks: result.swept.webhooks,
        tracking: result.swept.tracking,
        refreshRecords: result.refresh.due,
        restores: result.restores,
      });
      return result;
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (timer !== null || !options.enabled || tickMs <= 0) return;
      timer = setInterval(() => {
        void tick().catch((error: unknown) => {
          options.log.error("the scheduler tick threw", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, tickMs);
      // the timer must not hold the process open.
      timer.unref?.();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

// the refresh job. it is the sweep the tick enqueues: the records of one guild
// whose access token has expired, refreshed one user at a time.
function refreshJobHandler(deps: {
  readonly db: Database;
  readonly log: Logger;
  readonly refresh: (userId: string) => Promise<boolean>;
  readonly now: () => number;
}): JobHandler {
  return async (ctx) => {
    const payload = ctx.job.payload_json ?? {};
    const guildId = typeof payload.guildId === "string" ? payload.guildId : undefined;
    const result = await refreshDue(
      {
        db: deps.db,
        log: deps.log,
        refresh: deps.refresh,
        now: deps.now,
        guildId,
      },
      REFRESH_BATCH,
    );
    ctx.log.info("the token refresh sweep finished", {
      guildId: guildId ?? "every guild",
      refreshed: result.refreshed,
      failed: result.failed,
    });
  };
}

interface DueWork {
  readonly kind: "backup" | "restore" | "verify_refresh";
  readonly guildId: string;
  readonly requestedBy: string;
  readonly payload: Record<string, unknown>;
}

interface DueWorkResult {
  readonly items: readonly DueWork[];
  /** the records whose token was due. */
  readonly refreshRecords: number;
}

/**
 * the work the tick found due. it is read from the database: the guilds' own
 * settings say when the next auto backup is, the last backup row says when the
 * last one ran, and the records say whose token has expired.
 */
async function dueWork(db: Database, now: number, canRefresh: boolean): Promise<DueWorkResult> {
  const guilds = await listSchedulableGuilds(db);
  const items: DueWork[] = [];

  for (const guild of guilds) {
    const backups = await listBackupsByGuild(db, guild.guildId);
    const jobs = await listJobsByGuild(db, guild.guildId);

    // the auto backup, on the guild's own interval.
    if (guild.autoBackupEnabled) {
      const last = ranAt(backups[0]);
      const intervalMs = guild.intervalHours * 3_600_000;
      if (last === null || now - last >= intervalMs) {
        items.push({
          kind: "backup",
          guildId: guild.guildId,
          requestedBy: guild.ownerId,
          payload: { kind: "auto", label: null },
        });
      }
    }

    // the auto restore, once a backup has succeeded.
    if (guild.autoRestoreEnabled) {
      const restore = autoRestore(guild, jobs, restorableBackup(backups));
      if (restore !== null) items.push(restore);
    }
  }

  // the token refresh sweep: the records whose access token has expired.
  const refreshRecords = await dueRefreshGuilds(db, now, guilds, items, canRefresh);

  return { items, refreshRecords };
}

/** the guilds whose records have an expired token, and the refresh jobs for
 *  them. a guild that already has one waiting does not get a second. */
async function dueRefreshGuilds(
  db: Database,
  now: number,
  guilds: readonly SchedulableGuild[],
  items: DueWork[],
  canRefresh: boolean,
): Promise<number> {
  const at = new Date(now).toISOString();
  const records = await listDueRecords(db, at, REFRESH_BATCH);
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.guild_id, (counts.get(record.guild_id) ?? 0) + 1);
  }

  let total = 0;
  for (const [guildId, count] of counts) {
    total += count;
    // without a refresh callback there is nothing to refresh with, so the
    // record is reported and no job is queued for a handler that cannot exist.
    if (!canRefresh) continue;
    if (await hasPendingJob(db, guildId, "verify_refresh")) continue;
    const guild = guilds.find((row) => row.guildId === guildId);
    items.push({
      kind: "verify_refresh",
      guildId,
      requestedBy: guild?.ownerId ?? "",
      payload: { guildId },
    });
  }
  return total;
}

/** the auto restore of a guild that asked for one. a restore that was queued
 *  after the backup already covers it, so the backup is not replayed twice. */
function autoRestore(
  guild: SchedulableGuild,
  jobs: readonly JobRow[],
  backup: BackupRow | null,
): DueWork | null {
  if (backup === null) return null;
  // created_at is iso-8601 text, so string order is time order.
  const restore = jobs.find((job) => job.kind === "restore");
  if (restore !== undefined && restore.created_at >= backup.created_at) return null;
  return {
    kind: "restore",
    guildId: guild.guildId,
    requestedBy: guild.ownerId,
    payload: {
      backupId: backup.backup_id,
      targetId: guild.guildId,
      // the guild's own restore defaults. the operator set them for this
      // guild, so the automatic restore uses them too.
      options: {
        ...DEFAULT_RESTORE_OPTIONS,
        clearBefore: guild.restoreClearBefore,
        timestampSuffix: guild.restoreTimestampSuffix,
      },
    },
  };
}

/** the backup an auto restore would replay. a pre_restore backup is the one a
 *  restore took for itself, so it is not a thing to restore from. */
function restorableBackup(backups: readonly BackupRow[]): BackupRow | null {
  for (const row of backups) {
    if (row.kind === "manual" || row.kind === "auto") return row;
  }
  return null;
}

/** when a backup ran, in epoch ms, or null when the row says nothing usable. */
function ranAt(row: BackupRow | undefined): number | null {
  if (row === undefined) return null;
  const at = Date.parse(row.created_at);
  return Number.isFinite(at) ? at : null;
}

/** a job of this kind that is still queued or running. */
async function hasPendingJob(db: Database, guildId: string, kind: JobKind): Promise<boolean> {
  const jobs = await listJobsByGuild(db, guildId);
  return jobs.some(
    (job) => job.kind === kind && (job.status === "queued" || job.status === "running"),
  );
}

interface SchedulableGuild {
  readonly guildId: string;
  readonly ownerId: string;
  readonly autoBackupEnabled: boolean;
  readonly autoRestoreEnabled: boolean;
  readonly restoreClearBefore: boolean;
  readonly restoreTimestampSuffix: boolean;
  readonly intervalHours: number;
  /** the timeline's retention window in days, or null to keep everything. */
  readonly trackedKeepDays: number | null;
}

async function listSchedulableGuilds(db: Database): Promise<SchedulableGuild[]> {
  const rows = await listActiveGuilds(db);
  const out: SchedulableGuild[] = [];
  for (const row of rows) {
    const settings = row.settings_json;
    const read = settings === null ? readGuildSettings(undefined) : readGuildSettings(settings);
    out.push({
      guildId: row.guild_id,
      ownerId: row.owner_user_id ?? "",
      autoBackupEnabled: read.auto_backup_enabled,
      autoRestoreEnabled: read.auto_restore_enabled,
      restoreClearBefore: read.restore_clear_before,
      restoreTimestampSuffix: read.restore_message_timestamp_suffix,
      intervalHours: read.auto_backup_interval_hours,
      trackedKeepDays: read.tracking.keep_days,
    });
  }
  return out;
}
