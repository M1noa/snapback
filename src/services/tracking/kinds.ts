// services/tracking/kinds.ts
// the event vocabulary, grouped by what gates it. two switches, so the split here
// is the whole difference between "a record of my server" and "a record of my
// people": HISTORY_KINDS is state anybody could look up on the member list,
// PALANTIR_KINDS is what someone did. a kind in neither list is a bug, and the
// test below is what catches it.

import type { TrackedEventKind } from "../../db/types.ts";

/** a member's state in one guild, and the guild's own shape. these are questions
 *  you could answer by looking at the server right now, so they are on by default. */
export const HISTORY_KINDS = Object.freeze([
  // the member
  "member_join",
  "member_leave",
  "member_roles",
  "member_nickname",
  "member_username",
  "member_global_name",
  "member_avatar",
  "member_flags",
  "member_boost",
  "member_timeout",
  "member_pending",
  // verification, which is ours and not discord's
  "verify_passed",
  "verify_refused",
  "verify_revoked",
  "verify_guilds",
  // the guild itself
  "guild_update",
  "role_create",
  "role_update",
  "role_delete",
  "channel_create",
  "channel_update",
  "channel_delete",
  "emoji_update",
  "sticker_update",
  "thread_create",
  "thread_delete",
  "bot_join",
  "bot_leave",
] as const satisfies readonly TrackedEventKind[]);

/** what someone did. a stream of these is a behavioural record, which reads like
 *  surveillance even when the individual rows are innocuous, so it stays off until
 *  an operator asks for it (D4PLAN 19.5). */
export const PALANTIR_KINDS = Object.freeze([
  "voice_join",
  "voice_leave",
  "voice_move",
  "voice_state",
  "message_delete",
  "message_edit",
  "ban_add",
  "ban_remove",
  "blacklist_add",
  "blacklist_remove",
  "pull_attempt",
  "pull_added",
] as const satisfies readonly TrackedEventKind[]);

/** every kind, in one place. */
export const ALL_KINDS = Object.freeze([...HISTORY_KINDS, ...PALANTIR_KINDS]);

// a kind added to the union in db/types.ts and not to one of the two lists makes
// MissingKind something other than never, and this fails to compile. that is the
// whole exhaustiveness check: no test needs to remember to cover it.
type MissingKind = Exclude<TrackedEventKind, (typeof ALL_KINDS)[number]>;
type AssertNever<T extends never> = T;
export type KindListIsExhaustive = AssertNever<MissingKind>;

const PALANTIR_SET: ReadonlySet<string> = new Set(PALANTIR_KINDS);

/** true when a kind needs the palantir switch as well as history. */
export function needsPalantir(kind: TrackedEventKind): boolean {
  return PALANTIR_SET.has(kind);
}

/** the kinds a given pair of switches allows. called once per event, so the set is
 *  built per call rather than cached: the switches change maybe twice a year. */
export function allowedKinds(settings: {
  readonly history: boolean;
  readonly palantir: boolean;
}): ReadonlySet<TrackedEventKind> {
  if (!settings.history) return new Set();
  const allowed = new Set<TrackedEventKind>(HISTORY_KINDS);
  if (settings.palantir) for (const kind of PALANTIR_KINDS) allowed.add(kind);
  return allowed;
}
