// the pull engine (D4PLAN 15). it takes the accounts that hold a token, asks
// the counters whether they may be tried, and pulls the ones that may.
//
// it never retries a restricted account on its own, and it never waits with a
// sleep: the shared limiter (src/discord/ratelimit.ts) does the waiting, by
// reading discord's own headers.

import { getAccountCounter, upsertAccountCounter } from "../../db/queries/counters.ts";
import { insertPullAttempt } from "../../db/queries/pull-attempts.ts";
import type { Database } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import type { Logger } from "../../lib/log.ts";
import {
  decideAttempt,
  noteFailure,
  noteRestricted,
  noteSuccess,
  type PullLimits,
  utcDay,
} from "./counter.ts";
import { type PullResult, pullMember } from "./member.ts";

export interface PullAccount {
  readonly userId: string;
  /** the token the member granted. it never reaches a log line. */
  readonly accessToken: string;
}

export interface PullEngineDeps {
  readonly client: DiscordClient;
  readonly db: Database;
  readonly log: Logger;
  readonly limits: PullLimits;
  readonly now?: () => Date;
}

export interface PullOutcomeReport {
  readonly userId: string;
  readonly outcome: PullResult["outcome"] | "skipped";
  readonly errorCode: string | null;
  readonly errorBody: string | null;
  /** why it was skipped, when it was. */
  readonly reason: string | null;
}

/** pull every account into one guild, and report each one. */
export async function pullAccounts(
  deps: PullEngineDeps,
  input: { guildId: string; accounts: readonly PullAccount[] },
): Promise<PullOutcomeReport[]> {
  const now = deps.now?.() ?? new Date();
  const reports: PullOutcomeReport[] = [];

  for (const account of input.accounts) {
    const counter = await getAccountCounter(deps.db, account.userId, input.guildId, utcDay(now));
    const decision = decideAttempt(counter, now, deps.limits);

    if (!decision.allowed) {
      reports.push({
        userId: account.userId,
        outcome: "skipped",
        errorCode: null,
        errorBody: null,
        reason: decision.reason,
      });
      // a skipped attempt is still an attempt row: the operator can see that the
      // bot considered it and why it did nothing.
      await recordAttempt(
        deps,
        input.guildId,
        account.userId,
        now,
        "skipped",
        null,
        decision.reason,
      );
      continue;
    }

    const result = await pullMember(deps, {
      guildId: input.guildId,
      userId: account.userId,
      accessToken: account.accessToken,
    });

    const updated = await applyOutcome(deps, counter, now, input.guildId, account.userId, result);
    await upsertAccountCounter(deps.db, updated);

    reports.push({
      userId: account.userId,
      outcome: result.outcome,
      errorCode: result.errorCode,
      errorBody: result.errorBody,
      reason: null,
    });
  }

  return reports;
}

/** the counter row after the attempt. */
async function applyOutcome(
  deps: PullEngineDeps,
  counter: Awaited<ReturnType<typeof getAccountCounter>>,
  now: Date,
  guildId: string,
  userId: string,
  result: PullResult,
): Promise<Awaited<ReturnType<typeof getAccountCounter>> & object> {
  if (result.outcome === "added" || result.outcome === "already_member") {
    return noteSuccess(counter, now, userId, guildId);
  }
  // a hard refusal from discord is a restriction, not a streak.
  if (isRestriction(result.errorCode)) {
    return noteRestricted(counter, now, userId, guildId, result.errorBody ?? "restricted");
  }
  return noteFailure(counter, now, deps.limits, userId, guildId, result.errorBody);
}

/** the codes that mean the account itself is restricted. */
function isRestriction(code: string | null): boolean {
  if (code === null) return false;
  // 20013 is "account is restricted", 20035 is "user is restricted".
  return code === "20013" || code === "20035";
}

async function recordAttempt(
  deps: PullEngineDeps,
  guildId: string,
  userId: string,
  now: Date,
  outcome: "skipped",
  errorCode: string | null,
  reason: string | null,
): Promise<void> {
  await insertPullAttempt(deps.db, {
    id: Bun.randomUUIDv7(),
    guild_id: guildId,
    user_id: userId,
    attempted_at: now.toISOString(),
    outcome,
    error_code: errorCode,
    error_body: reason,
  });
}
