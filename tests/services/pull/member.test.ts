// tests/services/pull/member.test.ts
//
// the one call that adds a member, and the attempt row that records it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listPullAttemptsByUser } from "../../../src/db/queries/pull-attempts.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { createLogger } from "../../../src/lib/log.ts";
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
