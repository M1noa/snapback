// the member phase (D4PLAN 12.2 step 11, 12.5). three modes, and the default is
// the safe one.
//
// a member who is not in the target guild is never added. adding one needs a
// guilds.join token they granted, which is the pull engine (15) and a separate
// consent flow, so an absent member is counted and named, and the report says
// so.
//
// the target's member list is read once, in one walk. it says who is in the
// guild and what roles they hold now, and both are needed for every member, so
// reading it per member would be a hundred thousand identical walks.
//
// mode 1 and mode 2 apply the backup's roles and leave the roles the backup
// does not know about alone. mode 3 syncs the member to the backup exactly and
// takes the rest away, which is why it is off by default and says so.

import { listBackupMembersByBackup } from "../../db/queries/backup-members.ts";
import { listBackupRolesByBackup } from "../../db/queries/backup-roles.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseFailed, phaseOk, type RestoreContext, type RestorePhase } from "./types.ts";

/** one page of the target guild's members. */
interface TargetMember {
  readonly user: { readonly id: string };
  readonly roles?: readonly string[];
}

/** discord's own page size for the member list, and the most it will return. */
const PAGE = 1000;
/** discord's limit on a guild nickname. */
const NICK_MAX = 32;
/** the longest timeout discord accepts, in milliseconds. */
const TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000;

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

/** the target's members, by user id. one walk, paginated on `after`. */
async function readTargetMembers(ctx: RestoreContext): Promise<Map<string, TargetMember>> {
  const members = new Map<string, TargetMember>();
  let after: string | null = null;

  for (;;) {
    const route =
      after === null
        ? `/guilds/${ctx.targetGuildId}/members?limit=${PAGE}`
        : `/guilds/${ctx.targetGuildId}/members?limit=${PAGE}&after=${after}`;
    const page: TargetMember[] = await ctx.client.request<TargetMember[]>({
      method: "GET",
      route,
    });
    for (const member of page) members.set(member.user.id, member);

    // a short page is the last one. the cursor is the last user id of the page.
    if (page.length < PAGE) return members;
    const last = page[page.length - 1];
    if (last === undefined) return members;
    after = last.user.id;
  }
}

/** the backup's roles by source id, for the name a member's role carries. */
async function readSourceRoleNames(ctx: RestoreContext): Promise<Map<string, string>> {
  const roles = await listBackupRolesByBackup(ctx.db, ctx.backupId);
  const names = new Map<string, string>();
  for (const role of roles) names.set(role.source_role_id, role.name);
  return names;
}

/**
 * the target guild's roles by name. fetched at most once, and only when the
 * role map cannot answer for a backup role on its own: a role is matched by
 * name (12.5), and a name is the only thing two guilds can share.
 */
async function readTargetRoleNames(ctx: RestoreContext): Promise<Map<string, string>> {
  const roles = await ctx.client.request<{ id: string; name: string }[]>({
    method: "GET",
    route: `/guilds/${ctx.targetGuildId}/roles`,
  });
  const names = new Map<string, string>();
  for (const role of roles) {
    // the first of a name wins: the target's roles arrive highest position
    // first, and a second role with the same name is a warning, not a choice.
    if (!names.has(role.name)) names.set(role.name, role.id);
  }
  return names;
}

/** what a stored timeout becomes, and what to say about it. */
function timeoutOf(
  stored: string | null,
  now: number,
): { until: string | null; note: string | null } {
  if (stored === null) return { until: null, note: null };

  const at = Date.parse(stored);
  if (!Number.isFinite(at)) {
    return { until: null, note: "the stored timeout is not a timestamp, so it was not sent" };
  }
  // a timeout in the past is not a clear. discord rejects it, and sending it to
  // clear the timeout is a behaviour difference worth choosing deliberately, so
  // it is dropped (12.5).
  if (at <= now) {
    return { until: null, note: "the stored timeout is in the past, so it was not sent" };
  }

  const limit = now + TIMEOUT_MAX_MS;
  if (at > limit) {
    return {
      until: new Date(limit).toISOString(),
      note: "clamped to 28 days, the most discord accepts",
    };
  }
  return { until: new Date(at).toISOString(), note: null };
}

