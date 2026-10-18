// services/backup/automod.ts. D4PLAN 11 step 11: auto-moderation rules, with the
// trigger metadata and the actions kept as the json discord sent.

import { insertBackupAutomods } from "../../db/queries/backup-automod.ts";
import type { BackupAutomodRow, JsonObject } from "../../db/types.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import type { BackupContext, Capture } from "./types.ts";
import { skipFor } from "./types.ts";

interface RawRule {
  id: string;
  name: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata?: JsonObject;
  actions?: JsonObject[];
  enabled?: boolean;
  exempt_roles?: string[];
  exempt_channels?: string[];
}

function toRuleRow(ctx: BackupContext, rule: RawRule): BackupAutomodRow {
  return {
    backup_id: ctx.backupId,
    source_rule_id: rule.id,
    name: rule.name,
    event_type: rule.event_type,
    trigger_type: rule.trigger_type,
    trigger_metadata_json: rule.trigger_metadata ?? null,
    actions_json: rule.actions ?? [],
    enabled: rule.enabled !== false,
    exempt_roles_json: rule.exempt_roles ?? [],
    exempt_channels_json: rule.exempt_channels ?? [],
  };
}

export const captureAutomod: Capture = async (ctx) => {
  let raw: RawRule[];
  try {
    raw = await ctx.client.request<RawRule[]>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/auto-moderation/rules`,
    });
  } catch (error) {
    // the endpoint needs MANAGE_GUILD: a 403 is one skip carrying discord's words.
    // anything else is a bug here, and belongs in the pipeline's failure list
    // rather than in the skip list (AGENTS.md: never catch and swallow).
    if (!(error instanceof DiscordApiError)) throw error;
    ctx.skips.add(skipFor("automod", "all auto-moderation rules", error));
    return { written: 0 };
  }

  const rows = (Array.isArray(raw) ? raw : []).map((rule) => toRuleRow(ctx, rule));
  await insertBackupAutomods(ctx.db, rows);
  await ctx.checkpoint("automod", { done: 1, total: 1 });
  return { written: rows.length };
};
