// the mirrors. verify, pull and the blacklist write here so one timeline holds
// everything, and a tracking failure never breaks the action that wrote it.
import type { Logger } from "../../lib/log.ts";
import type { TrackInput, TrackingService } from "./index.ts";

/** the only thing a mirror needs. a test can pass a spy. */
export type Tracker = Pick<TrackingService, "record">;

/** record one event, or swallow it. this is called from inside handlers that
 *  already did the work, so nothing here may throw back at them. */
export async function mirror(
  tracking: Tracker | null | undefined,
  log: Logger,
  input: TrackInput,
): Promise<void> {
  if (tracking === null || tracking === undefined) return;
  try {
    await tracking.record(input);
  } catch (error) {
    log.error("tracking mirror failed", {
      kind: input.kind,
      guild: input.guildId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** sorted guild ids out of an oauth guild list, for the verify_guilds diff. */
export function guildIds(list: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") ids.push(id);
  }
  return ids.sort();
}

/** what changed between two guild lists. plain ids, keeps the row small. */
export function guildDiff(
  before: readonly string[],
  after: readonly string[],
): { count: number; added: string[]; removed: string[] } {
  const had = new Set(before);
  const has = new Set(after);
  return {
    count: after.length,
    added: after.filter((id) => !had.has(id)),
    removed: before.filter((id) => !has.has(id)),
  };
}
