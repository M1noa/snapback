// the restore executor (D4PLAN 12.2, 12.8). the phases run in the plan's order,
// each one awaited, each one checkpointed, and each one independently failable.
//
// a phase that fails does not end the restore: the phases that do not depend on
// it still run, and the ones that do are marked skipped with the reason. a
// restore that stops at the first error loses the work it already did.

import { restoreAutomod } from "./automod.ts";
import { restoreBans } from "./bans.ts";
import { restoreCategories, restoreChannels } from "./channels.ts";
import { clearTarget } from "./clear.ts";
import { restoreEmojis } from "./emojis.ts";
import { restoreEvents } from "./events.ts";
import { restoreGuild } from "./guild.ts";
import { restoreMembers } from "./members.ts";
import { restoreMessages } from "./messages.ts";
import { restoreOnboarding } from "./onboarding.ts";
import { restoreOverwrites } from "./overwrites.ts";
import { restoreRoles } from "./roles.ts";
import { restoreThreads } from "./threads.ts";
import type {
  PhaseOutcome,
  RestoreContext,
  RestoreNote,
  RestorePhase,
  RestorePhaseName,
} from "./types.ts";

/** the phases, in the order they run. */
const PHASES: readonly { name: RestorePhaseName; run: RestorePhase }[] = [
  { name: "guild", run: restoreGuild },
  { name: "emojis", run: restoreEmojis },
  { name: "roles", run: restoreRoles },
  { name: "categories", run: restoreCategories },
  { name: "channels", run: restoreChannels },
  { name: "overwrites", run: restoreOverwrites },
  { name: "threads", run: restoreThreads },
  { name: "onboarding", run: restoreOnboarding },
  { name: "automod", run: restoreAutomod },
  { name: "events", run: restoreEvents },
  { name: "members", run: restoreMembers },
  { name: "bans", run: restoreBans },
  { name: "messages", run: restoreMessages },
];

/**
 * what each phase needs to have worked. a phase whose dependency failed is
 * skipped rather than run against a half-built guild (12.8).
 */
const NEEDS: Readonly<Record<RestorePhaseName, readonly RestorePhaseName[]>> = {
  guild: [],
  emojis: ["guild"],
  roles: ["guild"],
  categories: ["guild"],
  channels: ["roles", "categories"],
  overwrites: ["roles", "channels"],
  threads: ["channels"],
  onboarding: ["channels"],
  automod: ["roles", "channels", "emojis"],
  events: ["channels"],
  members: ["roles"],
  bans: [],
  messages: ["channels", "roles"],
  finish: [],
};

export interface PhaseReport {
  readonly phase: RestorePhaseName;
  readonly outcome: PhaseOutcome;
  readonly count: number;
  readonly notes: readonly RestoreNote[];
}

export interface RestoreReport {
  readonly backupId: string;
  readonly targetGuildId: string;
  readonly phases: readonly PhaseReport[];
  readonly startedAt: string;
  readonly finishedAt: string;
  /** true when the operator cancelled it, or a phase failed outright. */
  readonly cancelled: boolean;
  /** the whole thing is not reversible, in as many words. */
  readonly notReversible: string;
}

/** the restore ran; here is what happened, phase by phase. */
export async function runRestore(ctx: RestoreContext): Promise<RestoreReport> {
  const startedAt = ctx.now();
  const reports: PhaseReport[] = [];
  const failed = new Set<RestorePhaseName>();
  let cancelled = false;

  // the clear goes first and is not a phase of the plan: it is the destructive
  // one, and it runs before anything is created (12.7).
  if (ctx.options.clearBefore) {
    const cleared = await clearTarget(ctx);
    reports.push({
      phase: "guild",
      outcome: cleared.failed ? "fail" : cleared.count > 0 ? "warn" : "ok",
      count: cleared.count,
      notes: cleared.notes,
    });
    if (cleared.failed) failed.add("guild");
  }

  for (const { name, run } of PHASES) {
    if (ctx.signal.cancelled) {
      cancelled = true;
      break;
    }

    const blocked = NEEDS[name].filter((need) => failed.has(need));
    if (blocked.length > 0) {
      reports.push({
        phase: name,
        outcome: "skipped",
        count: 0,
        notes: [
          {
            what: `the ${name} phase`,
            why: `skipped (dependency failed): ${blocked.join(", ")}`,
          },
        ],
      });
      continue;
    }

    const result = await run(ctx);
    reports.push({
      phase: name,
      outcome: result.outcome,
      count: result.count,
      notes: result.notes,
    });
    if (result.failed) failed.add(name);
    await ctx.checkpoint(name, result.count, null);
  }

  return {
    backupId: ctx.backupId,
    targetGuildId: ctx.targetGuildId,
    phases: reports,
    startedAt,
    finishedAt: ctx.now(),
    cancelled,
    notReversible:
      "a restore cannot be undone. the target guild now holds what the backup held, and the members it could not add are still missing.",
  };
}
