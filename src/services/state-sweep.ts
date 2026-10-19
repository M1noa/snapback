// the interaction-state sweep. a confirmation nonce lives for fifteen minutes and
// then it is gone, whether or not anybody came back for it.
//
// the table is the sweeper's, and the in-memory store has its own sweep. this one
// is for the multi-worker deploy.

import { deleteExpiredInteractionState } from "../db/queries/interaction-state.ts";
import type { Database } from "../db/types.ts";

/** how many expired rows went, and the rows are gone with them. */
export async function sweepExpiredStates(db: Database, now: number): Promise<number> {
  return await deleteExpiredInteractionState(db, new Date(now).toISOString());
}
