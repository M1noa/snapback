// the pull counters (D4PLAN 15.2). one row per account, per guild, per utc day.
//
// the rules exist so an account is not hammered and so a restricted account is
// not retried: a bot that keeps trying gets the bot blocked.

import type { AccountCounterRow } from "../../db/types.ts";

export interface PullLimits {
  /** how many attempts an account may make in a day. */
  readonly dailyLimit: number;
  /** how long a burst of failures puts the account on hold, in minutes. */
  readonly failureCooldownMinutes: number;
  /** how long a restricted account stays restricted, in hours. */
  readonly restrictedHours: number;
}

export interface CounterDecision {
  readonly allowed: boolean;
  /** why not, in the operator's words. null when it is allowed. */
  readonly reason: string | null;
  /** when the account may be tried again, or null when it may be tried now. */
  readonly retryAfter: string | null;
  /** true when only a manual check can lift this. */
  readonly restricted: boolean;
}

/** the utc day a moment belongs to. the counter resets at midnight utc. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** the decision, given the counter row and the moment. */
export function decideAttempt(
  counter: AccountCounterRow | null,
  now: Date,
  limits: PullLimits,
): CounterDecision {
  if (counter === null) {
    return { allowed: true, reason: null, retryAfter: null, restricted: false };
  }

  if (counter.restricted) {
    const until = counter.restricted_at === null ? null : Date.parse(counter.restricted_at);
    const expired = until !== null && until + limits.restrictedHours * 3_600_000 <= now.getTime();
    if (!expired) {
      return {
        allowed: false,
        reason:
          counter.restricted_reason ??
          "discord restricted this account, so it is not retried until the restriction is lifted",
        retryAfter: counter.restricted_at,
        restricted: true,
      };
    }
  }

  if (counter.cooldown_until !== null) {
    const until = Date.parse(counter.cooldown_until);
    if (Number.isFinite(until) && until > now.getTime()) {
      return {
        allowed: false,
        reason: `the account is on a cooldown after ${counter.failures} failure(s)`,
        retryAfter: counter.cooldown_until,
        restricted: false,
      };
    }
  }

  if (counter.attempts >= limits.dailyLimit) {
    return {
      allowed: false,
      reason: `the account has used its ${limits.dailyLimit} attempt(s) for today`,
      retryAfter: null,
      restricted: false,
    };
  }

  return { allowed: true, reason: null, retryAfter: null, restricted: false };
}

/** the row after a success: the failure streak is gone and the day counts up. */
export function noteSuccess(
  counter: AccountCounterRow | null,
  now: Date,
  userId: string,
  guildId: string,
): AccountCounterRow {
  const base = counter ?? blankCounter(userId, guildId, now);
  return {
    ...base,
    attempts: base.attempts + 1,
    successes: base.successes + 1,
    failures: 0,
    cooldown_until: null,
    updated_at: now.toISOString(),
  };
}

/** the row after a failure. a streak puts the account on a cooldown. */
export function noteFailure(
  counter: AccountCounterRow | null,
  now: Date,
  limits: PullLimits,
  userId: string,
  guildId: string,
  reason: string | null = null,
): AccountCounterRow {
  const base = counter ?? blankCounter(userId, guildId, now);
  const failures = base.failures + 1;
  // a burst of failures is what a cooldown is for: the third one in a day is
  // where the account waits.
  const onCooldown = failures >= 3;
  return {
    ...base,
    attempts: base.attempts + 1,
    failures,
    cooldown_until: onCooldown
      ? new Date(now.getTime() + limits.failureCooldownMinutes * 60_000).toISOString()
      : null,
    restricted_reason: reason ?? base.restricted_reason,
    updated_at: now.toISOString(),
  };
}

/** the row for an account that discord refused outright. */
export function noteRestricted(
  counter: AccountCounterRow | null,
  now: Date,
  userId: string,
  guildId: string,
  reason: string,
): AccountCounterRow {
  const base = counter ?? blankCounter(userId, guildId, now);
  return {
    ...base,
    attempts: base.attempts + 1,
    failures: base.failures + 1,
    restricted: true,
    restricted_reason: reason,
    restricted_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

/** a fresh row for today. */
export function blankCounter(userId: string, guildId: string, now: Date): AccountCounterRow {
  return {
    user_id: userId,
    guild_id: guildId,
    day: utcDay(now),
    attempts: 0,
    successes: 0,
    failures: 0,
    cooldown_until: null,
    restricted: false,
    restricted_reason: null,
    restricted_at: null,
    updated_at: now.toISOString(),
  };
}
