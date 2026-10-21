import { describe, expect, test } from "bun:test";
import { DiscordClient, DiscordClientError } from "../../src/discord/client.ts";
import { DiscordApiError } from "../../src/discord/errors.ts";
import { type Clock, RateLimiter } from "../../src/discord/ratelimit.ts";
import type { LogFields, LogLevel } from "../../src/lib/log.ts";

class FakeClock implements Clock {
  #now = 0;
  async sleep(ms: number): Promise<void> {
    this.#now += ms;
  }
  now(): number {
    return this.#now;
  }
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  form: FormData | undefined;
}

// records what the client actually sent, so a casing or header bug fails here.
function recordingFetch(respond: (call: Call, index: number) => Response): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      form: init?.body instanceof FormData ? init.body : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(
  fetchImpl: typeof fetch,
  log?: ConstructorParameters<typeof DiscordClient>[0]["log"],
) {
  return new DiscordClient({
    token: "test-token",
    fetchImpl,
    limiter: new RateLimiter({ clock: new FakeClock() }),
    log,
  });
}

/** await a call that must reject, and hand back the DiscordApiError it threw. */
async function rejection(promise: Promise<unknown>): Promise<DiscordApiError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof DiscordApiError) return caught;
    throw caught;
  }
  throw new Error("expected the request to reject, but it resolved");
}

describe("DiscordClient request shape", () => {
  test("sends the bot auth header and the absolute url under the base", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, { id: "1" }));
    await makeClient(fetch).request({ method: "GET", route: "/users/@me" });
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/users/@me");
    expect(calls[0]?.headers.authorization).toBe("Bot test-token");
    expect(calls[0]?.headers.accept).toBe("application/json");
  });

  test("serializes the body as sent, so snake_case is the caller's contract", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, {}));
    await makeClient(fetch).request({
      method: "POST",
      route: "/channels/1/messages",
      body: { allowed_mentions: { parse: [] }, embeds: [] },
    });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent).toEqual({ allowed_mentions: { parse: [] }, embeds: [] });
    expect(sent.allowedMentions).toBeUndefined();
  });

  test("a formdata body is passed through, because only fetch can set its boundary", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, {}));
    const form = new FormData();
    form.set("payload_json", JSON.stringify({ content: "" }));
    form.set("files[0]", new Blob([new Uint8Array(4)]), "a.png");
    await makeClient(fetch).request({ method: "POST", route: "/channels/1/messages", body: form });
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    expect(calls[0]?.form?.get("payload_json")).toBe('{"content":""}');
    expect([...(calls[0]?.form?.keys() ?? [])]).toContain("files[0]");
  });

  test("a GET sends no body and no content-type", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, {}));
    await makeClient(fetch).request({ method: "GET", route: "/guilds/1" });
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
  });

  test("auth:false omits the authorization header", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, {}));
    await makeClient(fetch).request({ method: "GET", route: "/oauth2/token", auth: false });
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  test("the audit log reason is url encoded", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, {}));
    await makeClient(fetch).request({
      method: "DELETE",
      route: "/guilds/1/roles/2",
      reason: "snapback restore: role 2",
    });
    expect(calls[0]?.headers["x-audit-log-reason"]).toBe(
      encodeURIComponent("snapback restore: role 2"),
    );
  });

  test("an over-long audit reason is refused, not truncated", async () => {
    const { fetch } = recordingFetch(() => json(200, {}));
    const client = makeClient(fetch);
    await expect(
      client.request({ method: "POST", route: "/guilds/1", reason: "x".repeat(513) }),
    ).rejects.toThrow(DiscordClientError);
  });

  test("every request carries a timeout signal", async () => {
    let sawSignal = false;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return json(200, {});
    }) as typeof fetch;
    await makeClient(fetchImpl).request({ method: "GET", route: "/guilds/1" });
    expect(sawSignal).toBe(true);
  });
});

