// services/backup/members.ts. D4PLAN 11 step 13 (bans), step 14 (members) and
// 11.4. members are the step that eats memory: a 100k-member guild with avatars
// is a lot of objects, so rows are accumulated and flushed in batches of 1000
// and the guild is never held whole. bans page the same way and batch for the
// same reason, though a ban list is usually far smaller.
//
// a member's role ids are meaningless in a target guild, so the role names are
// resolved once from the roles already captured and stored beside the ids in
// source_role_names_json (11.4). a role id that was never captured is left out
// of the names list and recorded once as a skip, so an incomplete member row is
// visible rather than silent.

import { insertBackupBans } from "../../db/queries/backup-bans.ts";
import { insertBackupMembers } from "../../db/queries/backup-members.ts";
import { listBackupRolesByBackup } from "../../db/queries/backup-roles.ts";
import type { BackupBanRow, BackupMemberRow } from "../../db/types.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import { type BackupContext, type Capture, included } from "./types.ts";

// both endpoints cap limit at 1-1000; 1000 is one page.
const PAGE = 1000;

// the subset of a discord user we read. the rest stays on the wire.
interface RawUser {
  readonly id: string;
  readonly username: string;
  readonly global_name?: string | null;
  readonly discriminator?: string | null;
  readonly avatar?: string | null;
  readonly bot?: boolean;
}

interface RawMember {
  readonly user: RawUser;
  readonly nick?: string | null;
  readonly joined_at?: string | null;
  readonly roles: readonly string[];
  readonly pending?: boolean;
  readonly communication_disabled_until?: string | null;
  readonly premium_since?: string | null;
  readonly flags?: number;
}

interface RawBan {
  readonly user: RawUser;
  readonly reason?: string | null;
}

// a custom avatar lives at cdn.discordapp.com/avatars/<id>/<hash>.<ext>, and an
// animated hash starts "a_". a user with no avatar stores null: the old
// discriminator % 5 default-avatar guess is wrong under the username system, and
// the restore recomputes the default instead (11.4, 12.5).
function avatarUrl(user: RawUser): string | null {
  const hash = user.avatar;
  if (hash === undefined || hash === null || hash === "") return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${hash}.${ext}`;
}

// read the captured roles once into a map, not once per member: a big guild
// would otherwise do 100k lookups for a handful of role rows.
async function readRoleNames(ctx: BackupContext): Promise<Map<string, string>> {
  const roles = await listBackupRolesByBackup(ctx.db, ctx.backupId);
  const names = new Map<string, string>();
  for (const role of roles) names.set(role.source_role_id, role.name);
  return names;
}

function toMemberRow(
  ctx: BackupContext,
  member: RawMember,
  roleNames: Map<string, string>,
  missingRoles: Set<string>,
): BackupMemberRow {
  const names: string[] = [];
  for (const roleId of member.roles) {
    const name = roleNames.get(roleId);
    if (name === undefined) {
      // recorded once per distinct id, not once per member carrying it.
      missingRoles.add(roleId);
      continue;
    }
    names.push(name);
  }

  return {
    backup_id: ctx.backupId,
    user_id: member.user.id,
    username: member.user.username,
    global_name: member.user.global_name ?? null,
    discriminator: member.user.discriminator ?? null,
    nickname: member.nick ?? null,
    avatar_url: avatarUrl(member.user),
    joined_at: member.joined_at ?? null,
    is_bot: member.user.bot === true,
    role_ids_json: [...member.roles],
    pending: member.pending === true,
    timed_out_until: member.communication_disabled_until ?? null,
    premium_since: member.premium_since ?? null,
    flags: member.flags ?? null,
    source_role_names_json: names,
  };
}

function memberRoute(guildId: string, after: string | null): string {
  const base = `/guilds/${guildId}/members?limit=${PAGE}`;
  return after === null ? base : `${base}&after=${after}`;
}

function banRoute(guildId: string, after: string | null): string {
  const base = `/guilds/${guildId}/bans?limit=${PAGE}`;
  return after === null ? base : `${base}&after=${after}`;
}

// both lists page identically: `limit` + `after`, stopping on a short page. a 403
// means the bot lacks GUILD_MEMBERS or BAN_MEMBERS, so it is one skip carrying
// discord's own message and the step still resolves; anything else propagates.
async function* fetchPages<T>(
  ctx: BackupContext,
  category: string,
  what: string,
  route: (after: string | null) => string,
  cursor: (item: T) => string,
): AsyncGenerator<readonly T[], void, void> {
  let after: string | null = null;
  for (;;) {
    let page: T[];
    try {
      page = await ctx.client.request<T[]>({ method: "GET", route: route(after) });
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 403) {
        ctx.skips.add({ category, what, why: error.message });
        return;
      }
      throw error;
    }

    yield page;

    if (page.length < PAGE) return;
    const last = page[page.length - 1];
    if (last === undefined) return;
    after = cursor(last);
  }
}

export const captureMembers: Capture = async (ctx) => {
  if (!included(ctx, "members")) return { written: 0 };

  const roleNames = await readRoleNames(ctx);

  let written = 0;
  let done = 0;
  let batch: BackupMemberRow[] = [];
  const missingRoles = new Set<string>();

  // flush at every 1000 and once for the remainder, so a big guild is never held
  // whole (11.4). written counts only rows that actually reached the db.
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertBackupMembers(ctx.db, batch);
    written += batch.length;
    batch = [];
  };

  for await (const page of fetchPages<RawMember>(
    ctx,
    "members",
    "the member list",
    (after) => memberRoute(ctx.guildId, after),
    (member) => member.user.id,
  )) {
    for (const member of page) {
      batch.push(toMemberRow(ctx, member, roleNames, missingRoles));
      done += 1;
      if (batch.length >= PAGE) await flush();
    }
    // total is unknown while paginating, so it stays null (types.ts)
    await ctx.checkpoint("members", { done, total: null });
  }
  await flush();

  for (const id of missingRoles) {
    ctx.skips.add({
      category: "members",
      what: `role ${id}`,
      why: "the role was not captured in this backup, so its name cannot be resolved",
    });
  }

  return { written };
};

export const captureBans: Capture = async (ctx) => {
  if (!included(ctx, "bans")) return { written: 0 };

  let written = 0;
  let done = 0;
  let batch: BackupBanRow[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await insertBackupBans(ctx.db, batch);
    written += batch.length;
    batch = [];
  };

  for await (const page of fetchPages<RawBan>(
    ctx,
    "bans",
    "the ban list",
    (after) => banRoute(ctx.guildId, after),
    (ban) => ban.user.id,
  )) {
    for (const ban of page) {
      batch.push({
        backup_id: ctx.backupId,
        user_id: ban.user.id,
        username: ban.user.username,
        global_name: ban.user.global_name ?? null,
        reason: ban.reason ?? null,
      });
      done += 1;
      if (batch.length >= PAGE) await flush();
    }
    await ctx.checkpoint("bans", { done, total: null });
  }
  await flush();

  return { written };
};
