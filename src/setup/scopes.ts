// the oauth scope catalogue from D4PLAN 7.2, as data. one table, so the line an
// operator reads next to a checkbox is the line the plan and the docs carry, and
// the restricted flag cannot drift from the acknowledgement rule in 7.2.

export interface ScopeEntry {
  readonly id: string;
  readonly consequence: string;
  readonly restricted: boolean;
}

// every scope the verify flow can ask for, in the order 7.2 lists them. the
// consequence strings are verbatim from the plan.
export const SCOPE_CATALOGUE: readonly ScopeEntry[] = Object.freeze([
  { id: "identify", consequence: "basic profile: id, username, avatar", restricted: false },
  { id: "email", consequence: "email address and whether it is verified", restricted: false },
  {
    id: "connections",
    consequence: "linked accounts: Steam, Twitch, GitHub, Spotify and similar",
    restricted: false,
  },
  {
    id: "guilds",
    consequence: "the list of servers they are in (names and ids, not contents)",
    restricted: false,
  },
  {
    id: "guilds.join",
    consequence: "allows the bot to add them to a server you own",
    restricted: false,
  },
  {
    id: "guilds.members.read",
    consequence: "their nickname and roles inside a server you own",
    restricted: false,
  },
  {
    id: "role_connections.write",
    consequence: "required if you use Discord's linked-roles feature",
    restricted: false,
  },
  {
    id: "webhook.incoming",
    consequence: "creates a webhook in a channel they pick",
    restricted: false,
  },
  {
    id: "relationships.read",
    consequence:
      "their friends list, pending friend requests, and blocked users. Restricted scope, requires Discord approval, and you must disclose and handle it under Discord's Social SDK terms.",
    restricted: true,
  },
  { id: "gdm.join", consequence: "join a group DM", restricted: false },
]);

export const DEFAULT_SCOPE_IDS: readonly string[] = Object.freeze([
  "identify",
  "email",
  "guilds.join",
]);

// exactly one today. derived, not hand-listed, so adding a restricted scope to
// the catalogue is the only edit the acknowledgement rule needs.
export const RESTRICTED_SCOPE_IDS: readonly string[] = Object.freeze(
  SCOPE_CATALOGUE.filter((entry) => entry.restricted).map((entry) => entry.id),
);

export function lookupScope(id: string): ScopeEntry | undefined {
  return SCOPE_CATALOGUE.find((entry) => entry.id === id);
}

/** the ids that are not in the catalogue, deduped and in first-seen order. an
 *  unrecognised id is dropped rather than requested: discord rejects the whole
 *  authorize url over one bad scope. */
export function unknownScopes(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const id of ids) {
    if (lookupScope(id) !== undefined || seen.has(id)) continue;
    seen.add(id);
    unknown.push(id);
  }
  return unknown;
}

/** the restricted scope that still needs the acknowledgement, or null. a saved
 *  acknowledgement timestamp clears every restricted scope: without one the
 *  wizard refuses to include the scope (D4PLAN 7.2). */
export function requireAcknowledgement(
  ids: readonly string[],
  acknowledgedAt: string | null,
): string | null {
  if (typeof acknowledgedAt === "string" && acknowledgedAt !== "") return null;
  for (const id of ids) {
    if (lookupScope(id)?.restricted === true) return id;
  }
  return null;
}