export const restoreMembers: RestorePhase = async (ctx) => {
  const members = await listBackupMembersByBackup(ctx.db, ctx.backupId);
  if (members.length === 0) return phaseOk(0);

  const mode = ctx.options.memberMode;
  const setNick = mode >= 2;
  const sync = mode === 3;
  const notes: { what: string; why: string }[] = [];

  let targetMembers: Map<string, TargetMember>;
  try {
    targetMembers = await readTargetMembers(ctx);
  } catch (error) {
    // without the member list every member would look absent, so this is a
    // failed phase and not a note: the phases that need it are skipped.
    return phaseFailed(why(error));
  }

  const sourceNames = await readSourceRoleNames(ctx);
  const now = Date.parse(ctx.now());
  let targetNames: Map<string, string> | null = null;
  let count = 0;

  for (const member of members) {
    // user ids are global, so the target id is the same id. the map carries it
    // when a caller knows of a different one.
    const userId = ctx.maps.members.get(member.user_id) ?? member.user_id;
    const present = targetMembers.get(userId);
    if (present === undefined) {
      // not added. there is no path for that here (12.5).
      notes.push({ what: `the member ${userId}`, why: "not in the target guild" });
      continue;
    }
    ctx.maps.members.set(member.user_id, userId);

    // the backup's roles that the target guild has. a role the target does not
    // have is dropped, and the drop is counted.
    const wanted: string[] = [];
    for (const roleId of member.role_ids_json) {
      const name = sourceNames.get(roleId);
      let targetRoleId = ctx.maps.roles.get(roleId);
      if (targetRoleId === undefined) {
        if (targetNames === null) {
          try {
            targetNames = await readTargetRoleNames(ctx);
          } catch {
            // the target's roles could not be read, so a role that is not in the
            // map cannot be matched by name. it is dropped, not guessed.
            targetNames = new Map();
          }
        }
        targetRoleId = name === undefined ? undefined : targetNames.get(name);
      }
      if (targetRoleId === undefined) {
        notes.push({
          what:
            name === undefined
              ? `the role ${roleId} of member ${userId}`
              : `the role "${name}" of member ${userId}`,
          why:
            name === undefined
              ? "the role was not captured in this backup, so its name is unknown"
              : "the target guild has no role with that name",
        });
        continue;
      }
      if (!wanted.includes(targetRoleId)) wanted.push(targetRoleId);
    }

    const current = [...(present.roles ?? [])];
    let roles: string[];
    if (sync) {
      // sync is exact: the member ends with the backup's roles and nothing else.
      roles = wanted;
      const removed = current.filter((id) => !wanted.includes(id));
      if (removed.length > 0) {
        notes.push({
          what: `the member ${userId}`,
          why: `removed ${removed.length} role(s) the backup does not know about: ${removed.join(", ")}`,
        });
      }
    } else {
      // the roles the backup does not know about stay: mode 1 and 2 apply the
      // backup's roles and take nothing away.
      roles = [...wanted];
      for (const id of current) if (!roles.includes(id)) roles.push(id);
    }

    const body: Record<string, unknown> = { roles };

    if (setNick) {
      const nick = member.nickname;
      if (nick !== null && nick.length > NICK_MAX) {
        body.nick = nick.slice(0, NICK_MAX);
        notes.push({
          what: `the nickname of member ${userId}`,
          why: `truncated to ${NICK_MAX} characters, the most discord accepts`,
        });
      } else {
        body.nick = nick;
      }
    }

    const timeout = timeoutOf(member.timed_out_until, now);
    if (timeout.until !== null) body.communication_disabled_until = timeout.until;
    if (timeout.note !== null) {
      notes.push({ what: `the timeout of member ${userId}`, why: timeout.note });
    }

    try {
      await ctx.client.request({
        method: "PATCH",
        route: `/guilds/${ctx.targetGuildId}/members/${userId}`,
        body,
      });
      count += 1;
    } catch (error) {
      // discord's own code and message, verbatim (rule 5). a refused member is
      // a note and the rest of the phase carries on.
      notes.push({ what: `the member ${userId}`, why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
};
