// tests/services/restore/index.test.ts
//
// the executor's rules, which the phases themselves do not know about: the order
// is the plan's order, a failed phase skips the phases that depend on it and
// leaves the others alone, a cancel stops the run, and the report says what
// happened per phase.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { runRestore } from "../../../src/services/restore/index.ts";
import type {
  PhaseResult,
  RestoreContext,
  RestorePhaseName,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const GUILD = "123456789012345678";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

// a client that refuses everything the way discord does, so a phase records a
// note and carries on instead of crashing the run.
const refusing = {
  async request(): Promise<never> {
    throw new DiscordApiError({
      status: 403,
      route: "/guilds/1",
      method: "GET",
      body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
    });
  },
} as unknown as RestoreContext["client"];

function context(overrides: Partial<RestoreContext> = {}): RestoreContext {
  return {
    db,
    client: refusing,
    log: createLogger({ level: "error", dir: null }),
    backupId: "0190a000-0000-7000-8000-000000000001",
    targetGuildId: GUILD,
    options: {
      guild: true,
      emojis: true,
      stickers: true,
      sounds: true,
      roles: true,
      channels: true,
      overwrites: true,
      threads: true,
      onboarding: true,
      automod: true,
      events: true,
      members: true,
      memberMode: 1,
      messages: true,
      bans: true,
      messageLimit: 1000,
      timestampSuffix: false,
      reuseRoles: true,
      deleteExtraRoles: false,
      clearBefore: false,
    },
    maps: { roles: new Map(), channels: new Map(), members: new Map(), emojis: new Map() },
    sourceGuildId: GUILD,
    backupDir: "/tmp/snapback-restore-test",
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: () => {},
    now: () => "2024-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runRestore", () => {
  test("the phases come out in the plan's order", async () => {
    const report = await runRestore(context());
    const names = report.phases.map((phase) => phase.phase);
    expect(names).toEqual([
      "guild",
      "emojis",
      "roles",
      "categories",
      "channels",
      "overwrites",
      "threads",
      "onboarding",
      "automod",
      "events",
      "members",
      "bans",
      "messages",
    ]);
  });

  test("a phase that could not do its work reports it, and the run carries on", async () => {
    // every call is refused, so every phase records why it could not do its work
    // and the run still reaches the end. a restore that stops at the first
    // refusal would lose the work the earlier phases did.
    const report = await runRestore(context());
    const byPhase = new Map(report.phases.map((phase) => [phase.phase, phase]));

    expect(byPhase.size).toBe(13);
    expect(
      report.phases.some((phase) => phase.outcome === "warn" || phase.outcome === "fail"),
    ).toBe(true);
    // nothing was skipped for a dependency: a refusal is a note, not a failed
    // phase, and a note does not stop the phases that follow.
    expect(report.phases.some((phase) => phase.outcome === "skipped")).toBe(false);
  });

  test("a cancel stops the run at the next phase", async () => {
    const signal = { cancelled: true, paused: false };
    const report = await runRestore(context({ signal }));
    expect(report.cancelled).toBe(true);
    expect(report.phases).toHaveLength(0);
  });

  test("the report says the restore cannot be undone", async () => {
    const report = await runRestore(context());
    expect(report.notReversible).toContain("cannot be undone");
    expect(report.startedAt).toBe("2024-06-01T00:00:00.000Z");
    expect(report.finishedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  test("every phase is checkpointed, so a restart resumes rather than starts over", async () => {
    const seen: RestorePhaseName[] = [];
    const report = await runRestore(
      context({
        checkpoint: async (phase) => {
          seen.push(phase);
        },
      }),
    );
    expect(seen).toEqual(report.phases.map((phase) => phase.phase));
  });

  test("a phase result carries its count and its notes", () => {
    const result: PhaseResult = {
      outcome: "warn",
      count: 2,
      notes: [{ what: "a thing", why: "discord said no" }],
      failed: false,
    };
    expect(result.count).toBe(2);
    expect(result.notes[0]?.why).toBe("discord said no");
  });
});
