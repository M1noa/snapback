// tests/services/restore/threads.test.ts. the thread phase (D4PLAN 12.2 step 7)
// against a real temp-file duckdb and a recording client: the requests and the
// id map are what the assertions are about.
//
// the source rows come from the fixture guild, captured by the real capture
// module, so the shapes are the ones a backup actually holds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { captureChannels, captureThreads } from "../../../src/services/backup/channels.ts";
import { restoreThreads } from "../../../src/services/restore/threads.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
  type RestoreMaps,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";
import {
  CHANNEL_GENERAL,
  FIXTURE_GUILD_ID,
  type FixtureGuild,
  makeContext,
  makeGuild,
  THREAD_ACTIVE,
  THREAD_ARCHIVED,
} from "../../fixtures/guild.ts";

/** the guild the restore writes into. not the fixture guild. */
const TARGET = "200000000000000001";

interface Note {
  what: string;
  why: string;
}

interface Call {
  method: string;
  route: string;
  body: unknown;
}

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

/** a client that records every request and answers the ones the phase makes. */
function recorder() {
  const calls: Call[] = [];
  const failures = new Map<string, unknown>();
  let created = 0;

  const client = {
    async request<T>(req: RequestOptions): Promise<T> {
      calls.push({ method: req.method, route: req.route, body: req.body });
      const key = `${req.method} ${req.route}`;
      const failure = failures.get(key);
      if (failure !== undefined) throw failure;

      if (req.method === "POST" && req.route.endsWith("/threads")) {
        created += 1;
        return { id: `9100000000000000${String(created).padStart(2, "0")}` } as unknown as T;
      }
      return {} as unknown as T;
    },
  } as unknown as DiscordClient;

  return { client, calls, failures };
}

function restoreContext(options: {
  backupId: string;
  client: DiscordClient;
  notes: Note[];
  maps?: RestoreMaps;
}): RestoreContext {
  return {
    db,
    client: options.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: options.backupId,
    targetGuildId: TARGET,
    options: DEFAULT_RESTORE_OPTIONS,
    maps: options.maps ?? createRestoreMaps(),
    sourceGuildId: FIXTURE_GUILD_ID,
    backupDir: "/tmp/snapback-restore-fixture",
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: (what: string, why: string) => {
      options.notes.push({ what, why });
    },
    now: () => "2024-01-01T00:00:00.000Z",
  };
}

/** capture the fixture guild's channels and threads into the db. */
async function seed(guild: FixtureGuild): Promise<string> {
  const backup = await insertFixtureBackup(db, { guild_id: FIXTURE_GUILD_ID });
  const ctx = makeContext({ db, guild, backupId: backup.backup_id });
  await captureChannels(ctx);
  await captureThreads(ctx);
  return backup.backup_id;
}

function posts(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.method === "POST");
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe("restoreThreads", () => {
  test("a public thread is created with type 11 and its parent from the map", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });
    ctx.maps.channels.set(CHANNEL_GENERAL, "900000000000000001");

    const result = await restoreThreads(ctx);

    const posted = posts(rec.calls);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.route).toBe("/channels/900000000000000001/threads");
    expect(bodyOf(posted[0])).toMatchObject({ name: "an active thread", type: 11 });

    // the new thread id lands in the map, so a message can find its thread.
    expect(ctx.maps.channels.get(THREAD_ACTIVE)).toBe("910000000000000001");
    expect(result.count).toBe(1);
  });

  test("archived and locked are applied in the patch", async () => {
    const guild = makeGuild({
      threads: {
        active: [],
        archived: [
          {
            id: THREAD_ARCHIVED,
            type: 11,
            parent_id: CHANNEL_GENERAL,
            name: "an archived thread",
            rate_limit_per_user: null,
            thread_metadata: { archived: true, locked: true, auto_archive_duration: 4320 },
          },
        ],
      },
    });
    const backupId = await seed(guild);
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });
    ctx.maps.channels.set(CHANNEL_GENERAL, "900000000000000001");

    await restoreThreads(ctx);

    const patch = rec.calls.find((call) => call.method === "PATCH");
    expect(patch?.route).toBe("/channels/910000000000000001");
    expect(bodyOf(patch)).toMatchObject({
      archived: true,
      locked: true,
      auto_archive_duration: 4320,
    });

    // the archive timestamp is the restore time, and the note says so.
    expect(notes.some((entry) => entry.why.includes("archive timestamp is the restore time"))).toBe(
      true,
    );
  });

  test("an announcement thread is skipped with a note", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });
    ctx.maps.channels.set(CHANNEL_GENERAL, "900000000000000001");

    await restoreThreads(ctx);

    // the fixture's archived thread is type 10, so only the type 11 one is made.
    const posted = posts(rec.calls);
    expect(posted).toHaveLength(1);
    expect(ctx.maps.channels.has(THREAD_ARCHIVED)).toBe(false);

    const note = notes.find((entry) => entry.what.includes("an archived thread"));
    expect(note?.why).toContain("announcement thread");
  });

  test("a parent that is not in the map is a note, and no thread is made", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    const result = await restoreThreads(ctx);

    expect(posts(rec.calls)).toHaveLength(0);
    expect(result.count).toBe(0);
    expect(ctx.maps.channels.has(THREAD_ACTIVE)).toBe(false);

    const note = notes.find((entry) => entry.what.includes("an active thread"));
    expect(note?.why).toContain("parent channel was not created");
  });
});
