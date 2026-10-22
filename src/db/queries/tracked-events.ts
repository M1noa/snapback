// queries/tracked-events.ts. the event timeline. insert and read only: a tracked
// event is a record of something that happened, so there is no update path. the one
// delete is the retention sweep, which takes a cutoff rather than an id.

import { parseJson, type SqlValue, stringifyJson, toId, toText } from "../rows.ts";
import type {
  Database,
  EventSource,
  JsonObject,
  SqlParam,
  TrackedEventKind,
  TrackedEventRow,
  TrackedSubjectKind,
} from "../types.ts";

const COLUMNS =
  'event_id, guild_id, subject_kind, subject_id, kind, actor_id, source, channel_id, before_json, after_json, detail_json, "at", recorded_at';
const DEFAULT_LIMIT = 25;

function json<T>(value: SqlValue): T | null {
  return value === null || value === undefined ? null : parseJson<T>(value);
}

// the union columns come back as plain text. the only writer is insert below, so
// the cast is safe; validating against the vocabulary here would make db depend on
// services and the layering runs the other way.
function toTrackedEventRow(raw: Record<string, SqlValue>): TrackedEventRow {
  return {
    event_id: toId(raw.event_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    subject_kind: (toText(raw.subject_kind) ?? "user") as TrackedSubjectKind,
    subject_id: toId(raw.subject_id) ?? "",
    kind: (toText(raw.kind) ?? "") as TrackedEventKind,
    actor_id: toId(raw.actor_id) ?? null,
    source: (toText(raw.source) ?? "gateway") as EventSource,
    channel_id: toId(raw.channel_id) ?? null,
    before_json: json<JsonObject>(raw.before_json),
    after_json: json<JsonObject>(raw.after_json),
    detail_json: json<JsonObject>(raw.detail_json),
    at: toText(raw.at) ?? "",
    recorded_at: toText(raw.recorded_at) ?? "",
  };
}

export async function insertTrackedEvent(db: Database, row: TrackedEventRow): Promise<void> {
  await db.run(
    `INSERT INTO tracked_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.event_id,
      row.guild_id,
      row.subject_kind,
      row.subject_id,
      row.kind,
      row.actor_id,
      row.source,
      row.channel_id,
      stringifyJson(row.before_json),
      stringifyJson(row.after_json),
      stringifyJson(row.detail_json),
      row.at,
      row.recorded_at,
    ],
  );
}

export interface EventQuery {
  /** page size. default 25, which is one page builder's worth. */
  limit?: number;
  /** exclusive cursor on "at", for paging back through history. */
  before?: string;
  /** narrow to one or more kinds, for the filtered view. */
  kinds?: readonly TrackedEventKind[];
}

// the where clause is built from a fixed set of fragments with placeholders, never
// from a string a caller supplied. kinds are the only variable part of the shape.
function where(guildId: string, subjectId: string | null, query: EventQuery) {
  const clauses = ["guild_id = ?"];
  // SqlParam, not SqlValue: the driver rejects undefined, and toId can return it.
  const binds: SqlParam[] = [guildId];
  if (subjectId !== null) {
    clauses.push("subject_id = ?");
    binds.push(subjectId);
  }
  if (query.before !== undefined) {
    clauses.push('"at" < ?');
    binds.push(query.before);
  }
  if (query.kinds !== undefined && query.kinds.length > 0) {
    clauses.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
    for (const kind of query.kinds) binds.push(kind);
  }
  return { clause: clauses.join(" AND "), binds };
}

// newest first, matching idx_tracked_events_guild_at and _subject.
export async function listEventsByGuild(
  db: Database,
  guildId: string,
  query: EventQuery = {},
): Promise<TrackedEventRow[]> {
  return list(db, guildId, null, query);
}

export async function listEventsBySubject(
  db: Database,
  guildId: string,
  subjectId: string,
  query: EventQuery = {},
): Promise<TrackedEventRow[]> {
  return list(db, guildId, subjectId, query);
}

async function list(
  db: Database,
  guildId: string,
  subjectId: string | null,
  query: EventQuery,
): Promise<TrackedEventRow[]> {
  const { clause, binds } = where(guildId, subjectId, query);
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM tracked_events WHERE ${clause}
     ORDER BY "at" DESC, event_id DESC LIMIT ?`,
    [...binds, query.limit ?? DEFAULT_LIMIT],
  );
  return rows.map(toTrackedEventRow);
}

/** how many rows this guild has, for the settings page. */
export async function countEventsByGuild(db: Database, guildId: string): Promise<number> {
  const rows = await db.query<{ n: SqlValue }>(
    "SELECT COUNT(*) AS n FROM tracked_events WHERE guild_id = ?",
    [guildId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** the retention sweep. everything strictly older than the cutoff goes. */
export async function deleteEventsBefore(
  db: Database,
  guildId: string,
  cutoff: string,
): Promise<void> {
  await db.run('DELETE FROM tracked_events WHERE guild_id = ? AND "at" < ?', [guildId, cutoff]);
}
