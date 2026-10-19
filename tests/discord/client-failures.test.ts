// tests/discord/client-failures.test.ts
//
// the failure injection (D4TODO phase 12). every shape a call can come back in,
// and what each one produces.
//
// the rule is D4PLAN 18.1: a discord error keeps discord's own code and message, a
// body we cannot parse is labelled as such rather than guessed at, and a request
// that never landed is one of ours with one fixed message.

import { describe, expect, test } from "bun:test";
import { DiscordClient, DiscordClientError } from "../../src/discord/client.ts";
import { DiscordApiError, formatDiscordError } from "../../src/discord/errors.ts";
import { createLogger } from "../../src/lib/log.ts";

// the fetch type carries a preconnect member bun's implementation has and a
// fake does not, so the fake is cast once here.
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function clientWith(fetchImpl: FetchImpl): DiscordClient {
  return new DiscordClient({
    token: "a-token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    log: createLogger({ level: "error", dir: null }),
    // the limiter would wait on a 429; the test does not want that.
    limiter: undefined,
  });
}

describe("a refused call", () => {
  test("a 429 keeps the status and the retry after", async () => {
    const client = clientWith(
      async () =>
        new Response(JSON.stringify({ code: 0, message: "You are being rate limited." }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" },
        }),
    );
    try {
      await client.request({ method: "GET", route: "/gateway/bot" });
      throw new Error("the call should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscordApiError);
      const api = error as DiscordApiError;
      expect(api.status).toBe(429);
      expect(api.retryAfterMs).toBe(2000);
      expect(api.message).toContain("rate limited");
    }
  });

  test("a 500 keeps discord's own code and message", async () => {
    const client = clientWith(
      async () =>
        new Response(JSON.stringify({ code: 0, message: "Internal Server Error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await client.request({ method: "GET", route: "/gateway/bot" });
      throw new Error("the call should have failed");
    } catch (error) {
      const api = error as DiscordApiError;
      expect(api.status).toBe(500);
      expect(api.message).toBe("Internal Server Error");
    }
  });

  test("a 50035 keeps the field errors, because that is where the reason is", async () => {
    const body = {
      code: 50035,
      message: "Invalid Form Body",
      errors: {
        roles: {
          "0": {
            _errors: [{ code: "ROLE_TYPE", message: "The role is not a role." }],
          },
        },
      },
    };
    const client = clientWith(
      async () =>
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await client.request({ method: "PUT", route: "/guilds/1/roles", body: {} });
      throw new Error("the call should have failed");
    } catch (error) {
      const api = error as DiscordApiError;
      expect(api.code).toBe(50035);
      expect(api.errors).toBeDefined();
      expect(formatDiscordError(api).said).toBe("50035 Invalid Form Body");
    }
  });

  test("an html body is labelled as a non-json body, not parsed as json", async () => {
    const client = clientWith(
      async () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    try {
      await client.request({ method: "GET", route: "/gateway/bot" });
      throw new Error("the call should have failed");
    } catch (error) {
      const api = error as DiscordApiError;
      expect(api.status).toBe(502);
      expect(api.nonJson).toBe(true);
      // the body is kept, because it is the only thing there is.
      expect(api.body).toContain("502 Bad Gateway");
    }
  });

  test("an empty body is an error with an empty body, not a crash", async () => {
    const client = clientWith(async () => new Response("", { status: 500 }));
    try {
      await client.request({ method: "GET", route: "/gateway/bot" });
      throw new Error("the call should have failed");
    } catch (error) {
      const api = error as DiscordApiError;
      expect(api.status).toBe(500);
      expect(api.body).toBe("");
    }
  });

  test("a 200 with an empty body is an empty answer, not an error", async () => {
    const client = clientWith(async () => new Response("", { status: 200 }));
    const result = await client.request<undefined>({ method: "DELETE", route: "/channels/1" });
    expect(result).toBeUndefined();
  });

  test("a 200 with a body we cannot parse is handed back as text, with a warning", async () => {
    const client = clientWith(
      async () =>
        new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await client.request<string>({ method: "GET", route: "/gateway/bot" });
    expect(result).toBe("{not json");
  });
});

describe("a request that never landed", () => {
  test("a dropped connection is our error with a fixed message", async () => {
    const client = clientWith(async () => {
      throw new TypeError("The network connection was lost.");
    });
    try {
      await client.request({ method: "GET", route: "/gateway/bot" });
      throw new Error("the call should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscordClientError);
      const clientError = error as DiscordClientError;
      expect(clientError.code).toBe("SB_CLIENT_TRANSPORT");
      // the reason from the network is kept, and the fix is named.
      expect(clientError.message).toContain("network connection was lost");
      expect(clientError.message).toContain("check the network");
    }
  });

  test("a timeout is the same error, because it is the same kind of failure", async () => {
    const client = clientWith(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    try {
      await client.request({ method: "GET", route: "/gateway/bot" });
      throw new Error("the call should have failed");
    } catch (error) {
      expect((error as DiscordClientError).code).toBe("SB_CLIENT_TRANSPORT");
    }
  });
});
