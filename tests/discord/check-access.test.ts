// the access gate. four lanes, and the ordering matters for the tests: a db
// row cannot outrank an unknown discord permission, and unknown never allows.
// the per-flag grants themselves are tests/discord/access.test.ts (access.ts).

import { describe, expect, test } from "bun:test";
import { checkAccess, hasTrustedPermissions } from "../../src/discord/registry.ts";

const OWNER = "100000000000000001";
const GUILD = "200000000000000002";
const GUILD_OWNER = "300000000000000003";

function base(
  overrides: {
    userId?: string;
    guildOwnerId?: string | undefined;
    memberPermissions?: string | undefined;
    isGuildAdmin?: boolean;
  } = {},
) {
  return {
    userId: overrides.userId ?? "900000000000000009",
    guildId: GUILD,
    ownerId: OWNER,
    guildOwnerId: overrides.guildOwnerId,
    memberPermissions: overrides.memberPermissions,
    isGuildAdmin: async () => overrides.isGuildAdmin ?? false,
  };
}

describe("checkAccess", () => {
  test("the instance owner passes before anything is read", async () => {
    const result = await checkAccess(base({ userId: OWNER, isGuildAdmin: false }));
    expect(result.kind).toBe("allow");
  });

  test("the server's own owner passes with no db grant and no perms lane", async () => {
    const result = await checkAccess(
      base({ userId: GUILD_OWNER, guildOwnerId: GUILD_OWNER, isGuildAdmin: false }),
    );
    expect(result.kind).toBe("allow");
  });

  test("an unknown owner id never allows on accident of equality", async () => {
    const result = await checkAccess(
      base({ userId: GUILD_OWNER, guildOwnerId: undefined, isGuildAdmin: false }),
    );
    expect(result.kind).toBe("deny");
  });

  test("a discord administrator passes with no db grant", async () => {
    const result = await checkAccess(base({ memberPermissions: "8", isGuildAdmin: false }));
    expect(result.kind).toBe("allow");
  });

  test("manage-server passes with no db grant", async () => {
    const result = await checkAccess(base({ memberPermissions: "32", isGuildAdmin: false }));
    expect(result.kind).toBe("allow");
  });

  test("a member without either trusted bit falls to the db lane", async () => {
    // send messages alone is not trust.
    const denied = await checkAccess(base({ memberPermissions: "2048", isGuildAdmin: false }));
    expect(denied.kind).toBe("deny");
    const granted = await checkAccess(base({ memberPermissions: "2048", isGuildAdmin: true }));
    expect(granted.kind).toBe("allow");
  });

  test("a payload without the lanes at all is denied, not crashed", async () => {
    const result = await checkAccess(base({ isGuildAdmin: false }));
    expect(result.kind).toBe("deny");
  });

  test("the denial points at the two fixes that exist", async () => {
    const result = await checkAccess(base({ isGuildAdmin: false }));
    if (result.kind !== "deny") throw new Error("expected deny");
    expect(result.denial.body).toContain("not a Snapback admin");
    expect(result.denial.needs).toContain("/setup admins");
  });
});

describe("hasTrustedPermissions", () => {
  test("either bit of the pair counts", () => {
    expect(hasTrustedPermissions("8")).toBe(true);
    expect(hasTrustedPermissions("32")).toBe(true);
    expect(hasTrustedPermissions("40")).toBe(true);
  });

  test("a full owner bitset counts", () => {
    // the owner reads as every permission, high bits included.
    expect(hasTrustedPermissions("9007199254740991")).toBe(true);
  });

  test("unknown and unusable input never allows", () => {
    expect(hasTrustedPermissions(undefined)).toBe(false);
    expect(hasTrustedPermissions("")).toBe(false);
    expect(hasTrustedPermissions("not-a-number")).toBe(false);
  });

  test("a member with only message perms is not trusted", () => {
    expect(hasTrustedPermissions("2048")).toBe(false);
  });
});
