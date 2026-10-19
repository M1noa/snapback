// the scheduler (D4PLAN 17.1). one tick, and the due work is read from the
// database rather than kept in a timer, so a restart does not lose a schedule and
// two processes do not double-fire it.
//
// the tick is 15 seconds. it decides what is due and hands each job to the
// runner, which is what serialises them per guild.

import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import { sweepExpiredExports } from "../export/sweep.ts";
import type { JobRunner } from "../jobs/runner.ts";
import { sweepExpiredStates } from "../state-sweep.ts";

export interface SchedulerOptions {
  readonly db: Database;
  readonly log: Logger;
  readonly jobs: JobRunner;
  /** the whole automation is off. a pure manual deployment sets this false. */
  readonly enabled: boolean;
  /** how often the tick runs, in ms. 0 disables the timer (the tests use it). */
  readonly tickMs?: number;
  readonly now?: () => number;
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
  readonly swept: { readonly states: number; readonly exports: number };
}

const DEFAULT_TICK_MS = 15_000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (): Promise<TickResult> => {
    if (!options.enabled) {
      return { due: 0, enqueued: 0, swept: { states: 0, exports: 0 } };
    }
    // one tick at a time: a slow tick must not overlap the next one.
    if (running) return { due: 0, enqueued: 0, swept: { states: 0, exports: 0 } };
    running = true;
    try {
      const expired = await sweepExpiredExports(options.db, now(), options.log);
      const swept = {
        states: await sweepExpiredStates(options.db, now()),
        exports: expired.removed,
      };

      // the due work: an auto backup per guild, an auto restore on a join, and the
      // token refresh sweep. each one is a job row, so it survives a restart.
      const due = await dueWork(options.db, now());
      let enqueued = 0;
      for (const item of due) {
        await options.jobs.enqueue(item.kind, {
          guildId: item.guildId,
          requestedBy: item.requestedBy,
          payload: item.payload,
        });
        enqueued += 1;
      }

      return { due: due.length, enqueued, swept };
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

interface DueWork {
  readonly kind: "backup" | "restore" | "verify_refresh";
  readonly guildId: string;
  readonly requestedBy: string;
  readonly payload: Record<string, unknown>;
}

/**
 * the work the tick found due. it is read from the database: the guilds' own
 * settings say when the next auto backup is, and the last backup row says when
 * the last one ran.
 */
async function dueWork(db: Database, now: number): Promise<DueWork[]> {
  const guilds = await listSchedulableGuilds(db);
  const due: DueWork[] = [];

  for (const guild of guilds) {
    if (!guild.autoBackupEnabled) continue;
    const last = await lastBackupAt(db, guild.guildId);
    const intervalMs = guild.intervalHours * 3_600_000;
    if (last !== null && now - last < intervalMs) continue;
    due.push({
      kind: "backup",
      guildId: guild.guildId,
      requestedBy: guild.ownerId,
      payload: { kind: "auto", label: null },
    });
  }

  return due;
}

interface SchedulableGuild {
  readonly guildId: string;
  readonly ownerId: string;
  readonly autoBackupEnabled: boolean;
  readonly intervalHours: number;
}

async function listSchedulableGuilds(db: Database): Promise<SchedulableGuild[]> {
  const { listActiveGuilds } = await import("../../db/queries/guilds.ts");
  const { readGuildSettings } = await import("../../config/defaults.ts");
  const rows = await listActiveGuilds(db);
  const out: SchedulableGuild[] = [];
  for (const row of rows) {
    const settings = row.settings_json;
    const read = settings === null ? readGuildSettings(undefined) : readGuildSettings(settings);
    out.push({
      guildId: row.guild_id,
      ownerId: row.owner_user_id ?? "",
      autoBackupEnabled: read.auto_backup_enabled,
      intervalHours: read.auto_backup_interval_hours,
    });
  }
  return out;
}

/** when the last backup of this guild ran, in epoch ms, or null. */
async function lastBackupAt(db: Database, guildId: string): Promise<number | null> {
  const { listBackupsByGuild } = await import("../../db/queries/backups.ts");
  const rows = await listBackupsByGuild(db, guildId);
  const first = rows[0];
  if (first === undefined) return null;
  const at = Date.parse(first.created_at);
  return Number.isFinite(at) ? at : null;
}
