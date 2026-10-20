// tests/services/pull/member.test.ts
//
// the one call that adds a member, and the attempt row that records it. and the
// engine around it: a 401 means the access token is stale, so the token is
// refreshed once and the join is tried once more.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listPullAttemptsByUser } from "../../../src/db/queries/pull-attempts.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { type PullEngineDeps, pullAccounts } from "../../../src/services/pull/index.ts";
import { pullMember } from "../../../src/services/pull/member.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const GUILD = "123456789012345678";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function client(refusal: { status: number; code: number; message: string } | null) {
  const calls: { route: string; body: unknown }[] = [];
  return {
    calls,
    client: {
      async request(options: { method: string; route: string; body?: unknown }): Promise<unknown> {
        calls.push({ route: options.route, body: options.body });
        if (refusal !== null) {
          throw new DiscordApiError({
            status: refusal.status,
            route: options.route,
            method: options.method,
            body: JSON.stringify({ code: refusal.code, message: refusal.message }),
          });
        }
        return {};
      },
    } as unknown as Parameters<typeof pullMember>[0]["client"],
  };
}

/** one step of a scripted exchange. a step with no status answers 2xx. */
interface Step {
  readonly status?: number;
  readonly code?: number;
  readonly message?: string;
  /** the request never reached discord. */
  readonly transport?: boolean;
}

/** a client that answers the steps in order, and repeats the last one. */
function sequence(steps: readonly Step[]) {
  const calls: { route: string; body: unknown }[] = [];
  let index = 0;
  return {
    calls,
    client: {
      async request(options: { method: string; route: string; body?: unknown }): Promise<unknown> {
        calls.push({ route: options.route, body: options.body });
        const step = steps[Math.min(index, steps.length - 1)];
        index += 1;
        if (step?.transport === true) throw new Error("the connection dropped");
        if (step?.status !== undefined) {
          throw new DiscordApiError({
            status: step.status,
            route: options.route,
            method: options.method,
            body: JSON.stringify({
              code: step.code ?? 0,
              message: step.message ?? "401: Unauthorized",
            }),
          });
        }
        return {};
      },
    } as unknown as Parameters<typeof pullMember>[0]["client"],
  };
}

const LIMITS = { dailyLimit: 100, failureCooldownMinutes: 60, restrictedHours: 24 };

function engineDeps(
  client: Parameters<typeof pullMember>[0]["client"],
  refresh: (userId: string) => Promise<string | null>,
): PullEngineDeps {
  return {
    client,
    db,
    log: createLogger({ level: "error", dir: null }),
    limits: LIMITS,
    refresh,
  };
}

describe("pullMember", () => {
  test("a 2xx is an added member, and the attempt row says so", async () => {
    const user = "111111111111111111";
    const fake = client(null);
    const result = await pullMember(
      { client: fake.client, db, log: createLogger({ level: "error", dir: null }) },
      { guildId: GUILD, userId: user, accessToken: "a-token" },
    );
    expect(result.outcome).toBe("added");
    expect(fake.calls[0]?.route).toBe(`/guilds/${GUILD}/members/${user}`);
    const attempts = await listPullAttemptsByUser(db, user, 10);
    expect(attempts[0]?.outcome).toBe("added");
  });

  test("the token travels in the body, and nowhere else", async () => {
    const user = "222222222222222222";
    const fake = client(null);
    await pullMember(
      { client: fake.client, db, log: createLogger({ level: "error", dir: null }) },
      { guildId: GUILD, userId: user, accessToken: "a-token" },
    );
    const body = fake.calls[0]?.body as { access_token?: string } | undefined;
    expect(body?.access_token).toBe("a-token");
  });

  test("a member who is already in the guild is its own outcome", async () => {
    const user = "333333333333333333";
    const fake = client({ status: 400, code: 30007, message: "Member already in the guild" });
    const result = await pullMember(
      { client: fake.client, db, log: createLogger({ level: "error", dir: null }) },
      { guildId: GUILD, userId: user, accessToken: "a-token" },
    );
    expect(result.outcome).toBe("already_member");
    const attempts = await listPullAttemptsByUser(db, user, 10);
    expect(attempts[0]?.outcome).toBe("already_member");
  });

  test("any other refusal keeps discord's own code and message", async () => {
    const user = "444444444444444444";
    const fake = client({ status: 403, code: 50013, message: "Missing Permissions" });
    const result = await pullMember(
      { client: fake.client, db, log: createLogger({ level: "error", dir: null }) },
      { guildId: GUILD, userId: user, accessToken: "a-token" },
    );
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("50013");
    expect(result.errorBody).toContain("Missing Permissions");
    const attempts = await listPullAttemptsByUser(db, user, 10);
    expect(attempts[0]?.error_code).toBe("50013");
  });
});

