// tests/services/verify/role.test.ts - the last step of the flow. the role is
// added with one route, discord's refusal is carried through verbatim, and a
// grant that cannot happen is skipped rather than failed.

import { describe, expect, test } from "bun:test";
import { DiscordClient } from "../../../src/discord/client.ts";
import { RateLimiter } from "../../../src/discord/ratelimit.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { grantVerifiedRole } from "../../../src/services/verify/role.ts";

const GUILD = "144102483157850112";
const USER = "100000000000000001";
const ROLE = "144102483157850113";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly reason: string | null;
  readonly authorization: string | null;
}

// the client records exactly what it sent, so the route and the audit reason are
// asserted rather than assumed.
function stub(respond: () => Response): { client: DiscordClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input.toString(),
      reason: headers["x-audit-log-reason"] ?? null,
      authorization: headers.authorization ?? null,
    });
    return respond();
  }) as typeof fetch;

  return {
    client: new DiscordClient({
      token: "test-token",
      fetchImpl,
      limiter: new RateLimiter(),
    }),
    calls,
  };
}

function deps(respond: () => Response) {
  const { client, calls } = stub(respond);
  return { deps: { client, log: createLogger({ level: "error", dir: null }) }, calls };
}

const noContent = () => new Response(null, { status: 204 });

describe("granting the verified role", () => {
  test("one put to the member roles route with an audit reason", async () => {
    const { deps: d, calls } = deps(noContent);
    const result = await grantVerifiedRole(d, { guildId: GUILD, userId: USER, roleId: ROLE });

    expect(result).toEqual({ outcome: "granted", said: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE}`,
    );
    expect(calls[0]?.reason).toBe(encodeURIComponent("snapback verification"));
    expect(calls[0]?.authorization).toBe("Bot test-token");
  });

  test("no role set means nothing is asked of discord", async () => {
    const { deps: d, calls } = deps(noContent);
    const result = await grantVerifiedRole(d, { guildId: GUILD, userId: USER, roleId: null });

    expect(result).toEqual({ outcome: "skipped", said: null });
    expect(calls).toHaveLength(0);
  });

  test("a web verification carries no guild, so no role", async () => {
    const { deps: d, calls } = deps(noContent);
    const result = await grantVerifiedRole(d, { guildId: null, userId: USER, roleId: ROLE });

    expect(result).toEqual({ outcome: "skipped", said: null });
    expect(calls).toHaveLength(0);
  });

  test("a refusal keeps discord's own code and message", async () => {
    const { deps: d } = deps(
      () =>
        new Response(JSON.stringify({ code: 50013, message: "Missing Permissions" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await grantVerifiedRole(d, { guildId: GUILD, userId: USER, roleId: ROLE });

    expect(result.outcome).toBe("failed");
    expect(result.said).toBe("50013 Missing Permissions");
  });

  test("a request that never landed is a failure, not a crash", async () => {
    const { deps: d } = deps(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await grantVerifiedRole(d, { guildId: GUILD, userId: USER, roleId: ROLE });

    expect(result.outcome).toBe("failed");
    expect(result.said).toContain("ECONNREFUSED");
  });
});
