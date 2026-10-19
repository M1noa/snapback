// the ban phase (D4PLAN 12.2 step 12). a ban is a small, blunt thing: one put
// per user, and the reason the moderator typed goes with it.
//
// a refusal is a note and the phase carries on. the bot without BAN_MEMBERS
// cannot ban anybody, and saying so once per user is more useful than a
// failed restore.
//
// a user who is already banned is not a failure. the target's own ban list is
// read so the report can name them, instead of counting a ban that was already
// in place as one this restore applied.

import { listBackupBansByBackup } from "../../db/queries/backup-bans.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestoreContext, type RestorePhase } from "./types.ts";

/** one page of the target guild's bans. */
interface TargetBan {
  readonly user: { readonly id: string };
}

/** discord's own page size for the ban list, and the most it will return. */
const PAGE = 1000;

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

/** the users the target guild has already banned. */
async function readTargetBans(ctx: RestoreContext): Promise<Set<string>> {
  const banned = new Set<string>();
  let after: string | null = null;

  for (;;) {
    const route =
      after === null
        ? `/guilds/${ctx.targetGuildId}/bans?limit=${PAGE}`
        : `/guilds/${ctx.targetGuildId}/bans?limit=${PAGE}&after=${after}`;
    const page: TargetBan[] = await ctx.client.request<TargetBan[]>({ method: "GET", route });
    for (const ban of page) banned.add(ban.user.id);

    // a short page is the last one. the cursor is the last user id of the page.
    if (page.length < PAGE) return banned;
    const last = page[page.length - 1];
    if (last === undefined) return banned;
    after = last.user.id;
  }
}

export const restoreBans: RestorePhase = async (ctx) => {
  if (ctx.options.bans === false) return phaseOk(0);

  const bans = await listBackupBansByBackup(ctx.db, ctx.backupId);
  if (bans.length === 0) return phaseOk(0);

  const notes: { what: string; why: string }[] = [];

  // the target's own ban list, so a user who is already banned is named as
  // such. a bot without BAN_MEMBERS cannot read it, and cannot ban either, so
  // a failure here is not fatal: the bans below are attempted anyway and
  // discord's refusal is the note.
  let already: Set<string>;
  try {
    already = await readTargetBans(ctx);
  } catch {
    already = new Set();
  }

  let count = 0;
  for (const ban of bans) {
    if (already.has(ban.user_id)) {
      notes.push({
        what: `the ban of ${ban.user_id}`,
        why: "already banned in the target guild",
      });
      continue;
    }

    // the reason rides in the body, and it is what the moderator typed (11.4).
    const body: Record<string, unknown> = { delete_message_seconds: 0 };
    if (ban.reason !== null) body.reason = ban.reason;

    try {
      await ctx.client.request({
        method: "PUT",
        route: `/guilds/${ctx.targetGuildId}/bans/${ban.user_id}`,
        body,
      });
      count += 1;
    } catch (error) {
      // discord's own code and message, verbatim (rule 5).
      notes.push({ what: `the ban of ${ban.user_id}`, why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
};
