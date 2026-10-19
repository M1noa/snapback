// tests/services/restore/channels.test.ts. the category and channel phases
// (D4PLAN 12.2 steps 4 and 5) against a real temp-file duckdb and a recording
// client: the requests and the id map are what the assertions are about.
//
// the source rows come from the fixture guild, captured by the real capture
// module, so the shapes are the ones a backup actually holds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { captureChannels } from "../../../src/services/backup/channels.ts";
import { restoreCategories, restoreChannels } from "../../../src/services/restore/channels.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
  type RestoreMaps,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";
import {
  CATEGORY_ID,
  CHANNEL_GENERAL,
  CHANNEL_VOICE,
  FIXTURE_GUILD_ID,
  type FixtureGuild,
  makeContext,
  makeGuild,
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

interface TargetChannel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
}

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

/** a client that records every request and answers the ones the phase makes. */
function recorder(options: { premiumTier?: number; existing?: TargetChannel[] } = {}) {
  const calls: Call[] = [];
  const failures = new Map<string, unknown>();
  let created = 0;

  const client = {
    async request<T>(req: RequestOptions): Promise<T> {
      calls.push({ method: req.method, route: req.route, body: req.body });
      const key = `${req.method} ${req.route}`;
      const failure = failures.get(key);
      if (failure !== undefined) throw failure;

      if (req.method === "GET" && req.route === `/guilds/${TARGET}`) {
        return { id: TARGET, premium_tier: options.premiumTier ?? 0 } as unknown as T;
      }
      if (req.method === "GET" && req.route === `/guilds/${TARGET}/channels`) {
        return (options.existing ?? []) as unknown as T;
      }
      if (req.method === "POST" && req.route === `/guilds/${TARGET}/channels`) {
        created += 1;
        return { id: `9000000000000000${String(created).padStart(2, "0")}` } as unknown as T;
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

/** capture the fixture guild into the db, so the restore reads real rows. */
async function seed(guild: FixtureGuild): Promise<string> {
  const backup = await insertFixtureBackup(db, { guild_id: FIXTURE_GUILD_ID });
  await captureChannels(makeContext({ db, guild, backupId: backup.backup_id }));
  return backup.backup_id;
}

function creates(calls: readonly Call[]): Call[] {
  return calls.filter(
    (call) => call.method === "POST" && call.route === `/guilds/${TARGET}/channels`,
  );
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe("restoreCategories and restoreChannels", () => {
  test("a category is created before the channel that lives under it", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    await restoreCategories(ctx);
    await restoreChannels(ctx);

    const posted = creates(rec.calls);
    expect(posted).toHaveLength(4);

    // the category goes first, so it holds the first id.
    expect(bodyOf(posted[0]).type).toBe(4);
    const categoryId = ctx.maps.channels.get(CATEGORY_ID);
    expect(categoryId).toBe("900000000000000001");

    // the channel under it is created with the category's target id as parent.
    const general = posted.find((call) => bodyOf(call).name === "general");
    expect(bodyOf(general)).toMatchObject({ type: 0, parent_id: categoryId });

    // and both ids land in the map, under their source ids.
    expect(ctx.maps.channels.get(CHANNEL_GENERAL)).toBe("900000000000000002");
    expect(ctx.maps.channels.get(CHANNEL_VOICE)).toBe("900000000000000003");
  });

  test("a channel carries its topic, its nsfw flag and its slowmode", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    await restoreCategories(ctx);
    await restoreChannels(ctx);

    const general = creates(rec.calls).find((call) => bodyOf(call).name === "general");
    expect(bodyOf(general)).toMatchObject({
      topic: "the fixture channel",
      nsfw: false,
      rate_limit_per_user: 5,
      position: 0,
    });
  });

  test("a name with a reserved character is sanitised and noted", async () => {
    const guild = makeGuild({
      channels: [
        { id: CATEGORY_ID, type: 4, name: "text channels", position: 0, parent_id: null },
        { id: CHANNEL_GENERAL, type: 0, name: "bad#name", position: 0, parent_id: CATEGORY_ID },
      ],
    });
    const backupId = await seed(guild);
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    await restoreCategories(ctx);
    await restoreChannels(ctx);

    const general = creates(rec.calls).find((call) => bodyOf(call).name === "badname");
    expect(general).toBeDefined();

    // the note says which character went.
    const note = notes.find((entry) => entry.what.includes("bad#name"));
    expect(note?.why).toContain("#");
    expect(note?.why).toContain("badname");
  });

  test("a bitrate above the target tier is clamped, and one inside it is not", async () => {
    const guild = makeGuild({
      channels: [
        { id: CATEGORY_ID, type: 4, name: "text channels", position: 0, parent_id: null },
        {
          id: CHANNEL_VOICE,
          type: 2,
          name: "voice",
          position: 0,
          parent_id: CATEGORY_ID,
          bitrate: 96000,
          user_limit: 0,
          rtc_region: null,
          video_quality_mode: 1,
        },
      ],
    });
    const backupId = await seed(guild);

    const low = recorder({ premiumTier: 0 });
    const lowNotes: Note[] = [];
    const lowCtx = restoreContext({ backupId, client: low.client, notes: lowNotes });
    await restoreCategories(lowCtx);
    await restoreChannels(lowCtx);

    const voice = creates(low.calls).find((call) => bodyOf(call).name === "voice");
    expect(bodyOf(voice).bitrate).toBe(64000);
    // the tier is read from the target guild, not assumed.
    expect(
      low.calls.some((call) => call.method === "GET" && call.route === `/guilds/${TARGET}`),
    ).toBe(true);

    const high = recorder({ premiumTier: 3 });
    const highNotes: Note[] = [];
    const highCtx = restoreContext({ backupId, client: high.client, notes: highNotes });
    await restoreCategories(highCtx);
    await restoreChannels(highCtx);

    const rich = creates(high.calls).find((call) => bodyOf(call).name === "voice");
    expect(bodyOf(rich).bitrate).toBe(96000);
  });

  test("a name discord rejects is noted with discord's own words", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    rec.failures.set(
      `POST /guilds/${TARGET}/channels`,
      new DiscordApiError({
        status: 400,
        route: `/guilds/${TARGET}/channels`,
        method: "POST",
        body: JSON.stringify({ code: 50035, message: "Invalid Form Body" }),
      }),
    );
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    const result = await restoreCategories(ctx);

    expect(result.count).toBe(0);
    expect(result.outcome).toBe("warn");
    const note = notes.find((entry) => entry.why.includes("50035"));
    expect(note?.why).toContain("Invalid Form Body");
    expect(note?.what).toContain("category");
  });

  test("a channel whose parent is missing is created at the top level with a note", async () => {
    const backupId = await seed(makeGuild());
    const rec = recorder();
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    // the categories phase never ran, so the parent is not in the map.
    await restoreChannels(ctx);

    const general = creates(rec.calls).find((call) => bodyOf(call).name === "general");
    expect(bodyOf(general).parent_id).toBeNull();

    const note = notes.find((entry) => entry.what.includes("general"));
    expect(note?.why).toContain("top level");
  });

  test("a channel the target already has is edited instead of duplicated", async () => {
    const guild = makeGuild({
      channels: [
        {
          id: CHANNEL_GENERAL,
          type: 0,
          name: "general",
          position: 0,
          parent_id: null,
          topic: "the fixture channel",
        },
      ],
    });
    const backupId = await seed(guild);
    const rec = recorder({
      existing: [{ id: "800000000000000001", name: "general", type: 0, parent_id: null }],
    });
    const notes: Note[] = [];
    const ctx = restoreContext({ backupId, client: rec.client, notes });

    const result = await restoreChannels(ctx);

    expect(creates(rec.calls)).toHaveLength(0);
    const patch = rec.calls.find((call) => call.method === "PATCH");
    expect(patch?.route).toBe("/channels/800000000000000001");
    expect(ctx.maps.channels.get(CHANNEL_GENERAL)).toBe("800000000000000001");
    expect(result.count).toBe(1);
    expect(notes.some((entry) => entry.why.includes("edited instead"))).toBe(true);
  });
});
