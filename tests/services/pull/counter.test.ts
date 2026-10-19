// tests/services/pull/counter.test.ts
//
// the counters are the only thing standing between a bot and a rate limit, and
// between an account and a restriction, so the rules get their own tests.

import { describe, expect, test } from "bun:test";
import {
  blankCounter,
  decideAttempt,
  noteFailure,
  noteRestricted,
  noteSuccess,
  type PullLimits,
  utcDay,
} from "../../../src/services/pull/counter.ts";

const LIMITS: PullLimits = {
  dailyLimit: 3,
  failureCooldownMinutes: 60,
  restrictedHours: 24,
};

const NOW = new Date("2024-06-01T12:00:00.000Z");

describe("decideAttempt", () => {
  test("an account with no counter may be tried", () => {
    const decision = decideAttempt(null, NOW, LIMITS);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
  });

  test("the daily limit stops the attempts and says so", () => {
    const counter = { ...blankCounter("1", "2", NOW), attempts: 3 };
    const decision = decideAttempt(counter, NOW, LIMITS);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("3 attempt(s)");
  });

  test("a cooldown blocks an attempt and is lifted when it passes", () => {
    const counter = {
      ...blankCounter("1", "2", NOW),
      failures: 3,
      cooldown_until: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    };
    const blocked = decideAttempt(counter, NOW, LIMITS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("cooldown");

    const later = decideAttempt(counter, new Date(NOW.getTime() + 61 * 60_000), LIMITS);
    expect(later.allowed).toBe(true);
  });

  test("a restricted account is not retried, and only a manual check lifts it", () => {
    const counter = {
      ...blankCounter("1", "2", NOW),
      restricted: true,
      restricted_reason: "20013 account is restricted",
      restricted_at: NOW.toISOString(),
    };
    const decision = decideAttempt(counter, NOW, LIMITS);
    expect(decision.allowed).toBe(false);
    expect(decision.restricted).toBe(true);
    expect(decision.reason).toContain("restricted");
  });

  test("a success clears the failure streak", () => {
    const counter = { ...blankCounter("1", "2", NOW), failures: 2 };
    const after = noteSuccess(counter, NOW, "1", "2");
    expect(after.failures).toBe(0);
    expect(after.cooldown_until).toBeNull();
    expect(after.successes).toBe(1);
    expect(after.attempts).toBe(1);
  });

  test("a burst of failures puts the account on a cooldown", () => {
    let counter = blankCounter("1", "2", NOW);
    counter = noteFailure(counter, NOW, LIMITS, "1", "2");
    expect(counter.cooldown_until).toBeNull();
    counter = noteFailure(counter, NOW, LIMITS, "1", "2");
    expect(counter.cooldown_until).toBeNull();
    counter = noteFailure(counter, NOW, LIMITS, "1", "2");
    expect(counter.cooldown_until).not.toBeNull();
  });

  test("a restriction is recorded with its reason and its time", () => {
    const counter = noteRestricted(blankCounter("1", "2", NOW), NOW, "1", "2", "20013 restricted");
    expect(counter.restricted).toBe(true);
    expect(counter.restricted_reason).toContain("20013");
    expect(counter.restricted_at).toBe(NOW.toISOString());
  });

  test("the day is a utc day, so the counter resets at midnight utc", () => {
    expect(utcDay(new Date("2024-06-01T23:59:59.000Z"))).toBe("2024-06-01");
    expect(utcDay(new Date("2024-06-02T00:00:00.000Z"))).toBe("2024-06-02");
  });
});
