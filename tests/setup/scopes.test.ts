import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCOPE_IDS,
  lookupScope,
  RESTRICTED_SCOPE_IDS,
  requireAcknowledgement,
  SCOPE_CATALOGUE,
  unknownScopes,
} from "../../src/setup/scopes.ts";

const TEN_SCOPES = [
  "identify",
  "email",
  "connections",
  "guilds",
  "guilds.join",
  "guilds.members.read",
  "role_connections.write",
  "webhook.incoming",
  "relationships.read",
  "gdm.join",
];

const SAVED = "2026-10-16T12:00:00.000Z";

describe("the scope catalogue", () => {
  test("carries all ten scopes from D4PLAN 7.2, in the order the plan lists them", () => {
    expect(SCOPE_CATALOGUE.map((entry) => entry.id)).toEqual(TEN_SCOPES);
  });

  test("every scope carries a non-empty consequence", () => {
    for (const entry of SCOPE_CATALOGUE) {
      expect(entry.consequence.trim().length).toBeGreaterThan(0);
    }
  });

  test("exactly one restricted scope, and it is relationships.read", () => {
    expect(RESTRICTED_SCOPE_IDS).toEqual(["relationships.read"]);
    expect(SCOPE_CATALOGUE.filter((entry) => entry.restricted).length).toBe(1);
    expect(lookupScope("relationships.read")?.restricted).toBe(true);
  });

  test("the restricted consequence is the long warning from the plan", () => {
    const entry = lookupScope("relationships.read");
    expect(entry?.consequence).toContain("friends list");
    expect(entry?.consequence).toContain("Social SDK terms");
  });

  test("the defaults are identify, email, guilds.join", () => {
    expect([...DEFAULT_SCOPE_IDS]).toEqual(["identify", "email", "guilds.join"]);
    for (const id of DEFAULT_SCOPE_IDS) expect(lookupScope(id)).toBeDefined();
  });
});

describe("lookupScope and unknownScopes", () => {
  test("lookup is exact, not a prefix match", () => {
    expect(lookupScope("guilds")?.id).toBe("guilds");
    expect(lookupScope("guilds.join")?.id).toBe("guilds.join");
    expect(lookupScope("guild")).toBeUndefined();
    expect(lookupScope("")).toBeUndefined();
  });

  test("unknownScopes returns the ids the catalogue cannot honour, deduped", () => {
    expect(unknownScopes(["identify", "nope", "guilds", "nope"])).toEqual(["nope"]);
    expect(unknownScopes(["identify"])).toEqual([]);
    expect(unknownScopes([])).toEqual([]);
  });
});

describe("requireAcknowledgement", () => {
  test("returns the restricted scope when it is chosen unacknowledged", () => {
    expect(requireAcknowledgement(["identify", "relationships.read"], null)).toBe(
      "relationships.read",
    );
  });

  test("returns null once an acknowledgement is saved", () => {
    expect(requireAcknowledgement(["relationships.read"], SAVED)).toBeNull();
  });

  test("an empty acknowledgement string is not an acknowledgement", () => {
    expect(requireAcknowledgement(["relationships.read"], "")).toBe("relationships.read");
  });

  test("returns null when no restricted scope is chosen", () => {
    expect(requireAcknowledgement(["identify", "email"], null)).toBeNull();
    expect(requireAcknowledgement([], null)).toBeNull();
  });
});
