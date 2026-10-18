// services/jobs/runner.ts (D4PLAN 4.1, 17.1).
//
// the job runner: one queue, one pump, one handler per kind. a long operation
// enqueues a row and returns; the pump runs it while honouring two limits. at
// most maxConcurrentJobs across all guilds, and at most one job per guild,
// because two restores into one guild fight over channel names and two backups
// of one guild are pointless (D4PLAN 4.1).
//
// everything is injected: the clock, the database, the logger. no module-level
// mutable state, so a test builds a runner and drives it with no timer.
//
// control is cooperative. cancel and pause set a flag the handler polls at its
// checkpoints; the handler returns, then the runner writes the terminal status.
// a status is never written while a handler is still running, so a handler that
// never checks the flag is not reported cancelled until it actually stopped.

import {
  getJob,
  insertJob,
  listJobProgress,
  listResumableJobs,
  setJobStatus,
  updateJob,
  upsertJobProgress,
} from "../../db/queries/jobs.ts";
import type {
  Database,
  JobKind,
  JobProgressRow,
  JobRow,
  JobStatus,
  JsonObject,
} from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { LogFields, Logger } from "../../lib/log.ts";

/** the flags a handler polls. cancel and pause set one; the handler returns. */
export interface JobSignal {
  cancelled: boolean;
  paused: boolean;
}

/** one checkpoint's progress. total is null while paginating has no fixed end. */
export interface JobCounts {
  done: number;
  total: number | null;
}

/** what a handler is handed: the row, the flag, a logger, and a checkpoint. */
export interface JobContext {
  readonly job: JobRow;
  readonly signal: JobSignal;
  readonly log: Logger;
  /** persists to job_progress (upsert), so a restart resumes at this step. */
  checkpoint(step: string, counts: JobCounts): Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface JobRunnerOptions {
  readonly db: Database;
  readonly log: Logger;
  /** injectable clock in epoch ms. defaults to Date.now. */
  readonly now?: () => number;
  /** jobs across all guilds that may run at once. defaults to 2 (D4PLAN 4.1). */
  readonly maxConcurrentJobs?: number;
  /** how often to pump for externally-queued jobs, in ms. 0 disables the timer. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_POLL_MS = 1_000;

// one fixed message per SB_ code we raise (AGENTS.md errors). a handler failure
// that is not discord's and not already an SB_ error becomes SB_JOB_FAILED.
const JOB_MESSAGES = {
  SB_JOB_FAILED: "SB_JOB_FAILED: the job handler threw, the stack is in the log line",
  SB_JOB_NO_HANDLER: "SB_JOB_NO_HANDLER: no handler is registered for this job kind",
  SB_JOB_DISCORD_ERROR: "SB_JOB_DISCORD_ERROR: discord rejected a request with no code in the body",
} as const;

/** a stored failure: an error_code and the error_body behind it. */
interface JobFailure {
  code: string;
  body: string;
}

// a failure carries discord's own words, or one of our fixed SB_ messages. a
// discord error keeps discord's code and its code+message verbatim (D4PLAN
// 18.1); our own errors keep their SB_ code; anything else is SB_JOB_FAILED,
// never the thrown string, which could carry anything.
function describeFailure(error: unknown): JobFailure {
  if (error instanceof DiscordApiError) {
    const report = formatDiscordError(error);
    return {
      code: error.code === null ? "SB_JOB_DISCORD_ERROR" : String(error.code),
      body: report.said,
    };
  }
  const code = sbCodeOf(error);
  if (code !== null) {
    return { code, body: error instanceof Error ? error.message : code };
  }
  return { code: "SB_JOB_FAILED", body: JOB_MESSAGES.SB_JOB_FAILED };
}

// an error that already names itself with an SB_ code (DbError, DiscordClientError,
// RowError). its message is our fixed wording, so it is safe to store.
function sbCodeOf(error: unknown): string | null {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.startsWith("SB_")) return code;
  }
  return null;
}

// the logger has no child(); this is one, prefixing every line with the job so a
// job's lines are greppable together. fields are merged, the job's win on a clash.
function childLogger(parent: Logger, base: LogFields): Logger {
  return {
    get level() {
      return parent.level;
    },
    debug: (msg, fields) => parent.debug(msg, { ...base, ...fields }),
    info: (msg, fields) => parent.info(msg, { ...base, ...fields }),
    warn: (msg, fields) => parent.warn(msg, { ...base, ...fields }),
    error: (msg, fields) => parent.error(msg, { ...base, ...fields }),
    flush: () => parent.flush(),
  };
}

