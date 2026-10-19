// tests/discord/commands/pull.test.ts
//
// the /pull surface: the commands, the pages they render, and the rule that
// matters most here. an account the counters refuse is skipped with the reason
// the counters gave, never dropped without a word.

import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import type { JobRow } from "../../../src/db/types.ts";
import {
  PULL_ACTION,
  PULL_OBJECT,
  PULL_SPECS,
  PULL_SURFACE,
  type PullAccountView,
  type PullDeps,
  pullCustomId,
} from "../../../src/discord/commands/pull/deps.ts";
import { registerPullHandlers } from "../../../src/discord/commands/pull/handlers.ts";
import { createPullJobHandler, pullCommands } from "../../../src/discord/commands/pull/index.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import type { HandlerSurface } from "../../../src/discord/interactions/router.ts";
import { parseCustomId, Router } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";

const GUILD = "123456789012345678";
const USER = "987654321098765432";
const OWNER = "111111111111111111";
const AT = "2024-06-01T12:00:00.000Z";

function counterRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER,
    guild_id: GUILD,
    day: "2024-06-01",
    attempts: 0,
    successes: 0,
    failures: 0,
    cooldown_until: null,
    restricted: false,
    restricted_reason: null,
    restricted_at: null,
    updated_at: AT,
    ...overrides,
  };
}

function attemptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "attempt-1",
    guild_id: GUILD,
    user_id: USER,
    attempted_at: AT,
    outcome: "added",
    error_code: null,
    error_body: null,
    ...overrides,
  };
}

/** what the surface did, so a test can see it. */
interface FakeHarness {
  readonly enqueued: { kind: string; payload: unknown }[];
  readonly pulled: string[];
  /** the accounts the job skipped, and why. */
  readonly skipped: { userId: string; reason: string }[];
}

function fakeDeps(
  overrides: Partial<PullDeps> = {},
  harness: FakeHarness = { enqueued: [], pulled: [], skipped: [] },
): PullDeps {
  const accounts: PullAccountView[] = [
    {
      userId: USER,
      username: "someone",
      scopes: ["identify", "guilds.join"],
      tokenStatus: "valid",
      hasToken: true,
    },
  ];
  const counters: Record<string, unknown>[] = [];
  const attempts: Record<string, unknown>[] = [];
  const jobRows: Record<string, unknown>[] = [];

  return {
    db: {
      query: async (sql: string) => {
        if (sql.includes("FROM account_counters")) return counters;
        if (sql.includes("FROM pull_attempts")) return attempts;
        if (sql.includes("FROM jobs")) return jobRows;
        return [];
      },
      run: async (sql: string, params?: (string | number | bigint | boolean | null)[]) => {
        // the pull_attempts insert binds id, guild, user, at, outcome, code, body.
        if (sql.includes("INSERT INTO pull_attempts") && params !== undefined) {
          harness.skipped.push({
            userId: String(params[2]),
            reason: String(params[6] ?? ""),
          });
        }
      },
    } as unknown as PullDeps["db"],
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async (kind: string, input: { guildId: string; payload?: unknown }) => {
        harness.enqueued.push({ kind, payload: input.payload });
        jobRows.push({
          id: `job-${harness.enqueued.length}`,
          guild_id: input.guildId,
          kind,
          status: "queued",
          requested_by: OWNER,
          payload_json: JSON.stringify(input.payload ?? null),
          progress_json: null,
          error_code: null,
          error_body: null,
          created_at: AT,
          started_at: null,
          finished_at: null,
          attempts: 0,
        });
        return { id: `job-${harness.enqueued.length}` };
      },
      eta: async () => null,
      cancel: async () => {},
      pause: async () => {},
      resume: async () => {},
    } as unknown as PullDeps["jobs"],
    now: () => Date.parse(AT),
    state: new MemoryStateStore(),
    limits: { dailyLimit: 100, failureCooldownMinutes: 60, restrictedHours: 24 },
    authorize: async () => true,
    audit: async () => {},
    accounts: async (guildId) => (guildId === GUILD ? accounts : []),
    token: async (userId) => `token-granted-by-${userId}`,
    pull: async (input) => {
      const reports = input.accounts.map((account) => {
        harness.pulled.push(account.userId);
        return {
          userId: account.userId,
          outcome: "added" as const,
          errorCode: null,
          errorBody: null,
          reason: null,
        };
      });
      return reports;
    },
    ...overrides,
  };
}

