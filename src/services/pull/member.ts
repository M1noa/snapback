// adding one member to one guild (D4PLAN 15.3).
//
// the token is one the member granted themselves through the oauth flow. there is
// no other path, and a token is never written to a log line.

import { insertPullAttempt } from "../../db/queries/pull-attempts.ts";
import type { Database, PullOutcome } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";

export interface PullResult {
  readonly outcome: PullOutcome;
  readonly errorCode: string | null;
  readonly errorBody: string | null;
}

export interface PullDeps {
  readonly client: DiscordClient;
  readonly db: Database;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** discord's own words for a member who is already in the guild. */
function alreadyMember(error: DiscordApiError): boolean {
  if (error.code === null) return false;
  // 10013 is "unknown member" and 30007 is "member already in the guild".
  return error.code === 30007 || /already.*(member|joined)/i.test(error.message);
}

/** the one call: the member's own token adds them to the guild. */
export async function pullMember(
  deps: PullDeps,
  input: { guildId: string; userId: string; accessToken: string },
): Promise<PullResult> {
  const now = deps.now?.() ?? new Date();
  let outcome: PullOutcome = "failed";
  let errorCode: string | null = null;
  let errorBody: string | null = null;

  try {
    await deps.client.request({
      method: "PUT",
      route: `/guilds/${input.guildId}/members/${input.userId}`,
      body: { access_token: input.accessToken },
    });
    outcome = "added";
  } catch (error) {
    if (error instanceof DiscordApiError) {
      errorCode = error.code === null ? String(error.status) : String(error.code);
      errorBody = formatDiscordError(error).said;
      outcome = alreadyMember(error) ? "already_member" : "failed";
    } else {
      errorBody = error instanceof Error ? error.message : String(error);
      outcome = "failed";
    }
  }

  // the attempt is recorded whatever happened, so the history of an account is
  // visible and not only its last state.
  await insertPullAttempt(deps.db, {
    id: Bun.randomUUIDv7(),
    guild_id: input.guildId,
    user_id: input.userId,
    attempted_at: now.toISOString(),
    outcome,
    error_code: errorCode,
    error_body: errorBody,
  });

  if (outcome === "failed") {
    // the reason goes to the log without the token.
    deps.log.warn("pull attempt failed", {
      guildId: input.guildId,
      userId: input.userId,
      code: errorCode,
      said: errorBody,
    });
  }

  return { outcome, errorCode, errorBody };
}
