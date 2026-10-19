// what an admin row allows, per surface (D4PLAN 19.1).
//
// the guild_admins row carries a grant per capability, and the point of the
// grants is that they are not the same grant: reading the records is a
// different trust level from wiping the server and restoring it.

import type { GuildAdminRow } from "../db/types.ts";

/** the surface's own name decides the capability it asks for. */
export function canSurface(row: GuildAdminRow, surface: string): boolean {
  switch (surface) {
    case "verify":
    case "users":
      return row.can_view_records;
    case "backup":
      return row.can_backup;
    case "restore":
      return row.can_restore;
    case "pull":
      // adding people to a server is a restore-shaped grant.
      return row.can_restore;
    default:
      // the setup surface has its own ownership checks, and the instance owner
      // is the operator of the whole bot.
      return true;
  }
}

/** the capability a surface needs, named for the refusal message. */
export function capabilityFor(surface: string): string {
  switch (surface) {
    case "verify":
    case "users":
      return "can_view_records";
    case "backup":
      return "can_backup";
    case "restore":
    case "pull":
      return "can_restore";
    default:
      return "the setup surface";
  }
}