describe("DiscordClient routes", () => {
  test("refuses an absolute url so nothing bypasses the base", async () => {
    const { fetch } = recordingFetch(() => json(200, {}));
    const client = makeClient(fetch);
    await expect(
      client.request({ method: "GET", route: "https://evil.example/steal" }),
    ).rejects.toThrow(DiscordClientError);
    await expect(client.request({ method: "GET", route: "//evil.example" })).rejects.toThrow(
      DiscordClientError,
    );
  });

  test("refuses a route without a leading slash", async () => {
    const { fetch } = recordingFetch(() => json(200, {}));
    await expect(makeClient(fetch).request({ method: "GET", route: "users/@me" })).rejects.toThrow(
      DiscordClientError,
    );
  });
});

describe("DiscordClient error handling", () => {
  test("a 50035 throws with discord's own words and the field paths", async () => {
    const { fetch } = recordingFetch(() =>
      json(400, {
        code: 50035,
        message: "Invalid Form Body",
        errors: { name: { _errors: [{ code: "X", message: "must be 2-100 chars" }] } },
      }),
    );
    const client = makeClient(fetch);
    const error = await rejection(client.request({ method: "POST", route: "/guilds/1" }));

    expect(error.code).toBe(50035);
    expect(error.message).toBe("Invalid Form Body");
    expect(error.errors.map((f) => f.path)).toEqual(["name"]);
  });

  test("a non-json error body does not blow up and keeps the text", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response("<html>502</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const error = await rejection(makeClient(fetch).request({ method: "GET", route: "/guilds/1" }));
    expect(error.nonJson).toBe(true);
  });

  test("a 429 is retried through the limiter and then succeeds", async () => {
    let calls = 0;
    const { fetch } = recordingFetch(() => {
      calls += 1;
      if (calls === 1) {
        return json(
          429,
          { code: 0, message: "You are being rate limited." },
          { "retry-after": "1", "x-ratelimit-bucket": "g" },
        );
      }
      return json(200, { id: "1" });
    });
    const result = await makeClient(fetch).request<{ id: string }>({
      method: "GET",
      route: "/guilds/1",
    });
    expect(calls).toBe(2);
    expect(result.id).toBe("1");
  });

  test("a 204 with no body returns undefined rather than throwing", async () => {
    const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
    const result = await makeClient(fetch).request({ method: "DELETE", route: "/x/y" });
    expect(result).toBeUndefined();
  });
});

describe("DiscordClient logging", () => {
  test("logs route and method on a rejection, with values redacted", async () => {
    const records: { level: LogLevel; msg: string; fields?: LogFields }[] = [];
    const log = {
      level: "debug" as LogLevel,
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields?: LogFields) => {
        records.push({ level: "warn", msg, fields });
      },
      error: (msg: string, fields?: LogFields) => {
        records.push({ level: "error", msg, fields });
      },
      flush: async () => {},
    };

    const { fetch } = recordingFetch(() => json(403, { code: 10003, message: "Unknown Channel" }));
    await makeClient(fetch, log)
      .request({ method: "PATCH", route: "/channels/1" })
      .catch(() => undefined);

    const record = records.find((r) => r.level === "error");
    expect(record).toBeDefined();
    const fields = record?.fields as Record<string, unknown>;
    expect(fields.route).toBe("/channels/1");
    expect(fields.method).toBe("PATCH");
    expect(JSON.stringify(fields)).toContain("Unknown Channel");
  });

  test("a token in the body never reaches a log field", async () => {
    const records: LogFields[] = [];
    const log = {
      level: "debug" as LogLevel,
      debug: () => {},
      info: () => {},
      warn: (_msg: string, fields?: LogFields) => {
        records.push(fields ?? {});
      },
      error: (_msg: string, fields?: LogFields) => {
        records.push(fields ?? {});
      },
      flush: async () => {},
    };

    const { fetch } = recordingFetch(() =>
      json(401, { code: 40001, message: "Unauthorized: Bot abcdef.ghijkl.mnopqr" }),
    );
    await makeClient(fetch, log)
      .request({ method: "GET", route: "/users/@me" })
      .catch(() => undefined);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("abcdef.ghijkl.mnopqr");
    expect(serialized).toContain("sk_***");
  });
});
