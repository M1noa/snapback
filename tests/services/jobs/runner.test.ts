// the job runner against a real temp-file duckdb, the idiom of
// tests/db/backup-queries.test.ts. the stub handler resolves when the test says
// so, which is what makes the concurrency limits observable: a job that has
// started but not returned sits in the running state until the test releases it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbError, openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import { getJob, getJobProgress, insertJob } from "../../../src/db/queries/jobs.ts";
import type { Database, JobRow } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger, type Logger } from "../../../src/lib/log.ts";
import { sleep } from "../../../src/lib/sleep.ts";
import {
  type JobContext,
  type JobHandler,
  JobRunner,
  type JobRunnerOptions,
} from "../../../src/services/jobs/runner.ts";

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-jobs-runner-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM job_progress");
  await db.run("DELETE FROM jobs");
});

// the file sink is off (dir: null) and only errors reach stderr, so a green run
// stays quiet.
function makeLog(): Logger {
  return createLogger({ level: "error", dir: null });
}

// pollIntervalMs 0 disables the pump timer, so a test drives the queue itself.
function makeRunner(options: Partial<Omit<JobRunnerOptions, "db" | "log">> = {}): JobRunner {
  return new JobRunner({ db, log: makeLog(), pollIntervalMs: 0, ...options });
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// a handler that starts, records itself, and waits for the test to release it.
interface Started {
  id: string;
  ctx: JobContext;
  release: () => void;
}

function gated(): { handler: JobHandler; started: Started[] } {
  const started: Started[] = [];
  const handler: JobHandler = async (ctx) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    started.push({ id: ctx.job.id, ctx, release });
    await gate;
  };
  return { handler, started };
}

function makeJobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: Bun.randomUUIDv7(),
    guild_id: "1",
    kind: "backup",
    status: "queued",
    requested_by: "9",
    payload_json: null,
    progress_json: null,
    error_code: null,
    error_body: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    attempts: 0,
    ...overrides,
  };
}