/** the counters the fake database holds, so a test can set one up. */
function withCounter(overrides: Partial<PullDeps> = {}, row: Record<string, unknown>): PullDeps {
  const deps = fakeDeps(overrides);
  const query = deps.db.query as unknown as (sql: string) => Promise<unknown[]>;
  const original = query.bind(deps.db);
  (deps.db as unknown as { query: (sql: string) => Promise<unknown[]> }).query = async (
    sql: string,
  ) => {
    if (sql.includes("FROM account_counters")) return [row];
    return await original(sql);
  };
  return deps;
}

function walk(node: unknown, visit: (n: { customID?: string }) => void): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { customID?: string; components?: unknown[] };
  visit(record);
  if (Array.isArray(record.components)) for (const child of record.components) walk(child, visit);
}

function fakeSurface(): { surface: HandlerSurface; messages: string[] } {
  const messages: string[] = [];
  const surface: HandlerSurface = {
    reply: async (request) => {
      messages.push(JSON.stringify(request.message));
    },
    openModal: async () => {},
    values: {},
    source: "component",
  };
  return { surface, messages };
}

describe("the /pull command group", () => {
  test("every documented subcommand is registered, once", () => {
    const names = pullCommands(fakeDeps())
      .map((command) => command.subcommand)
      .sort();
    expect(names).toEqual(["start", "status"]);
  });

  test("every page the group renders stays inside the component budget", async () => {
    const commands = pullCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({ guildId: GUILD, userId: OWNER, options: {} });
      expect(countComponents(result.page as ContainerComponent)).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  test("every id a page produces parses as a pull control", async () => {
    const commands = pullCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({ guildId: GUILD, userId: OWNER, options: {} });
      const ids: string[] = [];
      walk(result.page, (node) => {
        if (typeof node.customID === "string") ids.push(node.customID);
      });
      for (const produced of ids) {
        const parsed = parseCustomId(produced);
        expect(parsed?.surface).toBe(PULL_SURFACE);
        expect(parsed?.guild).toBe(GUILD);
      }
    }
  });

  test("a person who is not an admin gets a refusal", async () => {
    const deps = fakeDeps({ authorize: async () => false });
    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: USER, options: {} });
    expect(JSON.stringify(result?.page)).toContain("snapback admins");
  });
});

describe("an account the counters refuse", () => {
  test("is skipped on the plan, with the reason the counters gave", async () => {
    const deps = withCounter(
      {},
      counterRow({
        attempts: 100,
        restricted: true,
        restricted_reason: "20013 account is restricted",
        restricted_at: AT,
      }),
    );
    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: OWNER, options: {} });

    const text = JSON.stringify(result?.page);
    expect(text).toContain("skipped");
    expect(text).toContain("20013 account is restricted");
    // nothing will be tried, so the confirm button is dead.
    expect(text).toContain('"disabled":true');
  });

  test("the daily limit says how many attempts are left in the day", async () => {
    const deps = withCounter({}, counterRow({ attempts: 100 }));
    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: OWNER, options: {} });

    expect(JSON.stringify(result?.page)).toContain("100 attempt(s) for today");
  });

  test("an account with no token is skipped before anything is tried", async () => {
    const deps = fakeDeps({
      accounts: async () => [
        {
          userId: USER,
          username: "someone",
          scopes: ["identify"],
          tokenStatus: "valid",
          hasToken: false,
        },
      ],
    });
    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: OWNER, options: {} });

    expect(JSON.stringify(result?.page)).toContain("no token was granted");
  });

  test("an account whose token cannot join a guild is skipped too", async () => {
    const deps = fakeDeps({
      accounts: async () => [
        {
          userId: USER,
          username: "someone",
          scopes: ["identify"],
          tokenStatus: "valid",
          hasToken: true,
        },
      ],
    });
    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: OWNER, options: {} });

    expect(JSON.stringify(result?.page)).toContain("no guilds.join scope");
  });
});

describe("the report", () => {
  test("says what happened, per account, and why", async () => {
    const deps = fakeDeps();
    const attempts = [
      attemptRow({
        outcome: "skipped",
        error_code: null,
        error_body: "the account has used its 100 attempt(s) for today",
      }),
    ];
    (deps.db as unknown as { query: (sql: string) => Promise<unknown[]> }).query = async (
      sql: string,
    ) => {
      if (sql.includes("FROM pull_attempts")) return attempts;
      if (sql.includes("FROM account_counters")) return [counterRow({ attempts: 100 })];
      return [];
    };

    const status = pullCommands(deps).find((command) => command.subcommand === "status");
    const result = await status?.run({ guildId: GUILD, userId: OWNER, options: {} });

    const text = JSON.stringify(result?.page);
    expect(text).toContain("skipped");
    expect(text).toContain("100 attempt(s) for today");
    expect(text).toContain("100 attempt(s)");
  });
});

