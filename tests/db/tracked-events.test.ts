// tests/db/tracked-events.test.ts
//
// the timeline table: the insert, the three readers, and the retention sweep. the
// point of the file is the whole-instance read the owner's export uses. it has to
// see every guild's rows, so the guild filter must leave the query entirely, and a
// bug there would silently write an empty file rather than a wrong one.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../src/db/duckdb.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  countEventsByGuild,
  deleteEventsBefore,
  insertTrackedEvent,
  listAllEvents,
  listEventsByGuild,
  listEventsBySubject,
} from "../../src/db/queries/tracked-events.ts";
import type { Database, TrackedEventRow } from "../../src/db/types.ts";

const GUILD = "123456789012345678";
const OTHER_GUILD = "222222222222222222";
const USER = "987654321098765432";
const OTHER_USER = "987654321098765433";
const AT = "2024-06-01T12:00:00.000Z";

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-tracked-db-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.run("DELETE FROM tracked_events");
});

function row(overrides: Partial<TrackedEventRow> = {}): TrackedEventRow {
  return {
    event_id: Bun.randomUUIDv7(),
    guild_id: GUILD,
    subject_kind: "user",
    subject_id: USER,
    kind: "member_join",
    actor_id: null,
    source: "gateway",
    channel_id: null,
    before_json: null,
    after_json: { username: "jane" },
    detail_json: null,
    at: AT,
    recorded_at: AT,
    ...overrides,
  };
}

describe("the timeline table", () => {
  test("a row survives the trip there and back", async () => {
    const written = row({ kind: "member_nickname", before_json: { nickname: "old" } });
    await insertTrackedEvent(db, written);
    const [read] = await listEventsBySubject(db, GUILD, USER);
    expect(read).toEqual(written);
  });

  test("the whole-instance read sees every guild", async () => {
    // the owner's export. if the guild clause leaked into this query it would see
    // one guild's rows and write a file that looks complete and is not.
    await insertTrackedEvent(db, row({ event_id: "e1", guild_id: GUILD }));
    await insertTrackedEvent(db, row({ event_id: "e2", guild_id: OTHER_GUILD }));
    const all = await listAllEvents(db);
    expect(all.map((event) => event.guild_id).sort()).toEqual([GUILD, OTHER_GUILD].sort());
  });

  test("the guild read stays inside its guild", async () => {
    await insertTrackedEvent(db, row({ event_id: "e1", guild_id: GUILD }));
    await insertTrackedEvent(db, row({ event_id: "e2", guild_id: OTHER_GUILD }));
    const mine = await listEventsByGuild(db, GUILD);
    expect(mine.map((event) => event.event_id)).toEqual(["e1"]);
  });

  test("the person read stays inside their guild and their rows", async () => {
    await insertTrackedEvent(db, row({ event_id: "e1", subject_id: USER }));
    await insertTrackedEvent(db, row({ event_id: "e2", subject_id: OTHER_USER }));
    await insertTrackedEvent(db, row({ event_id: "e3", guild_id: OTHER_GUILD }));
    const mine = await listEventsBySubject(db, GUILD, USER);
    expect(mine.map((event) => event.event_id)).toEqual(["e1"]);
  });

  test("newest first, and the cursor pages back through history", async () => {
    await insertTrackedEvent(db, row({ event_id: "e1", at: "2024-06-01T00:00:00.000Z" }));
    await insertTrackedEvent(db, row({ event_id: "e2", at: "2024-06-02T00:00:00.000Z" }));
    await insertTrackedEvent(db, row({ event_id: "e3", at: "2024-06-03T00:00:00.000Z" }));

    expect((await listEventsByGuild(db, GUILD)).map((event) => event.event_id)).toEqual([
      "e3",
      "e2",
      "e1",
    ]);
    const older = await listEventsByGuild(db, GUILD, { before: "2024-06-03T00:00:00.000Z" });
    expect(older.map((event) => event.event_id)).toEqual(["e2", "e1"]);
  });

  test("a kind filter binds one placeholder per kind", async () => {
    await insertTrackedEvent(db, row({ event_id: "e1", kind: "member_join" }));
    await insertTrackedEvent(db, row({ event_id: "e2", kind: "member_leave" }));
    await insertTrackedEvent(db, row({ event_id: "e3", kind: "member_nickname" }));
    const picked = await listEventsByGuild(db, GUILD, {
      kinds: ["member_join", "member_leave"],
    });
    expect(picked.map((event) => event.event_id).sort()).toEqual(["e1", "e2"]);
  });

  test("an empty kind list is not a filter that matches nothing", async () => {
    await insertTrackedEvent(db, row({ event_id: "e1" }));
    const all = await listEventsByGuild(db, GUILD, { kinds: [] });
    expect(all.map((event) => event.event_id)).toEqual(["e1"]);
  });

  test("the count and the sweep both stay inside their guild", async () => {
    await insertTrackedEvent(db, row({ event_id: "e1", guild_id: GUILD }));
    await insertTrackedEvent(db, row({ event_id: "e2", guild_id: OTHER_GUILD }));

    expect(await countEventsByGuild(db, GUILD)).toBe(1);
    // the sweep takes strictly older than the cutoff, so a row on the cutoff stays
    expect(await deleteEventsBefore(db, GUILD, "2024-06-01T12:00:00.001Z")).toBe(1);
    expect(await countEventsByGuild(db, GUILD)).toBe(0);
    expect(await countEventsByGuild(db, OTHER_GUILD)).toBe(1);
  });
});
