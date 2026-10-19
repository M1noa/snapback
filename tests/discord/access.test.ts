// tests/discord/access.test.ts
//
// the grants are not the same grant, and this is where that is proved: an admin
// who may run a backup may not read the records, and one who may read the
// records may not wipe the server.

import { describe, expect, test } from "bun:test";
import type { GuildAdminRow } from "../../src/db/types.ts";
import { canSurface, capabilityFor } from "../../src/discord/access.ts";

function row(overrides: Partial<GuildAdminRow> = {}): GuildAdminRow {
  return {
    guild_id: "123",
    user_id: "456",
    added_by: null,
    added_at: null,
    can_backup: false,
    can_restore: false,
    can_manage_admins: false,
    can_view_records: false,
    can_delete_records: false,
    ...overrides,
  };
}

describe("canSurface", () => {
  test("reading the records needs can_view_records", () => {
    expect(canSurface(row({ can_view_records: true }), "verify")).toBe(true);
    expect(canSurface(row({ can_view_records: false }), "verify")).toBe(false);
    expect(canSurface(row({ can_view_records: true }), "users")).toBe(true);
  });

  test("a backup needs can_backup, and the records grant does not give it", () => {
    expect(canSurface(row({ can_backup: true }), "backup")).toBe(true);
    expect(canSurface(row({ can_view_records: true }), "backup")).toBe(false);
  });

  test("a restore needs can_restore", () => {
    expect(canSurface(row({ can_restore: true }), "restore")).toBe(true);
    expect(canSurface(row({ can_backup: true }), "restore")).toBe(false);
  });

  test("adding people is a restore-shaped grant", () => {
    expect(canSurface(row({ can_restore: true }), "pull")).toBe(true);
    expect(canSurface(row({ can_view_records: true }), "pull")).toBe(false);
  });

  test("the setup surface has its own ownership checks", () => {
    expect(canSurface(row(), "setup")).toBe(true);
  });

  test("the refusal names the capability that was missing", () => {
    expect(capabilityFor("verify")).toBe("can_view_records");
    expect(capabilityFor("backup")).toBe("can_backup");
    expect(capabilityFor("restore")).toBe("can_restore");
  });
});
