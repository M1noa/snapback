// queries/jobs.ts. one row per long operation, plus per-step checkpoints in
// job_progress. rows are resumable: a restart reads queued / running / paused
// jobs back, oldest first, and resumes at the last completed step (D4PLAN 4.1).

import { parseJson, type SqlValue, stringifyJson, toId, toNumber, toText } from "../rows.ts";
import type { Database, JobKind, JobProgressRow, JobRow, JobStatus, JsonObject } from "../types.ts";

// queued / running / paused are the states a restart can pick up and continue.
export const RESUMABLE_STATUSES: readonly JobStatus[] = ["queued", "running", "paused"];

const COLUMNS =
  "id, guild_id, kind, status, requested_by, payload_json, progress_json, error_code, error_body, created_at, started_at, finished_at, attempts";

function toJobRow(raw: Record<string, SqlValue>): JobRow {
  return {
    id: toId(raw.id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    kind: toText(raw.kind) as JobKind,
    status: toText(raw.status) as JobStatus,
    requested_by: toId(raw.requested_by) ?? "",
    payload_json:
      raw.payload_json === null || raw.payload_json === undefined
        ? null
        : parseJson<JsonObject>(raw.payload_json),
    progress_json:
      raw.progress_json === null || raw.progress_json === undefined
        ? null
        : parseJson<JsonObject>(raw.progress_json),
    error_code: toText(raw.error_code) ?? null,
    error_body: toText(raw.error_body) ?? null,
    created_at: toText(raw.created_at) ?? "",
    started_at: toText(raw.started_at) ?? null,
    finished_at: toText(raw.finished_at) ?? null,
    attempts: toNumber(raw.attempts) ?? 0,
  };
}

function bind(row: JobRow): (string | number | null)[] {
  return [
    row.id,
    row.guild_id,
    row.kind,
    row.status,
    row.requested_by,
    stringifyJson(row.payload_json),
    stringifyJson(row.progress_json),
    row.error_code,
    row.error_body,
    row.created_at,
    row.started_at,
    row.finished_at,
    row.attempts,
  ];
}

export async function insertJob(db: Database, row: JobRow): Promise<void> {
  await db.run(
    `INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind(row),
  );
}

export async function upsertJob(db: Database, row: JobRow): Promise<void> {
  await db.run(
    `INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       guild_id = excluded.guild_id,
       kind = excluded.kind,
       status = excluded.status,
       requested_by = excluded.requested_by,
       payload_json = excluded.payload_json,
       progress_json = excluded.progress_json,
       error_code = excluded.error_code,
       error_body = excluded.error_body,
       created_at = excluded.created_at,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       attempts = excluded.attempts`,
    bind(row),
  );
}

export async function getJob(db: Database, id: string): Promise<JobRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM jobs WHERE id = ?`,
    [id],
  );
  const first = rows[0];
  return first === undefined ? null : toJobRow(first);
}

export async function updateJob(db: Database, row: JobRow): Promise<void> {
  await db.run(
    `UPDATE jobs SET
       guild_id = ?, kind = ?, status = ?, requested_by = ?,
       payload_json = ?, progress_json = ?, error_code = ?, error_body = ?,
       created_at = ?, started_at = ?, finished_at = ?, attempts = ?
     WHERE id = ?`,
    [
      row.guild_id,
      row.kind,
      row.status,
      row.requested_by,
      stringifyJson(row.payload_json),
      stringifyJson(row.progress_json),
      row.error_code,
      row.error_body,
      row.created_at,
      row.started_at,
      row.finished_at,
      row.attempts,
      row.id,
    ],
  );
}

export async function setJobStatus(db: Database, id: string, status: JobStatus): Promise<void> {
  await db.run("UPDATE jobs SET status = ? WHERE id = ?", [status, id]);
}

// resumable ordering: oldest first, so a restart continues the job that has
// waited longest. created_at is ISO-8601 text, so string order is time order.
function inClause(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

export async function listJobsByGuild(db: Database, guildId: string): Promise<JobRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM jobs WHERE guild_id = ? ORDER BY created_at DESC, id DESC`,
    [guildId],
  );
  return rows.map(toJobRow);
}

export async function listJobsByGuildAndStatus(
  db: Database,
  guildId: string,
  status: JobStatus,
): Promise<JobRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM jobs WHERE guild_id = ? AND status = ?
     ORDER BY created_at, id`,
    [guildId, status],
  );
  return rows.map(toJobRow);
}

