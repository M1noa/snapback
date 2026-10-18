// services/backup/onboarding.ts. D4PLAN 11 step 9: the onboarding prompts and the
// default channels a new member lands in.

import { getBackup, updateBackup } from "../../db/queries/backups.ts";
import type { JsonObject } from "../../db/types.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import type { Capture } from "./types.ts";
import { included, skipFor } from "./types.ts";

export const captureOnboarding: Capture = async (ctx) => {
  if (!included(ctx, "onboarding")) {
    ctx.skips.add({
      category: "onboarding",
      what: "onboarding prompts and default channels",
      why: "onboarding is turned off in /setup backup",
    });
    return { written: 0 };
  }

  let onboarding: JsonObject;
  try {
    onboarding = await ctx.client.request<JsonObject>({
      method: "GET",
      route: `/guilds/${ctx.guildId}/onboarding`,
    });
  } catch (error) {
    // a guild without COMMUNITY gets a 404 here, and a bot without MANAGE_GUILD a
    // 403. both are one skip: the rest of the backup is still worth having. a bug
    // of ours is neither and must reach the pipeline.
    if (!(error instanceof DiscordApiError)) throw error;
    ctx.skips.add(skipFor("onboarding", "onboarding", error));
    return { written: 0 };
  }

  const existing = await getBackup(ctx.db, ctx.backupId);
  if (existing === null) {
    ctx.skips.add({
      category: "onboarding",
      what: "onboarding",
      why: "the backup row is gone, so there is nowhere to store it",
    });
    return { written: 0 };
  }

  await updateBackup(ctx.db, { ...existing, onboarding_json: onboarding });
  await ctx.checkpoint("onboarding", { done: 1, total: 1 });
  return { written: 1 };
};
