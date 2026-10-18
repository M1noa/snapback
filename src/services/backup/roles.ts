// services/backup/roles.ts. D4PLAN 11 step 3 and 11.2: the role list, ready to be
// re-created in another guild.
//
// permissions cross the wire as a decimal string and stay one: a bitfield above
// 2^53 loses digits the moment it becomes a number (AGENTS.md rule 3).

import { insertBackupRoles } from "../../db/queries/backup-roles.ts";
import type { BackupRoleRow, JsonObject } from "../../db/types.ts";
import type { BackupContext, Capture } from "./types.ts";
import { included, skipFor } from "./types.ts";

interface RawRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  permissions: string;
  managed?: boolean;
  icon?: string | null;
  unicode_emoji?: string | null;
  tags?: JsonObject;
}

function toRoleRow(ctx: BackupContext, role: RawRole): BackupRoleRow {
  const tags = role.tags ?? {};
  return {
    backup_id: ctx.backupId,
    source_role_id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    // discord sends a string; keep it. Number() here is the bug 11.2 warns about.
    permissions: String(role.permissions),
    // the id is the invariant of the everyone role, not the name: any role can be
    // renamed to "@everyone" and only one of them is the real one (11.2).
    is_everyone: role.id === ctx.guildId,
    is_bot_managed: role.managed === true,
    bot_id: typeof tags.bot_id === "string" ? tags.bot_id : null,
    integration_id: typeof tags.integration_id === "string" ? tags.integration_id : null,
    icon_url: roleIconUrl(role),
    unicode_emoji: role.unicode_emoji ?? null,
    tags_json: role.tags ?? null,
  };
}

// a role icon lives at cdn.discordapp.com/role-icons/<role>/<hash>.png. a guild
// without the ROLE_ICONS feature returns no icon at all, so null is normal and is
// not a skip (11.2).
function roleIconUrl(role: RawRole): string | null {
  if (typeof role.icon !== "string" || role.icon === "") return null;
  return `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png`;
}

export const captureRoles: Capture = async (ctx) => {
  if (!included(ctx, "roles")) {
    ctx.skips.add({
      category: "roles",
      what: "all roles",
      why: "roles are turned off in /setup backup",
    });
    return { written: 0 };
  }

  let raw: RawRole[];
  try {
    raw = await ctx.client.request<RawRole[]>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/roles`,
    });
  } catch (error) {
    // a bot without MANAGE_ROLES gets a 403 here. that is one skip, not a backup
    // that fails: everything else in the guild is still worth capturing.
    ctx.skips.add(skipFor("roles", "all roles", error));
    return { written: 0 };
  }

  const rows = (Array.isArray(raw) ? raw : []).map((role) => toRoleRow(ctx, role));
  // one insert for the batch, never one per role.
  await insertBackupRoles(ctx.db, rows);

  // store the rows first, then the bytes: a download that fails leaves a row with
  // a url and no file, which a restore reports, rather than a missing row.
  for (const row of rows) {
    if (row.icon_url !== null) await ctx.assets.save("role", row.source_role_id, row.icon_url);
  }

  await ctx.checkpoint("roles", { done: 1, total: 1 });
  return { written: rows.length };
};
