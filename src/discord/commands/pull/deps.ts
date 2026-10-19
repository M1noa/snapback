// what the /pull surface needs, and the one builder for its custom ids.
//
// the pull adds people to a server with a token they granted themselves. there
// is no other path: no join url, no bot token, no proxy (D4PLAN 15.5). the
// counters decide who may be tried, and the engine skips the rest.

import type { Database } from "../../../db/types.ts";
import type { CustomIdSpec } from "../../../discord/interactions/router.ts";
import type { StateStore } from "../../../discord/interactions/state.ts";
import type { Logger } from "../../../lib/log.ts";
import type { JobRunner } from "../../../services/jobs/runner.ts";
import type { PullLimits } from "../../../services/pull/counter.ts";
import type { PullAccount, PullOutcomeReport } from "../../../services/pull/index.ts";
import { customID } from "../../components/row.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { CommandContext, CommandResult } from "../types.ts";

export const PULL_SURFACE = "pull";

/** the object slot, one per surface a control lives on. */
export const PULL_OBJECT = {
  /** the page that says what will be tried and what will not. */
  plan: "plan",
  /** the page that says what happened. */
  report: "report",
} as const;

/** the action slot, per object. a stray verb here is a boot failure, not a 404. */
export const PULL_ACTION = {
  /** the plan's button. it carries the one-time nonce. */
  confirm: "confirm",
  /** the plan's other button: nothing was started. */
  back: "back",
  /** stop the run that is going. */
  cancel: "cancel",
  /** the report again, with a fresh read. */
  refresh: "refresh",
  /** open the plan page. */
  plan: "plan",
} as const;

export interface PullCustomIdInput {
  readonly guildId: string;
  readonly object: (typeof PULL_OBJECT)[keyof typeof PULL_OBJECT];
  readonly action: string;
  readonly cursor?: string;
}

/** the only builder for this surface. the cursor slot is always written, so every
 *  id is six segments and the router can read every one of them (D4PLAN 9.3). */
export function pullCustomId(input: PullCustomIdInput): string {
  return customID({
    surface: PULL_SURFACE,
    guild: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.cursor ?? "",
  });
}

/** one account of this guild, and what its token can do. never a token. */
export interface PullAccountView {
  readonly userId: string;
  readonly username: string | null;
  readonly scopes: readonly string[];
  readonly tokenStatus: string;
  /** true when the record holds a token at all. */
  readonly hasToken: boolean;
}

export interface PullDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly jobs: JobRunner;
  /** epoch ms. injected so a page's relative timestamps are testable. */
  readonly now: () => number;
  /** the confirm nonce and the options it carries. */
  readonly state: StateStore;
  /** the counters' rules (D4PLAN 15.2). */
  readonly limits: PullLimits;
  /** re-checked on every interaction: a control rendered for an admin last week
   *  must fail closed today (AGENTS.md rule 8). */
  readonly authorize: (userId: string, guildId: string) => Promise<boolean>;
  /** record the action, so it is traceable (D4PLAN 5.1). */
  readonly audit: (input: {
    guildId: string;
    actorUserId: string;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  /** the people who verified in this guild. no tokens come back from here. */
  readonly accounts: (guildId: string) => Promise<PullAccountView[]>;
  /** the token one person granted, or null. it never reaches a log line. */
  readonly token: (userId: string) => Promise<string | null>;
  /** the engine: it asks the counters and pulls the accounts they allow. */
  readonly pull: (input: {
    guildId: string;
    accounts: readonly PullAccount[];
  }) => Promise<PullOutcomeReport[]>;
}

/** null when the person may act, and the refusal page when they may not. */
export async function refusal(deps: PullDeps, ctx: CommandContext): Promise<CommandResult | null> {
  if (await deps.authorize(ctx.userId, ctx.guildId)) return null;
  return {
    page: failurePage(
      "not your server's pull",
      "only this server's snapback admins can pull into it.",
      undefined,
      "ask one of this server's snapback admins, or the instance owner, for access.",
    ),
    ephemeral: true,
  };
}

/** every (surface, action) pair this build produces from a pull control. */
export const PULL_SPECS: readonly CustomIdSpec[] = [
  { surface: PULL_SURFACE, action: PULL_ACTION.confirm },
  { surface: PULL_SURFACE, action: PULL_ACTION.back },
  { surface: PULL_SURFACE, action: PULL_ACTION.cancel },
  { surface: PULL_SURFACE, action: PULL_ACTION.refresh },
  { surface: PULL_SURFACE, action: PULL_ACTION.plan },
];
