// the shared parts of the /restore surface: the access check and the pickers.

import type { BackupRow } from "../../../db/types.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { CommandContext, CommandResult } from "../types.ts";
import type { RestoreDeps } from "./deps.ts";

/** null when the person may act, and the refusal page when they may not. */
export async function refusal(
  deps: RestoreDeps,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  if (await deps.authorize(ctx.userId, ctx.guildId)) return null;
  return {
    page: failurePage(
      "not your server's restores",
      "only this server's snapback admins can restore it.",
      undefined,
      "ask one of this server's snapback admins, or the instance owner, for access.",
    ),
    ephemeral: true,
  };
}

/** how a backup is named in a page: its label and its short id. */
export function backupLabel(row: BackupRow): string {
  return `${row.label ?? "(no label)"} \`${row.backup_id.slice(0, 8)}\``;
}

/** a string field of a stored payload, or null when it is not one. */
export function payloadString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
