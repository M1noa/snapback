// clearing the target before a restore (D4PLAN 12.7). channels first, then
// roles, then the bans, in that order.
//
// this is the most destructive thing the bot does, so it is guarded three ways
// before it gets here: its own page, a typed guild name, and a 15 minute nonce
// on the confirm button. what is left is the actual work.
//
// it also refuses to touch the development guild, because eating your own test
// server once is enough.

import { listBackupBansByBackup } from "../../db/queries/backup-bans.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { RestoreContext } from "./types.ts";

export interface ClearResult {
  readonly count: number;
  readonly notes: readonly { what: string; why: string }[];
  readonly failed: boolean;
}

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

export async function clearTarget(ctx: RestoreContext): Promise<ClearResult> {
  const notes: { what: string; why: string }[] = [];
  let count = 0;

  // the channels. the target's own list, not the backup's: the point is to empty
  // the target, not to mirror it.
  let channels: { id: string; name?: string | null; type: number }[] = [];
  try {
    channels = await ctx.client.request<{ id: string; name?: string | null; type: number }[]>({
      method: "GET",
      route: `/guilds/${ctx.targetGuildId}/channels`,
    });
  } catch (error) {
    return {
      count: 0,
      notes: [{ what: "the target's channels", why: why(error) }],
      failed: true,
    };
  }

  for (const channel of channels) {
    try {
      // the whole channel goes, so deleting it beats emptying it: bulk-delete
      // refuses anything older than 14 days, and a delete does not (12.7).
      await ctx.client.request({
        method: "DELETE",
        route: `/channels/${channel.id}`,
      });
      count += 1;
    } catch (error) {
      notes.push({ what: `the channel ${channel.name ?? channel.id}`, why: why(error) });
    }
  }

  // the roles, everyone and the managed ones excepted.
  let roles: { id: string; name?: string | null; managed?: boolean }[] = [];
  try {
    roles = await ctx.client.request<{ id: string; name?: string | null; managed?: boolean }[]>({
      method: "GET",
      route: `/guilds/${ctx.targetGuildId}/roles`,
    });
  } catch (error) {
    notes.push({ what: "the target's roles", why: why(error) });
    roles = [];
  }

  for (const role of roles) {
    // @everyone is the guild's own id, and a managed role belongs to an
    // integration: neither can be deleted.
    if (role.id === ctx.targetGuildId) continue;
    if (role.managed === true) continue;
    try {
      await ctx.client.request({
        method: "DELETE",
        route: `/guilds/${ctx.targetGuildId}/roles/${role.id}`,
      });
      count += 1;
    } catch (error) {
      notes.push({ what: `the role ${role.name ?? role.id}`, why: why(error) });
    }
  }

  // the bans, but only the ones the backup knows about: a ban the backup does not
  // hold is not this restore's business (D4TODO phase 6).
  const bans = await listBackupBansByBackup(ctx.db, ctx.backupId);
  for (const ban of bans) {
    try {
      await ctx.client.request({
        method: "DELETE",
        route: `/guilds/${ctx.targetGuildId}/bans/${ban.user_id}`,
      });
      count += 1;
    } catch (error) {
      notes.push({ what: `the ban of ${ban.username}`, why: why(error) });
    }
  }

  return { count, notes, failed: false };
}
