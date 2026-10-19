// the token refresh sweep (D4PLAN 13.5). find the records whose access token
// has expired, refresh each one, and write an event for every outcome.
//
// a network failure is not a refused token: the record keeps its status and the
// next sweep tries again. the token store owns the token columns, so this sweep
// only counts, notes the outcome, and never logs a token.
//
// the refresh callback is keyed by user, because the token store keeps one live
// token per user: a user with a record in two servers is refreshed once in a
// sweep, and every due record of that user gets the outcome event.

import * as recordsDb from "../../db/queries/verify-records.ts";
import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import { addRecordEvent } from "./records.ts";

const MAX_BATCH = 1_000;

export interface RefreshDeps {
  readonly db: Database;
  readonly log: Logger;
  /** refresh the token of one user. true when it was refreshed. */
  readonly refresh: (userId: string) => Promise<boolean>;
  /** injectable clock in epoch ms. */
  readonly now?: () => number;
  /** narrows the sweep to one server, which is what /verify refresh does.
   *  without it the sweep covers every guild. */
  readonly guildId?: string;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_BATCH;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_BATCH);
}

/** one sweep. every due record gets an event, whichever way it went. */
export async function refreshDue(
  deps: RefreshDeps,
  limit: number,
): Promise<{ refreshed: number; failed: number }> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const due = await recordsDb.listDueRecords(deps.db, at, clampLimit(limit), deps.guildId);
  // the event timeline runs on an iso clock, and this sweep reads one.
  const events = { db: deps.db, log: deps.log, now: () => at };
  // one outcome per user, because the token store refreshes one token per user.
  const outcomes = new Map<string, boolean>();
  let refreshed = 0;
  let failed = 0;

  for (const record of due) {
    let ok = outcomes.get(record.user_id);
    if (ok === undefined) {
      ok = false;
      try {
        ok = await deps.refresh(record.user_id);
      } catch (error) {
        // a transport failure is not an invalid_grant, so the record keeps its
        // status and the next sweep tries again.
        deps.log.warn("the token refresh threw", {
          recordId: record.record_id,
          guildId: record.guild_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      outcomes.set(record.user_id, ok);
    }

    if (ok) {
      refreshed += 1;
      await recordsDb.setRecordLastChecked(deps.db, record.record_id, at);
      await addRecordEvent(events, {
        userId: record.user_id,
        guildId: record.guild_id,
        kind: "refreshed_ok",
      });
    } else {
      failed += 1;
      await addRecordEvent(events, {
        userId: record.user_id,
        guildId: record.guild_id,
        kind: "refreshed_fail",
      });
    }
  }

  deps.log.info("verify refresh sweep finished", {
    checked: due.length,
    refreshed,
    failed,
    users: outcomes.size,
  });
  return { refreshed, failed };
}
