// discord/ratelimit.ts (AGENTS.md rule 4, D4PLAN 16).
//
// the rule: never sleep() at a fixed value to dodge a rate limit. a fixed sleep
// is too slow on a quiet token and too fast on a busy one. this reads the
// X-RateLimit-* headers and the 429 retry_after, and waits exactly as long as
// discord said, per bucket.
//
// the clock is injectable, so tests assert the waits without waiting.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export type WaitReason = "bucket" | "global" | "retry";

export interface WaitEvent {
  readonly route: string;
  readonly ms: number;
  readonly reason: WaitReason;
  readonly attempt: number;
}

export interface RateLimiterOptions {
  readonly clock?: Clock;
  /** how many times a 429 or 5xx is retried before the response is returned as-is. */
  readonly maxRetries?: number;
  /** called before every wait, for a log line. never called with ms <= 0. */
  readonly onWait?: (event: WaitEvent) => void;
}

interface BucketState {
  remaining: number;
  resetAt: number;
}

// a 5xx is discord's problem, not ours; back off and try again rather than
// hot-looping. 500ms doubling, capped so a bad minute does not become a stall.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

// x-ratelimit-reset-after and retry-after are seconds, as a float.
function secondsToMs(header: string | null): number | null {
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

interface Verdict {
  readonly retry: boolean;
  /** 0 means "do not sleep here"; a bucket or global wait already covers it. */
  readonly delayMs: number;
  readonly reason: WaitReason | null;
}

export class RateLimiter {
  readonly #clock: Clock;
  readonly #maxRetries: number;
  readonly #onWait: ((event: WaitEvent) => void) | undefined;

  /** bucket hash -> state, learned from x-ratelimit-bucket. */
  readonly #buckets = new Map<string, BucketState>();
  /** route -> bucket hash, learned from the first response for that route. */
  readonly #routeBucket = new Map<string, string>();
  /** per-bucket promise chain, so two calls to one bucket never race the headers. */
  readonly #chains = new Map<string, Promise<unknown>>();

  #globalResetAt = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#onWait = options.onWait;
  }

  /**
   * runs task under the limiter. task must build a FRESH request each call,
   * because a consumed body cannot be resent on a retry; returning a Response
   * rather than a promise of one is what makes the retry honest.
   */
  async run(route: string, task: () => Promise<Response>): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.#serialize(route, async () => {
        const waited = await this.#waitForTurn(route);
        if (waited > 0) {
          this.#onWait?.({ route, ms: waited, reason: this.#waitReason(route), attempt });
        }
        return await task();
      });

      const verdict = this.#applyHeaders(route, response, attempt);
      if (!verdict.retry || attempt >= this.#maxRetries) return response;

      attempt += 1;
      if (verdict.delayMs > 0) {
        this.#onWait?.({
          route,
          ms: verdict.delayMs,
          reason: verdict.reason ?? "retry",
          attempt,
        });
        await this.#clock.sleep(verdict.delayMs);
      }
    }
  }

  /** current view, for /snapback diagnostics. */
  snapshot(): { buckets: number; globalResetAt: number } {
    return { buckets: this.#buckets.size, globalResetAt: this.#globalResetAt };
  }

  // one call at a time per bucket. the chain is keyed by the learned hash once we
  // have one, and by the route before that; a request queued under the route key
  // can therefore overlap the first request that learns the hash. that is a rare
  // extra parallel call, and the bucket state is still what decides the waits.
  #serialize<T>(route: string, task: () => Promise<T>): Promise<T> {
    const key = this.#routeBucket.get(route) ?? `route:${route}`;
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  async #waitForTurn(route: string): Promise<number> {
    const now = this.#clock.now();
    let until = this.#globalResetAt;

    const hash = this.#routeBucket.get(route);
    const bucket = hash === undefined ? undefined : this.#buckets.get(hash);
    if (bucket !== undefined && bucket.remaining <= 0) {
      until = Math.max(until, bucket.resetAt);
    }

    // a bucket we have never seen has no resetAt to trust, so the first call for
    // a route goes out and learns it.
    if (until <= now) {
      return 0;
    }
    const ms = until - now;
    await this.#clock.sleep(ms);
    return ms;
  }

  #waitReason(route: string): WaitReason {
    const hash = this.#routeBucket.get(route);
    const bucket = hash === undefined ? undefined : this.#buckets.get(hash);
    if (this.#globalResetAt > this.#clock.now()) return "global";
    if (bucket !== undefined && bucket.remaining <= 0) return "bucket";
    return "retry";
  }

  // reads the headers into bucket state, then decides whether to retry. mutating
  // state even on a 429 is the point: the next call's #waitForTurn sees it.
  #applyHeaders(route: string, response: Response, attempt: number): Verdict {
    const headers = response.headers;
    const hash = headers.get("x-ratelimit-bucket");
    if (hash !== null) this.#routeBucket.set(route, hash);

    const now = this.#clock.now();
    const key = hash ?? this.#routeBucket.get(route) ?? null;
    const remainingHeader = headers.get("x-ratelimit-remaining");
    const resetAfterMs = secondsToMs(headers.get("x-ratelimit-reset-after"));

    const parsedRemaining = remainingHeader === null ? null : Number(remainingHeader);
    const remaining =
      parsedRemaining !== null && Number.isFinite(parsedRemaining) ? parsedRemaining : null;

    // record the bucket even when it sent no remaining or reset header, so the
    // route -> bucket mapping is kept and diagnostics can see it. an absent field
    // leaves the previous value alone rather than inventing one.
    if (key !== null) {
      const previous = this.#buckets.get(key);
      this.#buckets.set(key, {
        remaining: remaining ?? previous?.remaining ?? 0,
        resetAt: resetAfterMs === null ? (previous?.resetAt ?? now) : now + resetAfterMs,
      });
    }

    if (response.status === 429) {
      const isGlobal = headers.get("x-ratelimit-global") === "true";
      // the header is authoritative; the json body's retry_after is the fallback
      // and needs a parse we do not have here, so an absent header means we stop.
      const retryMs = secondsToMs(headers.get("retry-after"));
      if (isGlobal) {
        const until = now + (retryMs ?? 0);
        this.#globalResetAt = Math.max(this.#globalResetAt, until);
      } else if (key !== null) {
        this.#buckets.set(key, { remaining: 0, resetAt: now + (retryMs ?? 0) });
      }
      // no sleep here: #waitForTurn covers it on the next pass, which keeps the
      // wait in one place and avoids waiting twice.
      return { retry: true, delayMs: 0, reason: isGlobal ? "global" : "bucket" };
    }

    if (response.status >= 500) {
      const delayMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      return { retry: true, delayMs, reason: "retry" };
    }

    return { retry: false, delayMs: 0, reason: null };
  }
}
