// the roles phase (D4PLAN 12.2 step 3, 12.3). roles are edited or created, the
// hierarchy is set in one call, and the source ids are mapped to the target's.
//
// permissions cross the wire as a decimal string and stay one: a bitfield above
// 2^53 loses digits the moment it becomes a number (AGENTS.md rule 3).
//
// @everyone is edited, never created: its id is the guild's own id, and the
// backup knows it by that id rather than by its name (11.2).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listBackupRolesByBackup } from "../../db/queries/backup-roles.ts";
import type { BackupRoleRow } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestoreContext, type RestoreNote, type RestorePhase } from "./types.ts";

/** a role in the target guild, as discord sends it. */
interface TargetRole {
  id: string;
  name: string;
  managed?: boolean;
  tags?: { bot_id?: string; integration_id?: string } | null;
}

/** a role this phase put in the target, and the position it wants. */
interface PlacedRole {
  readonly id: string;
  readonly position: number;
}

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

// discord's role ceiling. the count the guild is allowed is in the message, and
// the message is what the report carries (12.8).
function isRoleCap(error: unknown): boolean {
  if (!(error instanceof DiscordApiError)) return false;
  if (error.code === 30003) return true;
  return /maximum number of roles/i.test(error.message);
}

// a 429 that reached the phase means the limiter gave up. the plan says a
// sustained global 429 stops the job, so the phase stops here and reports.
function isRateLimited(error: unknown): boolean {
  return error instanceof DiscordApiError && error.status === 429;
}

// a managed role in the target belongs to an application: it is the same one
// when the bot id or the integration id matches the backup's row.
function sameApplication(row: BackupRoleRow, role: TargetRole): boolean {
  if (row.bot_id !== null && role.tags?.bot_id === row.bot_id) return true;
  if (row.integration_id !== null && role.tags?.integration_id === row.integration_id) return true;
  return false;
}

// the role icon bytes as a data uri. the backup engine stores them at
// assets/role/<role_id>.<ext> under the backup's own directory; the extension
// decides the mime type.
async function roleIconDataUri(ctx: RestoreContext, sourceRoleId: string): Promise<string | null> {
  for (const root of [join(ctx.backupDir, ctx.backupId), ctx.backupDir]) {
    const directory = join(root, "assets", "role");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      // this root holds no role assets. the other root may.
      continue;
    }
    const file = files.find((entry) => entry.startsWith(sourceRoleId));
    if (file === undefined) continue;
    const bytes = await readFile(join(directory, file));
    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const type = ext === "gif" ? "image/gif" : ext === "png" ? "image/png" : "image/jpeg";
    return `data:${type};base64,${bytes.toString("base64")}`;
  }
  return null;
}