describe("the engine and a 401", () => {
  test("refreshes the token and retries the join once", async () => {
    const user = "555555555555555555";
    const fake = sequence([{ status: 401 }, {}]);
    let refreshes = 0;

    const report = await pullAccounts(
      engineDeps(fake.client, async () => {
        refreshes += 1;
        return "a-fresh-token";
      }),
      { guildId: GUILD, accounts: [{ userId: user, accessToken: "the-old-token" }] },
    );

    expect(refreshes).toBe(1);
    expect(fake.calls).toHaveLength(2);
    const body = fake.calls[1]?.body as { access_token?: string } | undefined;
    expect(body?.access_token).toBe("a-fresh-token");
    expect(report[0]?.outcome).toBe("added");
  });

  test("a 401 twice marks the account unauthorized, and the engine moves on", async () => {
    const first = "666666666666666666";
    const second = "777777777777777777";
    // the first account answers 401 twice, the second one answers clean.
    const fake = sequence([{ status: 401 }, { status: 401 }, {}]);

    const report = await pullAccounts(
      engineDeps(fake.client, async () => "a-fresh-token"),
      {
        guildId: GUILD,
        accounts: [
          { userId: first, accessToken: "the-old-token" },
          { userId: second, accessToken: "another-token" },
        ],
      },
    );

    expect(report[0]?.userId).toBe(first);
    expect(report[0]?.outcome).toBe("unauthorized");
    expect(report[1]?.userId).toBe(second);
    expect(report[1]?.outcome).toBe("added");
    expect(fake.calls).toHaveLength(3);
  });

  test("a refresh that cannot hand back a token leaves the account unauthorized", async () => {
    const user = "888888888888888888";
    const fake = sequence([{ status: 401 }, {}]);

    const report = await pullAccounts(
      engineDeps(fake.client, async () => null),
      {
        guildId: GUILD,
        accounts: [{ userId: user, accessToken: "the-old-token" }],
      },
    );

    expect(report[0]?.outcome).toBe("unauthorized");
    // no retry: there was no fresh token to try.
    expect(fake.calls).toHaveLength(1);
  });

  test("a transport failure is not a 401, so it is neither refreshed nor retried", async () => {
    const user = "999999999999999999";
    const fake = sequence([{ transport: true }]);
    let refreshes = 0;

    const report = await pullAccounts(
      engineDeps(fake.client, async () => {
        refreshes += 1;
        return "a-fresh-token";
      }),
      { guildId: GUILD, accounts: [{ userId: user, accessToken: "the-old-token" }] },
    );

    expect(refreshes).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(report[0]?.outcome).toBe("failed");
  });

  test("a 403 is not a 401, so it is not refreshed", async () => {
    const user = "121212121212121212";
    const fake = sequence([{ status: 403, code: 50013, message: "Missing Permissions" }]);
    let refreshes = 0;

    const report = await pullAccounts(
      engineDeps(fake.client, async () => {
        refreshes += 1;
        return "a-fresh-token";
      }),
      { guildId: GUILD, accounts: [{ userId: user, accessToken: "the-old-token" }] },
    );

    expect(refreshes).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(report[0]?.outcome).toBe("failed");
  });
});
