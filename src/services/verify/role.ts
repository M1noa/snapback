// granting the verified role (D4PLAN 10.3). this is the last step of the flow:
// the person passed the challenge and the policy, so the role they were promised
// is added here.
//
// a grant that fails does not undo the verification. the record is already
// written and the page still says the verification worked; the operator gets
// discord's own words in the log, and the timeline keeps them too.

import type { DiscordClient } from "../../discord/client.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";

export type RoleGrantOutcome = "granted" | "skipped" | "failed";

export interface RoleGrantResult {
  readonly outcome: RoleGrantOutcome;
  /** discord's own words, when discord refused. null otherwise. */
  readonly said: string | null;
}

export interface RoleGrantDeps {
  readonly client: DiscordClient;
  readonly log: Logger;
}

/** add one role to one member. skipped when the guild has no role set, and when
 *  the verification came from the web flow, which carries no server. */
export async function grantVerifiedRole(
  deps: RoleGrantDeps,
  input: { guildId: string | null; userId: string; roleId: string | null },
): Promise<RoleGrantResult> {
  if (input.roleId === null || input.guildId === null || input.guildId === "") {
    return { outcome: "skipped", said: null };
  }

  try {
    await deps.client.request({
      method: "PUT",
      route: `/guilds/${input.guildId}/members/${input.userId}/roles/${input.roleId}`,
      reason: "snapback verification",
    });
    return { outcome: "granted", said: null };
  } catch (error) {
    if (error instanceof DiscordApiError) {
      const report = formatDiscordError(error);
      deps.log.error("granting the verified role was refused", {
        guildId: input.guildId,
        roleId: input.roleId,
        status: report.status,
        code: report.code,
        said: report.said,
        method: error.method,
        route: error.route,
      });
      return { outcome: "failed", said: report.said };
    }
    deps.log.error("granting the verified role threw", {
      guildId: input.guildId,
      roleId: input.roleId,
      method: "PUT",
      route: `/guilds/${input.guildId}/members/${input.userId}/roles/${input.roleId}`,
      message: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "failed", said: error instanceof Error ? error.message : String(error) };
  }
}
