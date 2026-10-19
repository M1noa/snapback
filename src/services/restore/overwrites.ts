// the channel overwrite phase (D4PLAN 12.2 step 6, 12.4). overwrites are
// remapped by target name, with the source id as the tiebreak, and written onto
// the target's channels.
//
// allow and deny are 64-bit bitfields: they cross the wire as the strings the
// backup stored, never as numbers (D4PLAN 5.1, AGENTS.md rule 3).
//
// the channels phase runs before this one, so the channel a row points at is
// already in the map. one that is not is a note, not a crash.

import { listBackupChannelOverwritesByBackup } from "../../db/queries/backup-overwrites.ts";
import { listBackupRolesByBackup } from "../../db/queries/backup-roles.ts";
import type { BackupChannelOverwriteRow } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestoreNote, type RestorePhase } from "./types.ts";

/** a role in the target guild, as discord sends it. */
interface TargetRole {
  id: string;
  name: string;
}

/** discord's member page size for the target's member list. */
const MEMBER_PAGE = 1000;
/** how many member pages one phase reads before it gives up on the list. */
const MEMBER_PAGES = 100;

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

export const restoreOverwrites: RestorePhase = async (ctx) => {
  if (!ctx.options.overwrites) return phaseOk(0);

  const rows = await listBackupChannelOverwritesByBackup(ctx.db, ctx.backupId);
  if (rows.length === 0) return phaseOk(0);

  const notes: RestoreNote[] = [];
  const note = (what: string, reason: string): void => {
    notes.push({ what, why: reason });
    ctx.note(what, reason);
  };
  let count = 0;

  const backupRoles = await listBackupRolesByBackup(ctx.db, ctx.backupId);

  // the target's roles, read only when an overwrite needs them.
  let targetRoles: TargetRole[] | undefined;
  const targetRoleList = async (): Promise<TargetRole[]> => {
    if (targetRoles !== undefined) return targetRoles;
    try {
      targetRoles = await ctx.client.request<TargetRole[]>({
        method: "GET",
        route: `/guilds/${ctx.targetGuildId}/roles`,
      });
    } catch (error) {
      note("the target's roles", why(error));
      targetRoles = [];
    }
    return targetRoles;
  };

  // the target's member list, read only when a member overwrite needs it.
  let memberIds: Set<string> | undefined;
  const targetMemberIds = async (): Promise<Set<string>> => {
    if (memberIds !== undefined) return memberIds;
    const ids = new Set<string>();
    try {
      let after: string | undefined;
      for (let page = 0; page < MEMBER_PAGES; page += 1) {
        const query =
          after === undefined ? `?limit=${MEMBER_PAGE}` : `?limit=${MEMBER_PAGE}&after=${after}`;
        const members = await ctx.client.request<{ user?: { id?: string } }[]>({
          method: "GET",
          route: `/guilds/${ctx.targetGuildId}/members${query}`,
        });
        for (const member of members) {
          if (typeof member.user?.id === "string") ids.add(member.user.id);
        }
        if (members.length < MEMBER_PAGE) break;
        const last = members[members.length - 1]?.user?.id;
        if (last === undefined) break;
        after = last;
      }
    } catch (error) {
      note("the target's members", why(error));
    }
    memberIds = ids;
    return ids;
  };

  // the resolution order of 12.4: a role this backup put in the target, then an
  // existing target role with the same name, then @everyone.
  const resolveRole = async (row: BackupChannelOverwriteRow): Promise<string | undefined> => {
    const name = row.target_name ?? "";
    const candidates = backupRoles.filter((role) => role.name === name);
    // the source id is the tiebreak between two roles that share a name.
    const exact = candidates.find((role) => role.source_role_id === row.source_target_id);
    const ordered =
      exact === undefined ? candidates : [exact, ...candidates.filter((role) => role !== exact)];
    for (const candidate of ordered) {
      const mapped = ctx.maps.roles.get(candidate.source_role_id);
      if (mapped !== undefined) return mapped;
    }
    const existing = (await targetRoleList()).find((role) => role.name === name);
    if (existing !== undefined) return existing.id;
    if (name === "@everyone") return ctx.targetGuildId;
    return undefined;
  };

  for (const row of rows) {
    const channelId = ctx.maps.channels.get(row.source_channel_id);
    if (channelId === undefined) {
      note(`the overwrite on channel ${row.source_channel_id}`, "the channel is not in the target");
      continue;
    }

    // the name the backup stored, or the id when the target was never captured.
    const label =
      row.target_name !== null && row.target_name !== "" ? row.target_name : row.source_target_id;

    let targetId: string | undefined;
    let unresolved: string;
    if (row.target_type === "member") {
      const members = await targetMemberIds();
      // ids are global, so the user id is the target id. the member list says
      // whether the user is in the target at all.
      targetId = members.has(row.source_target_id) ? row.source_target_id : undefined;
      unresolved = "the user is not in the target guild";
    } else {
      targetId = await resolveRole(row);
      unresolved = "no role in the target matched that name";
    }

    if (targetId === undefined) {
      note(`the ${row.target_type} overwrite for "${label}"`, unresolved);
      continue;
    }

    try {
      await ctx.client.request({
        method: "PUT",
        route: `/guilds/${ctx.targetGuildId}/channels/${channelId}/permissions/${targetId}`,
        body: {
          type: row.target_type === "member" ? 1 : 0,
          allow: row.allow,
          deny: row.deny,
        },
      });
      count += 1;
    } catch (error) {
      note(`the ${row.target_type} overwrite for "${label}"`, why(error));
    }
  }

  return phaseOk(count, notes);
};
