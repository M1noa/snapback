// the pull engine (D4PLAN 15). it takes the accounts that hold a token, asks
// the counters whether they may be tried, and pulls the ones that may.
//
// it never retries a restricted account on its own, and it never waits with a
// sleep: the shared limiter (src/discord/ratelimit.ts) does the waiting, by
// reading discord's own headers.
//
// one retry exists. a join that answers 401 means the access token is stale,
// not that the grant died, so the token is refreshed once and the join is
// tried once more. a second 401, or a refresh that cannot hand back a token,
// means the grant is dead: the account is unauthorized and the run moves on.
// a transport failure is not a 401, so it is neither refreshed nor retried.

import { getAccountCounter, upsertAccountCounter } from "../../db/queries/counters.ts";
import { insertPullAttempt } from "../../db/queries/pull-attempts.ts";
import type { AccountCounterRow, Database } from "../../db/types.ts";
import type { DiscordClient, RequestOptions } from "../../discord/client.ts";
import { DiscordApiError } from "../../discord/errors.ts";
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
  /**
   * a fresh access token for a user, or null when there is none: the grant is
   * dead, or the refresh could not reach discord. the engine calls it once,
   * and only after a 401.
   */
  readonly refresh: (userId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

export interface PullOutcomeReport {
  readonly userId: string;
  readonly outcome: PullResult["outcome"] | "skipped" | "unauthorized";
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

    const attempt = await attemptJoin(deps, input.guildId, account);
    const updated = await applyOutcome(deps, counter, now, input.guildId, account.userId, attempt);
    await upsertAccountCounter(deps.db, updated);

    reports.push({
      userId: account.userId,
      outcome: attempt.unauthorized ? "unauthorized" : attempt.result.outcome,
      errorCode: attempt.result.errorCode,
      errorBody: attempt.result.errorBody,
      reason: null,
    });
  }

  return reports;
}

/** the join, and the one retry a stale token earns. */
async function attemptJoin(
  deps: PullEngineDeps,
  guildId: string,
  account: PullAccount,
): Promise<{ result: PullResult; unauthorized: boolean }> {
  const watcher = watchStatus(deps.client);
  const first = await pullMember(memberDeps(deps, watcher.client), {
    guildId,
    userId: account.userId,
    accessToken: account.accessToken,
  });
  // a transport failure never reached discord, so it is not a 401: it is not a
  // refresh trigger and it is not retried.
  if (watcher.status() !== 401) return { result: first, unauthorized: false };

  deps.log.info("pull join answered 401, the token is refreshed once", {
    guildId,
    userId: account.userId,
  });

  const fresh = await deps.refresh(account.userId);
  if (fresh === null) {
    // the grant is dead: the account is unauthorized and the run moves on.
    return { result: first, unauthorized: true };
  }

  const second = await pullMember(memberDeps(deps, watcher.client), {
    guildId,
    userId: account.userId,
    accessToken: fresh,
  });
  if (watcher.status() === 401) return { result: second, unauthorized: true };
  return { result: second, unauthorized: false };
}

/** the deps pullMember needs. the engine's own deps carry more than that. */
function memberDeps(
  deps: PullEngineDeps,
  client: DiscordClient,
): { client: DiscordClient; db: Database; log: Logger; now?: () => Date } {
  return { client, db: deps.db, log: deps.log, now: deps.now };
}

/**
 * the status of the last refusal, so the engine can tell a 401 from a 403.
 * the client is wrapped, not replaced: the limiter and the error parsing
 * still apply, and only `request` is needed, so the wrapper carries that one
 * method.
 */
function watchStatus(client: DiscordClient): {
  client: DiscordClient;
  status: () => number | null;
} {
  let last: number | null = null;
  const wrapped = {
    request: async <T>(options: RequestOptions): Promise<T> => {
      last = null;
      try {
        return await client.request<T>(options);
      } catch (error) {
        if (error instanceof DiscordApiError) last = error.status;
        throw error;
      }
    },
  } as unknown as DiscordClient;
  return { client: wrapped, status: () => last };
}

/** the counter row after the attempt. */
async function applyOutcome(
  deps: PullEngineDeps,
  counter: AccountCounterRow | null,
  now: Date,
  guildId: string,
  userId: string,
  attempt: { result: PullResult; unauthorized: boolean },
): Promise<AccountCounterRow> {
  const result = attempt.result;
  if (result.outcome === "added" || result.outcome === "already_member") {
    return noteSuccess(counter, now, userId, guildId);
  }
  // a dead grant is a failure of the attempt, not a restriction: discord did
  // not restrict the account, the token simply does not work any more.
  if (attempt.unauthorized) {
    return noteFailure(counter, now, deps.limits, userId, guildId, result.errorBody);
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
