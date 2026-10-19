// the automod phase (D4PLAN 12.2 step 9). a rule references roles, channels and
// emojis, so it runs after all three exist and the ids are remapped.

import { listBackupAutomodsByBackup } from "../../db/queries/backup-automod.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestorePhase } from "./types.ts";

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

export const restoreAutomod: RestorePhase = async (ctx) => {
  if (!ctx.options.automod) return phaseOk(0);
  const rules = await listBackupAutomodsByBackup(ctx.db, ctx.backupId);
  if (rules.length === 0) return phaseOk(0);

  const notes: { what: string; why: string }[] = [];
  let count = 0;

  for (const rule of rules) {
    const exemptRoles: string[] = [];
    for (const source of rule.exempt_roles_json) {
      const target = ctx.maps.roles.get(source);
      if (target === undefined) {
        notes.push({ what: `an exempt role of "${rule.name}"`, why: "it is not in the target" });
        continue;
      }
      exemptRoles.push(target);
    }
    const exemptChannels: string[] = [];
    for (const source of rule.exempt_channels_json) {
      const target = ctx.maps.channels.get(source);
      if (target === undefined) {
        notes.push({ what: `an exempt channel of "${rule.name}"`, why: "it is not in the target" });
        continue;
      }
      exemptChannels.push(target);
    }

    try {
      await ctx.client.request({
        method: "POST",
        route: `/guilds/${ctx.targetGuildId}/auto-moderation/rules`,
        body: {
          name: rule.name,
          event_type: rule.event_type,
          trigger_type: rule.trigger_type,
          trigger_metadata: rule.trigger_metadata_json ?? {},
          actions: rule.actions_json,
          enabled: rule.enabled,
          exempt_roles: exemptRoles,
          exempt_channels: exemptChannels,
        },
      });
      count += 1;
    } catch (error) {
      // a trigger the target does not have, or a rule the bot may not create: a
      // note, and the next rule still goes.
      notes.push({ what: `the automod rule "${rule.name}"`, why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
};