export const restoreRoles: RestorePhase = async (ctx) => {
  if (!ctx.options.roles) return phaseOk(0);

  const rows = await listBackupRolesByBackup(ctx.db, ctx.backupId);
  if (rows.length === 0) return phaseOk(0);

  const notes: RestoreNote[] = [];
  const note = (what: string, reason: string): void => {
    notes.push({ what, why: reason });
    ctx.note(what, reason);
  };
  // the roles this phase created, edited or linked. deletions are not counted:
  // the count says what the target now holds.
  let count = 0;

  // the target's own roles: the @everyone id, the names a role can match, the
  // managed ones, and the extras deleteExtraRoles would remove.
  let targetRoles: TargetRole[];
  try {
    targetRoles = await ctx.client.request<TargetRole[]>({
      method: "GET",
      route: `/guilds/${ctx.targetGuildId}/roles`,
    });
  } catch (error) {
    // a bot without MANAGE_ROLES gets a 403 here. the phase cannot do anything,
    // and the report says why.
    note("the target's roles", why(error));
    return phaseOk(0, notes);
  }

  // the ROLE_ICONS feature decides whether an icon can go in the body at all
  // (12.3). read once, and only when a role actually carries one.
  let roleIcons: boolean | undefined;
  const roleIconsAllowed = async (): Promise<boolean> => {
    if (roleIcons !== undefined) return roleIcons;
    try {
      const guild = await ctx.client.request<{ features?: string[] }>({
        method: "GET",
        route: `/guilds/${ctx.targetGuildId}`,
      });
      roleIcons = (guild.features ?? []).includes("ROLE_ICONS");
    } catch (error) {
      // the feature list is unreadable: drop the icon rather than send a body
      // the target would reject.
      roleIcons = false;
      note("the target guild's features", why(error));
    }
    return roleIcons;
  };

  // the extras go first: deleting them frees room under the role cap, which is
  // the whole point of the option.
  if (ctx.options.deleteExtraRoles) {
    const known = new Set(rows.map((row) => row.name));
    for (const role of targetRoles) {
      // @everyone is the guild's own id, and a managed role belongs to an
      // integration: neither can be deleted.
      if (role.id === ctx.targetGuildId) continue;
      if (role.managed === true) continue;
      if (known.has(role.name)) continue;
      try {
        await ctx.client.request({
          method: "DELETE",
          route: `/guilds/${ctx.targetGuildId}/roles/${role.id}`,
        });
      } catch (error) {
        note(`the extra role "${role.name}"`, why(error));
      }
    }
  }

  // @everyone is edited, never created (12.3).
  const everyone = rows.find((row) => row.is_everyone || row.source_role_id === ctx.sourceGuildId);
  const others = rows.filter((row) => row !== everyone);
  if (everyone !== undefined) {
    const targetEveryone = targetRoles.find((role) => role.id === ctx.targetGuildId);
    if (targetEveryone === undefined) {
      note("the @everyone role", "the target guild has no @everyone role");
    } else {
      try {
        await ctx.client.request({
          method: "PATCH",
          route: `/guilds/${ctx.targetGuildId}/roles/${targetEveryone.id}`,
          body: {
            color: everyone.color,
            hoist: everyone.hoist,
            mentionable: everyone.mentionable,
            permissions: everyone.permissions,
          },
        });
        ctx.maps.roles.set(everyone.source_role_id, targetEveryone.id);
        count += 1;
      } catch (error) {
        note("the @everyone role", why(error));
      }
    }
  }

  // descending by position, so the hierarchy comes out right without a second
  // pass over the roles (12.3).
  const ordered = [...others].sort((a, b) => b.position - a.position);
  const placed: PlacedRole[] = [];
  let stopped = false;

  for (const row of ordered) {
    // a managed role belongs to an integration: it cannot be created, only
    // linked to the integration role the same application already has here.
    if (row.is_bot_managed || row.bot_id !== null) {
      const match = targetRoles.find(
        (role) => role.managed === true && role.name === row.name && sameApplication(row, role),
      );
      if (match === undefined) {
        note(
          `the role "${row.name}"`,
          "not restorable: integration role from an application not in this guild",
        );
        continue;
      }
      ctx.maps.roles.set(row.source_role_id, match.id);
      count += 1;
      continue;
    }

    // the create/patch body: name, colour, hoist, mentionable and the
    // permissions string, with the icon in the same body (12.3).
    const body: Record<string, unknown> = {
      name: row.name,
      color: row.color,
      hoist: row.hoist,
      mentionable: row.mentionable,
      permissions: row.permissions,
    };
    if (row.icon_url !== null) {
      const uri = await roleIconDataUri(ctx, row.source_role_id);
      if (uri === null) {
        note(`the role "${row.name}" icon`, "the file is not in the backup's asset directory");
      } else if (!(await roleIconsAllowed())) {
        note(
          `the role "${row.name}" icon`,
          "the target guild does not have the ROLE_ICONS feature",
        );
      } else {
        body.icon = uri;
      }
    } else if (row.unicode_emoji !== null) {
      body.unicode_emoji = row.unicode_emoji;
    }

    // reuse and edit a target role with the same name, or create a second one
    // (12.3).
    const existing = ctx.options.reuseRoles
      ? targetRoles.find(
          (role) =>
            role.name === row.name && role.managed !== true && role.id !== ctx.targetGuildId,
        )
      : undefined;

    try {
      if (existing !== undefined) {
        await ctx.client.request({
          method: "PATCH",
          route: `/guilds/${ctx.targetGuildId}/roles/${existing.id}`,
          body,
        });
        ctx.maps.roles.set(row.source_role_id, existing.id);
        placed.push({ id: existing.id, position: row.position });
      } else {
        const created = await ctx.client.request<{ id: string }>({
          method: "POST",
          route: `/guilds/${ctx.targetGuildId}/roles`,
          body,
        });
        ctx.maps.roles.set(row.source_role_id, created.id);
        placed.push({ id: created.id, position: row.position });
      }
      count += 1;
    } catch (error) {
      if (isRoleCap(error) || isRateLimited(error)) {
        // the roles are incomplete now, so the phases that need them are
        // skipped (12.8). what was done stands.
        note("the remaining roles", why(error));
        stopped = true;
        break;
      }
      note(`the role "${row.name}"`, why(error));
    }
  }

  // the order, in one call for the whole set rather than one call per role
  // (12.3: the reference never reorders, and that is the bug to avoid).
  if (placed.length > 0) {
    const order = [...placed].sort((a, b) => a.position - b.position);
    try {
      await ctx.client.request({
        method: "PATCH",
        route: `/guilds/${ctx.targetGuildId}/roles`,
        body: order.map((entry) => ({ id: entry.id, position: entry.position })),
      });
    } catch (error) {
      note("the role order", why(error));
    }
  }

  if (stopped) return { outcome: "fail", count, notes, failed: true };
  return phaseOk(count, notes);
};