export class JobRunner {
  readonly #db: Database;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #max: number;
  readonly #pollIntervalMs: number;

  readonly #handlers = new Map<JobKind, JobHandler>();
  // queued jobs, oldest first. a job is removed when it starts or is cancelled.
  readonly #queue: JobRow[] = [];
  readonly #running = new Set<string>();
  readonly #runningGuilds = new Set<string>();
  readonly #signals = new Map<string, JobSignal>();

  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;

  constructor(options: JobRunnerOptions) {
    this.#db = options.db;
    this.#log = options.log;
    this.#now = options.now ?? (() => Date.now());
    this.#max = Math.max(1, options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT);
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  /** one handler per kind. re-registering replaces, so boot is idempotent. */
  register(kind: JobKind, handler: JobHandler): void {
    this.#handlers.set(kind, handler);
  }

  /** inserts a queued job and wakes the pump. never fails on a busy guild; it waits. */
  async enqueue(
    kind: JobKind,
    input: { guildId: string; requestedBy: string; payload?: JsonObject | null },
  ): Promise<JobRow> {
    const job: JobRow = {
      id: Bun.randomUUIDv7(),
      guild_id: input.guildId,
      kind,
      status: "queued",
      requested_by: input.requestedBy,
      payload_json: input.payload ?? null,
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: this.#iso(),
      started_at: null,
      finished_at: null,
      attempts: 0,
    };
    await insertJob(this.#db, job);
    this.#queue.push(job);
    this.#pump();
    return job;
  }

  /**
   * cooperative cancel. a running handler is flagged and records cancelled when
   * it returns at its next checkpoint; a handler that never checks the flag is
   * still not reported cancelled until it stopped. a queued or paused job is
   * cancelled outright.
   */
  async cancel(jobId: string): Promise<void> {
    const signal = this.#signals.get(jobId);
    if (signal !== undefined) {
      signal.cancelled = true;
      return;
    }
    if (this.#dequeue(jobId)) {
      await setJobStatus(this.#db, jobId, "cancelled");
      return;
    }
    const job = await getJob(this.#db, jobId);
    if (job !== null && job.status === "paused") {
      await setJobStatus(this.#db, jobId, "cancelled");
    }
  }

  /** cooperative pause. the progress rows are kept, so a resume continues. */
  async pause(jobId: string): Promise<void> {
    const signal = this.#signals.get(jobId);
    if (signal !== undefined) {
      signal.paused = true;
      return;
    }
    if (this.#dequeue(jobId)) {
      await setJobStatus(this.#db, jobId, "paused");
    }
  }

  /** re-queues a paused job. the handler reads its last checkpoint and continues. */
  async resume(jobId: string): Promise<void> {
    const job = await getJob(this.#db, jobId);
    if (job === null || job.status !== "paused") return;
    await setJobStatus(this.#db, jobId, "queued");
    job.status = "queued";
    this.#queue.push(job);
    this.#pump();
  }

  /**
   * boot. every resumable job (queued, running, paused) is re-queued and runs
   * again from its last checkpoint. a job whose kind has no handler fails here
   * rather than sitting queued forever.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    for (const job of await listResumableJobs(this.#db)) {
      // a job left running by a crash, or paused, waits its turn as queued again.
      if (job.status !== "queued") {
        await setJobStatus(this.#db, job.id, "queued");
        job.status = "queued";
      }
      if (!this.#queue.some((queued) => queued.id === job.id)) this.#queue.push(job);
    }
    if (this.#pollIntervalMs > 0 && this.#timer === undefined) {
      this.#timer = setInterval(() => this.#pump(), this.#pollIntervalMs);
      // never hold the process open for a poll that the queue already triggers.
      this.#timer.unref();
    }
    this.#pump();
  }

  /** clears the poll timer and stops accepting new work, so a test can end. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * seconds left, or null. from the elapsed time and done/total on the latest
   * progress row (D4PLAN 9.4). null before a first checkpoint, when the total is
   * not yet known, or when nothing has completed to base a rate on.
   */
  async eta(jobId: string): Promise<number | null> {
    const job = await getJob(this.#db, jobId);
    if (job === null || job.started_at === null) return null;
    const rows = await listJobProgress(this.#db, jobId);
    let latest: JobProgressRow | undefined;
    for (const row of rows) {
      if (latest === undefined || row.updated_at > latest.updated_at) latest = row;
    }
    if (latest === undefined) return null;

    const done = latest.done_count;
    // checkpoint stores a null total as 0, and a rate off a zero total is noise.
    const total = latest.total_count;
    if (done <= 0 || total <= 0) return null;
    if (done >= total) return 0;

    const startedAt = Date.parse(job.started_at);
    if (Number.isNaN(startedAt)) return null;
    const elapsedMs = this.#now() - startedAt;
    if (elapsedMs <= 0) return null;

    // linear estimate: the work so far, extended to the whole.
    return Math.round(((elapsedMs / done) * (total - done)) / 1_000);
  }

  #dequeue(jobId: string): boolean {
    const index = this.#queue.findIndex((job) => job.id === jobId);
    if (index === -1) return false;
    this.#queue.splice(index, 1);
    return true;
  }

  // one pump, not a timer per job. it starts what the two limits allow and
  // returns; a finished job calls it again to pick up whatever it unblocked.
  #pump(): void {
    if (this.#stopped) return;
    for (;;) {
      if (this.#running.size >= this.#max) return;
      const index = this.#queue.findIndex((job) => !this.#runningGuilds.has(job.guild_id));
      if (index === -1) return;
      const job = this.#queue.splice(index, 1)[0];
      if (job === undefined) return;

      const handler = this.#handlers.get(job.kind);
      if (handler === undefined) {
        void this.#failUnregistered(job);
        continue;
      }
      this.#start(job, handler);
    }
  }

  #start(job: JobRow, handler: JobHandler): void {
    const signal: JobSignal = { cancelled: false, paused: false };
    // mark the guild and the slot busy before the first await, so the next pump
    // pass cannot double-start the same guild.
    this.#signals.set(job.id, signal);
    this.#running.add(job.id);
    this.#runningGuilds.add(job.guild_id);
    void this.#execute(job, handler, signal);
  }

  async #execute(job: JobRow, handler: JobHandler, signal: JobSignal): Promise<void> {
    const log = childLogger(this.#log, { job: job.id, kind: job.kind, guild: job.guild_id });
    try {
      await this.#markRunning(job);
      const ctx: JobContext = {
        job,
        signal,
        log,
        checkpoint: (step, counts) => this.#checkpoint(job, step, counts),
      };
      log.info("job started", { attempt: job.attempts });
      await handler(ctx);

      if (signal.cancelled) {
        await this.#settle(job, "cancelled", null);
      } else if (signal.paused) {
        // keep the progress rows; a resume continues from the last checkpoint.
        await setJobStatus(this.#db, job.id, "paused");
        job.status = "paused";
      } else {
        await this.#settle(job, "succeeded", null);
      }
    } catch (error) {
      const failure = describeFailure(error);
      log.error("job failed", { code: failure.code, said: failure.body, error });
      await this.#settle(job, "failed", failure);
    } finally {
      this.#signals.delete(job.id);
      this.#running.delete(job.id);
      this.#runningGuilds.delete(job.guild_id);
      this.#pump();
    }
  }

  async #markRunning(job: JobRow): Promise<void> {
    job.status = "running";
    job.attempts += 1; // every start counts, including a resume (D4PLAN 4.1)
    if (job.started_at === null) job.started_at = this.#iso();
    await updateJob(this.#db, job);
  }

  // updateJob persists finished_at and the error columns. setJobStatus is the one
  // place the terminal status is written, so a reader watching the status column
  // never sees a job mid-transition (D4PLAN 4.1).
  async #settle(job: JobRow, status: JobStatus, failure: JobFailure | null): Promise<void> {
    if (failure !== null) {
      job.error_code = failure.code;
      job.error_body = failure.body;
    }
    job.finished_at = this.#iso();
    await updateJob(this.#db, job);
    await setJobStatus(this.#db, job.id, status);
    job.status = status;
  }

  async #failUnregistered(job: JobRow): Promise<void> {
    this.#log.warn("job has no registered handler", { job: job.id, kind: job.kind });
    await this.#settle(job, "failed", {
      code: "SB_JOB_NO_HANDLER",
      body: JOB_MESSAGES.SB_JOB_NO_HANDLER,
    });
  }

  async #checkpoint(job: JobRow, step: string, counts: JobCounts): Promise<void> {
    await upsertJobProgress(this.#db, {
      job_id: job.id,
      step,
      cursor: null,
      done_count: counts.done,
      total_count: counts.total ?? 0,
      updated_at: this.#iso(),
    });
  }
}