export async function listJobsByKindAndStatus(
  db: Database,
  kind: JobKind,
  status: JobStatus,
): Promise<JobRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM jobs WHERE kind = ? AND status = ? ORDER BY created_at, id`,
    [kind, status],
  );
  return rows.map(toJobRow);
}

export async function listResumableJobs(db: Database): Promise<JobRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM jobs WHERE status IN (${inClause(RESUMABLE_STATUSES)})
     ORDER BY created_at, id`,
    [...RESUMABLE_STATUSES],
  );
  return rows.map(toJobRow);
}

export async function listResumableJobsForGuild(db: Database, guildId: string): Promise<JobRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM jobs
     WHERE guild_id = ? AND status IN (${inClause(RESUMABLE_STATUSES)})
     ORDER BY created_at, id`,
    [guildId, ...RESUMABLE_STATUSES],
  );
  return rows.map(toJobRow);
}

// ---- job_progress ----

const PROGRESS_COLUMNS = "job_id, step, cursor, done_count, total_count, updated_at";

function toProgressRow(raw: Record<string, SqlValue>): JobProgressRow {
  return {
    job_id: toId(raw.job_id) ?? "",
    step: toText(raw.step) ?? "",
    cursor: toText(raw.cursor) ?? null,
    done_count: toNumber(raw.done_count) ?? 0,
    total_count: toNumber(raw.total_count) ?? 0,
    updated_at: toText(raw.updated_at) ?? "",
  };
}

function bindProgress(row: JobProgressRow): (string | number | null)[] {
  return [row.job_id, row.step, row.cursor, row.done_count, row.total_count, row.updated_at];
}

export async function insertJobProgress(db: Database, row: JobProgressRow): Promise<void> {
  await db.run(
    `INSERT INTO job_progress (${PROGRESS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
    bindProgress(row),
  );
}

export async function upsertJobProgress(db: Database, row: JobProgressRow): Promise<void> {
  await db.run(
    `INSERT INTO job_progress (${PROGRESS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id, step) DO UPDATE SET
       cursor = excluded.cursor,
       done_count = excluded.done_count,
       total_count = excluded.total_count,
       updated_at = excluded.updated_at`,
    bindProgress(row),
  );
}

export async function getJobProgress(
  db: Database,
  jobId: string,
  step: string,
): Promise<JobProgressRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${PROGRESS_COLUMNS} FROM job_progress WHERE job_id = ? AND step = ?`,
    [jobId, step],
  );
  const first = rows[0];
  return first === undefined ? null : toProgressRow(first);
}

export async function updateJobProgress(db: Database, row: JobProgressRow): Promise<void> {
  await db.run(
    `UPDATE job_progress SET cursor = ?, done_count = ?, total_count = ?, updated_at = ?
     WHERE job_id = ? AND step = ?`,
    [row.cursor, row.done_count, row.total_count, row.updated_at, row.job_id, row.step],
  );
}

export async function listJobProgress(db: Database, jobId: string): Promise<JobProgressRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${PROGRESS_COLUMNS} FROM job_progress WHERE job_id = ? ORDER BY step`,
    [jobId],
  );
  return rows.map(toProgressRow);
}

export async function deleteJobProgress(db: Database, jobId: string): Promise<void> {
  await db.run("DELETE FROM job_progress WHERE job_id = ?", [jobId]);
}