describe("the pull job", () => {
  test("pulls only the accounts that hold a token they granted", async () => {
    const harness: FakeHarness = { enqueued: [], pulled: [], skipped: [] };
    const deps = fakeDeps({}, harness);
    const job: JobRow = {
      id: "job-1",
      guild_id: GUILD,
      kind: "pull",
      status: "running",
      requested_by: OWNER,
      payload_json: { excludeRevoked: true, max: null },
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: AT,
      started_at: AT,
      finished_at: null,
      attempts: 1,
    };

    await createPullJobHandler(deps)({
      job,
      signal: { cancelled: false, paused: false },
      log: createLogger({ level: "error", dir: null }),
      checkpoint: async () => {},
    });

    expect(harness.pulled).toEqual([USER]);
  });

  test("an account with no token is skipped, and the reason is recorded", async () => {
    const harness: FakeHarness = { enqueued: [], pulled: [], skipped: [] };
    const deps = fakeDeps(
      {
        accounts: async () => [
          {
            userId: USER,
            username: "someone",
            scopes: ["identify", "guilds.join"],
            tokenStatus: "valid",
            hasToken: false,
          },
        ],
        token: async () => null,
      },
      harness,
    );
    const job: JobRow = {
      id: "job-1",
      guild_id: GUILD,
      kind: "pull",
      status: "running",
      requested_by: OWNER,
      payload_json: { excludeRevoked: true, max: null },
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: AT,
      started_at: AT,
      finished_at: null,
      attempts: 1,
    };

    await createPullJobHandler(deps)({
      job,
      signal: { cancelled: false, paused: false },
      log: createLogger({ level: "error", dir: null }),
      checkpoint: async () => {},
    });

    expect(harness.pulled).toEqual([]);
    expect(harness.skipped).toEqual([{ userId: USER, reason: "no token was granted" }]);
  });
});

describe("the confirm button", () => {
  test("is a one-time nonce, and a second press does nothing", async () => {
    const harness: FakeHarness = { enqueued: [], pulled: [], skipped: [] };
    const deps = fakeDeps({}, harness);
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerPullHandlers(router, deps);

    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: OWNER, options: {} });
    const ids: string[] = [];
    walk(result?.page, (node) => {
      if (typeof node.customID === "string") ids.push(node.customID);
    });
    const confirmId = ids.find((id) => id.includes(`:${PULL_ACTION.confirm}:`));
    expect(confirmId).toBeDefined();

    const identity = { userId: OWNER, guildId: GUILD, isOwner: true };
    const first = fakeSurface();
    await router.route(confirmId!, identity, first.surface);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]?.kind).toBe("pull");

    const second = fakeSurface();
    await router.route(confirmId!, identity, second.surface);
    expect(harness.enqueued).toHaveLength(1);
    expect(second.messages.join("")).toContain("expired");
  });

  test("a confirmation minted for someone else is not used", async () => {
    const harness: FakeHarness = { enqueued: [], pulled: [], skipped: [] };
    const deps = fakeDeps({}, harness);
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerPullHandlers(router, deps);

    const start = pullCommands(deps).find((command) => command.subcommand === "start");
    const result = await start?.run({ guildId: GUILD, userId: OWNER, options: {} });
    const ids: string[] = [];
    walk(result?.page, (node) => {
      if (typeof node.customID === "string") ids.push(node.customID);
    });
    const confirmId = ids.find((id) => id.includes(`:${PULL_ACTION.confirm}:`));

    const { surface, messages } = fakeSurface();
    await router.route(
      confirmId!,
      { userId: "222222222222222222", guildId: GUILD, isOwner: false },
      surface,
    );
    expect(harness.enqueued).toHaveLength(0);
    expect(messages.join("")).toContain("not yours");
  });
});

describe("the boot assertion", () => {
  test("every spec has a handler, and every handler has a spec", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerPullHandlers(router, fakeDeps());
    const registered = router.registeredKeys().filter((key) => key.startsWith(`${PULL_SURFACE}:`));
    expect(registered.sort()).toEqual(
      PULL_SPECS.map((spec) => `${spec.surface}:${spec.action}`).sort(),
    );
  });

  test("a gap in the surface fails the boot", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerPullHandlers(router, fakeDeps());
    expect(() =>
      router.assertComplete([...PULL_SPECS, { surface: PULL_SURFACE, action: "ghost" }]),
    ).toThrow();
  });
});

describe("the custom id builder", () => {
  test("the cursor slot is always written", () => {
    const id = pullCustomId({
      guildId: GUILD,
      object: PULL_OBJECT.plan,
      action: PULL_ACTION.confirm,
    });
    expect(id.split(":")).toHaveLength(6);
    expect(parseCustomId(id)?.cursor).toBe("");
  });
});