describe("job runner", () => {
  test("one job per guild: a second enqueue waits for the first to finish", async () => {
    const runner = makeRunner({ maxConcurrentJobs: 2 });
    const { handler, started } = gated();
    runner.register("backup", handler);

    const first = await runner.enqueue("backup", { guildId: "1", requestedBy: "9" });
    const second = await runner.enqueue("backup", { guildId: "1", requestedBy: "9" });

    await waitFor(() => started.length >= 1, "the first job to start");
    await sleep(20);
    // the guild is busy, so the second is still queued, not failed, not parallel
    expect(started.map((s) => s.id)).toEqual([first.id]);
    expect((await getJob(db, second.id))?.status).toBe("queued");

    started[0]?.release();
    await waitFor(() => started.length === 2, "the second job to start");
    expect(started[1]?.id).toBe(second.id);

    started[1]?.release();
    await waitFor(
      async () => (await getJob(db, second.id))?.status === "succeeded",
      "the second job to finish",
    );
  });

  test("the global cap: no more than maxConcurrentJobs run at once", async () => {
    const runner = makeRunner({ maxConcurrentJobs: 2 });
    const { handler, started } = gated();
    runner.register("backup", handler);

    const jobs = await Promise.all([
      runner.enqueue("backup", { guildId: "1", requestedBy: "9" }),
      runner.enqueue("backup", { guildId: "2", requestedBy: "9" }),
      runner.enqueue("backup", { guildId: "3", requestedBy: "9" }),
    ]);

    await waitFor(() => started.length >= 2, "two jobs to start");
    await sleep(20);
    expect(started).toHaveLength(2);

    started[0]?.release();
    await waitFor(() => started.length === 3, "the third job to start");
    expect(started).toHaveLength(3);

    for (const entry of started) entry.release();
    const last = jobs[2];
    expect(last).toBeDefined();
    if (last === undefined) return;
    await waitFor(
      async () => (await getJob(db, last.id))?.status === "succeeded",
      "the third job to finish",
    );
  });

  test("a clean return records succeeded", async () => {
    const runner = makeRunner();
    runner.register("backup", async () => {});
    const job = await runner.enqueue("backup", { guildId: "1", requestedBy: "9" });

    await waitFor(
      async () => (await getJob(db, job.id))?.status === "succeeded",
      "the job to succeed",
    );
    const got = await getJob(db, job.id);
    expect(got?.status).toBe("succeeded");
    expect(got?.finished_at).not.toBeNull();
    expect(got?.error_code).toBeNull();
  });

  test("a throw records failed and keeps discord's own words", async () => {
    const runner = makeRunner();
    const apiError = new DiscordApiError({
      status: 400,
      route: "/channels/1/messages",
      method: "POST",
      body: JSON.stringify({ code: 50035, message: "Invalid Form Body" }),
    });
    runner.register("restore", async () => {
      throw apiError;
    });
    const job = await runner.enqueue("restore", { guildId: "1", requestedBy: "9" });

    await waitFor(async () => (await getJob(db, job.id))?.status === "failed", "the job to fail");
    const got = await getJob(db, job.id);
    expect(got?.status).toBe("failed");
    expect(got?.error_code).toBe("50035");
    expect(got?.error_body).toContain("50035");
    expect(got?.error_body).toContain("Invalid Form Body");
  });

  test("a failure that is not discord's becomes SB_JOB_FAILED, an SB_ error keeps its code", async () => {
    const runner = makeRunner();
    runner.register("export", async () => {
      throw new Error("boom");
    });
    runner.register("pull", async () => {
      throw new DbError("SB_DB_LOCKED");
    });

    const plain = await runner.enqueue("export", { guildId: "1", requestedBy: "9" });
    const named = await runner.enqueue("pull", { guildId: "2", requestedBy: "9" });

    await waitFor(async () => (await getJob(db, plain.id))?.status === "failed", "plain failure");
    await waitFor(async () => (await getJob(db, named.id))?.status === "failed", "named failure");

    // never the thrown string, which could carry anything
    const plainRow = await getJob(db, plain.id);
    expect(plainRow?.error_code).toBe("SB_JOB_FAILED");
    expect(plainRow?.error_body).not.toContain("boom");

    const namedRow = await getJob(db, named.id);
    expect(namedRow?.error_code).toBe("SB_DB_LOCKED");
    expect(namedRow?.error_body).toContain("SB_DB_LOCKED");
  });

  test("cancel records cancelled once the handler stops at a checkpoint", async () => {
    const runner = makeRunner();
    let observed = false;
    runner.register("restore", async (ctx) => {
      for (let i = 0; i < 1_000; i++) {
        if (ctx.signal.cancelled) {
          observed = true;
          return;
        }
        await ctx.checkpoint("step", { done: i, total: 1_000 });
        await sleep(1);
      }
    });

    const job = await runner.enqueue("restore", { guildId: "1", requestedBy: "9" });
    await waitFor(
      async () => ((await getJobProgress(db, job.id, "step"))?.done_count ?? 0) >= 2,
      "a couple of checkpoints",
    );

    await runner.cancel(job.id);
    // the status is not cancelled while the handler runs; it is written once it stops
    await waitFor(
      async () => (await getJob(db, job.id))?.status === "cancelled",
      "the job to be cancelled",
    );
    expect(observed).toBe(true);
    expect((await getJob(db, job.id))?.status).toBe("cancelled");
  });

  test("pause holds the progress and resume continues from the last checkpoint", async () => {
    const runner = makeRunner();
    const startsSeen: number[] = [];
    runner.register("backup", async (ctx) => {
      const existing = await getJobProgress(db, ctx.job.id, "scan");
      const start = existing?.done_count ?? 0;
      startsSeen.push(start);
      for (let done = start; done < 10; done += 1) {
        await ctx.checkpoint("scan", { done: done + 1, total: 10 });
        await sleep(2);
        if (ctx.signal.paused || ctx.signal.cancelled) return;
      }
    });

    const job = await runner.enqueue("backup", { guildId: "1", requestedBy: "9" });
    await waitFor(
      async () => ((await getJobProgress(db, job.id, "scan"))?.done_count ?? 0) >= 2,
      "the run to make progress",
    );

    await runner.pause(job.id);
    await waitFor(async () => (await getJob(db, job.id))?.status === "paused", "the job to pause");

    // the checkpoint survived the pause, short of the total
    const held = await getJobProgress(db, job.id, "scan");
    expect(held).not.toBeNull();
    expect(held?.done_count ?? 0).toBeGreaterThan(0);
    expect(held?.done_count ?? 10).toBeLessThan(10);

    await runner.resume(job.id);
    await waitFor(
      async () => (await getJob(db, job.id))?.status === "succeeded",
      "the job to complete after resume",
    );

    expect(startsSeen).toHaveLength(2);
    // the second run read the stored progress, it did not restart from zero
    expect(startsSeen[1] ?? 0).toBeGreaterThan(0);
    expect((await getJobProgress(db, job.id, "scan"))?.done_count).toBe(10);
    expect((await getJob(db, job.id))?.attempts).toBe(2);
  });

  test("start re-queues a job left running and it runs again", async () => {
    const leftover = makeJobRow({ status: "running", attempts: 1, started_at: "x" });
    await insertJob(db, leftover);

    const runner = makeRunner();
    let ran = false;
    runner.register("backup", async () => {
      ran = true;
    });

    await runner.start();
    await waitFor(
      async () => (await getJob(db, leftover.id))?.status === "succeeded",
      "the resumed job to finish",
    );
    expect(ran).toBe(true);
    expect((await getJob(db, leftover.id))?.attempts).toBe(2);
  });

  test("a queued job whose kind has no handler fails with the SB_ code", async () => {
    const runner = makeRunner();
    const job = await runner.enqueue("verify_refresh", { guildId: "1", requestedBy: "9" });

    await waitFor(async () => (await getJob(db, job.id))?.status === "failed", "the job to fail");
    const got = await getJob(db, job.id);
    expect(got?.status).toBe("failed");
    expect(got?.error_code).toBe("SB_JOB_NO_HANDLER");
    expect(got?.error_body).toContain("SB_JOB_NO_HANDLER");
  });

  test("attempts increments on each start", async () => {
    const runner = makeRunner();
    runner.register("backup", async () => {});
    const job = await runner.enqueue("backup", { guildId: "1", requestedBy: "9" });

    await waitFor(
      async () => (await getJob(db, job.id))?.status === "succeeded",
      "the job to succeed",
    );
    expect((await getJob(db, job.id))?.attempts).toBe(1);
  });

  test("eta is null before any progress and a number once it can be computed", async () => {
    const clockStart = Date.parse("2024-01-01T00:00:00.000Z");
    let clock = clockStart;

    // no handler: the job never starts, so there is no started_at and no progress
    const idle = makeRunner({ now: () => clock });
    const idleJob = await idle.enqueue("backup", { guildId: "1", requestedBy: "9" });
    await waitFor(
      async () => (await getJob(db, idleJob.id))?.status === "failed",
      "the idle job to fail",
    );
    expect(await idle.eta(idleJob.id)).toBeNull();

    // a job that checkpoints halfway: elapsed time and done/total give the estimate
    const runner = makeRunner({ now: () => clock });
    runner.register("backup", async (ctx) => {
      await ctx.checkpoint("scan", { done: 5, total: 10 });
    });
    const job = await runner.enqueue("backup", { guildId: "2", requestedBy: "9" });
    await waitFor(
      async () => (await getJobProgress(db, job.id, "scan")) !== null,
      "a progress row",
    );

    clock = clockStart + 10_000; // 10s elapsed, 5 of 10 done => 10s remaining
    expect(await runner.eta(job.id)).toBe(10);
  });
});
