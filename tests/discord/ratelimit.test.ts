import { describe, expect, test } from "bun:test";
import { type Clock, RateLimiter } from "../../src/discord/ratelimit.ts";

// a clock that advances only when something sleeps, so a test asserting a wait
// also proves the limiter did not busy-poll.
class FakeClock implements Clock {
  #now = 1_000_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.#now;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
  }

  get total(): number {
    return this.sleeps.reduce((sum, ms) => sum + ms, 0);
  }
}

function jsonResponse(status: number, headers: Record<string, string> = {}, body = "{}"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("RateLimiter", () => {
  test("a clean 200 does not sleep", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    const response = await limiter.run("/guilds/1", async () => jsonResponse(200));
    expect(response.status).toBe(200);
    expect(clock.sleeps).toEqual([]);
  });

  test("waits exactly reset-after when remaining hits zero", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    let calls = 0;
    const task = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(200, {
            "x-ratelimit-bucket": "abc",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": "2.5",
          })
        : jsonResponse(200, { "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "5" });
    };

    await limiter.run("/guilds/1", task);
    await limiter.run("/guilds/1", task);

    expect(clock.sleeps).toEqual([2500]);
  });

  test("remaining above zero means no wait", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    const task = async () =>
      jsonResponse(200, {
        "x-ratelimit-bucket": "abc",
        "x-ratelimit-remaining": "3",
        "x-ratelimit-reset-after": "5",
      });
    await limiter.run("/a", task);
    await limiter.run("/a", task);
    expect(clock.sleeps).toEqual([]);
  });

  test("a 429 waits retry-after exactly and retries", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    let calls = 0;
    const response = await limiter.run("/channels/1/messages", async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          429,
          { "x-ratelimit-bucket": "msg", "retry-after": "0.75", "x-ratelimit-remaining": "0" },
          JSON.stringify({ code: 0, message: "You are being rate limited." }),
        );
      }
      return jsonResponse(200, { "x-ratelimit-bucket": "msg", "x-ratelimit-remaining": "5" });
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([750]);
  });

  test("a global 429 holds every route, not just the one that saw it", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    await limiter.run("/a", async () =>
      jsonResponse(
        429,
        { "x-ratelimit-global": "true", "retry-after": "1" },
        JSON.stringify({ code: 0, message: "global" }),
      ),
    );
    clock.sleeps.length = 0;

    await limiter.run("/b", async () => jsonResponse(200));
    expect(clock.sleeps).toEqual([1000]);
  });

  test("a 5xx backs off rather than hot-looping", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    let calls = 0;
    const response = await limiter.run("/a", async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(502, {}, "bad gateway") : jsonResponse(200);
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    // 500 then 1000, doubling
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  test("stops retrying after maxRetries and returns the last response", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock, maxRetries: 2 });
    let calls = 0;
    const response = await limiter.run("/a", async () => {
      calls += 1;
      return jsonResponse(503);
    });
    expect(response.status).toBe(503);
    expect(calls).toBe(3); // the first try plus two retries
  });

  test("onWait reports the route, the delay and the reason", async () => {
    const clock = new FakeClock();
    const waits: { route: string; ms: number; reason: string }[] = [];
    const limiter = new RateLimiter({
      clock,
      onWait: (event) => waits.push({ route: event.route, ms: event.ms, reason: event.reason }),
    });
    await limiter.run("/a", async () =>
      jsonResponse(200, {
        "x-ratelimit-bucket": "b",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "1.25",
      }),
    );
    await limiter.run("/a", async () => jsonResponse(200));
    expect(waits).toEqual([{ route: "/a", ms: 1250, reason: "bucket" }]);
  });

  test("never sleeps for a zero or negative wait", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    await limiter.run("/a", async () =>
      jsonResponse(200, {
        "x-ratelimit-bucket": "b",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "0",
      }),
    );
    await limiter.run("/a", async () => jsonResponse(200));
    expect(clock.sleeps).toEqual([]);
  });

  test("a 429 with no retry-after header does not spin or hang", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });

    await limiter.run("/a", async () =>
      jsonResponse(429, { "x-ratelimit-bucket": "b" }, JSON.stringify({ code: 0 })),
    );
    await limiter.run("/a", async () => jsonResponse(200, { "x-ratelimit-bucket": "b" }));
    // no header means reset right now, so nothing waits and nothing spins
    expect(clock.total).toBe(0);
  });

  test("two calls to one bucket do not race the headers", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ clock });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(`start ${name}`);
      await Promise.resolve();
      order.push(`end ${name}`);
      return jsonResponse(200, {
        "x-ratelimit-bucket": "shared",
        "x-ratelimit-remaining": "1",
      });
    };
    await Promise.all([limiter.run("/a", task("one")), limiter.run("/a", task("two"))]);
    // serialized: one fully finishes before the other starts
    expect(order).toEqual(["start one", "end one", "start two", "end two"]);
  });

  test("snapshot reports the bucket count for diagnostics", async () => {
    const limiter = new RateLimiter({ clock: new FakeClock() });
    expect(limiter.snapshot().buckets).toBe(0);
    await limiter.run("/a", async () => jsonResponse(200, { "x-ratelimit-bucket": "b" }));
    expect(limiter.snapshot().buckets).toBe(1);
  });
});
