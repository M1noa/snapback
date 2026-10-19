// /pull (D4PLAN 8, 15): start and status.
//
// the pull is a job: it makes one request per account, and that outlives an
// interaction (AGENTS.md rule 7). the plan page says who will be tried and who
// will not before anything happens, and the report says what happened after.
//
// a member is added with a token they granted themselves. the bot never adds
// anyone with its own token, and there is no join url anywhere here (D4PLAN 15.5).

import { getAccountCounter } from "../../../db/queries/counters.ts";
import { listJobsByGuild } from "../../../db/queries/jobs.ts";
import { insertPullAttempt, listPullAttemptsByUser } from "../../../db/queries/pull-attempts.ts";
import type { JobHandler } from "../../../services/jobs/runner.ts";
import { decideAttempt, utcDay } from "../../../services/pull/counter.ts";
import { STATE_TTL_MS } from "../../interactions/state.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { CommandContext, CommandResult, SlashCommand } from "../types.ts";
import {
  PULL_ACTION,
  PULL_OBJECT,
  PULL_SURFACE,
  type PullAccountView,
  type PullDeps,
  pullCustomId,
  refusal,
} from "./deps.ts";
import { type PullPlanLine, type PullReportLine, planPage, reportPage } from "./pages.ts";

const GROUP = "pull";

/** how many attempts one account's history is read back for. */
const ATTEMPT_LIMIT = 200;

/** the most accounts one run may try. */
const MAX_PER_RUN = 500;

const START_OPTIONS: readonly CommandOption[] = [
  {
    name: "exclude_revoked",
    description: "leave out the accounts that revoked (default: yes)",
    type: OPTION_TYPE.boolean,
  },
  {
    name: "max",
    description: "how many accounts to try in this run",
    type: OPTION_TYPE.integer,
    min_value: 1,
    max_value: MAX_PER_RUN,
  },
];

/** every /pull subcommand, one group. */
export function pullCommands(deps: PullDeps): SlashCommand[] {
  return [
    {
      group: GROUP,
      subcommand: "start",
      description: "pull the accounts that granted a token into this server",
      options: START_OPTIONS,
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        return {
          page: await planPageFor(deps, ctx.guildId, ctx.userId, {
            excludeRevoked: ctx.options.exclude_revoked !== false,
            max: limitOf(ctx.options.max),
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "status",
      description: "how many attempts, successes and failures, and what is restricted",
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        return { page: await reportPageFor(deps, ctx.guildId), ephemeral: true };
      },
    },
  ];
}

/** the plan page. who will be tried, who will not, and why. the nonce is the
 *  one-time value the confirm button carries; it lives in interaction_state,
 *  never in a customID (D4PLAN 9.3). */
export async function planPageFor(
  deps: PullDeps,
  guildId: string,
  userId: string,
  options: { readonly excludeRevoked: boolean; readonly max: number | null },
): Promise<ReturnType<typeof planPage>> {
  const accounts = await deps.accounts(guildId);
  const eligible = options.excludeRevoked
    ? accounts.filter((account) => account.tokenStatus !== "revoked")
    : accounts;
  const chosen = options.max === null ? eligible : eligible.slice(0, options.max);

  const now = new Date(deps.now());
  const lines: PullPlanLine[] = [];
  for (const account of chosen) {
    lines.push({
      userId: account.userId,
      username: account.username,
      skippedReason: await skipReason(deps, guildId, account, now),
    });
  }
  const trying = lines.filter((line) => line.skippedReason === null).length;

  const nonce = await deps.state.put({
    guildId,
    userId,
    surface: PULL_SURFACE,
    payload: { action: "pull", excludeRevoked: options.excludeRevoked, max: options.max },
  });

  return planPage({
    guildId,
    lines,
    trying,
    skipping: lines.length - trying,
    confirmId: pullCustomId({
      guildId,
      object: PULL_OBJECT.plan,
      action: PULL_ACTION.confirm,
      cursor: nonce,
    }),
    backId: pullCustomId({
      guildId,
      object: PULL_OBJECT.report,
      action: PULL_ACTION.back,
    }),
    expiresAt: deps.now() + STATE_TTL_MS,
  });
}

/** the run's limit, or null when the operator named none. */
function limitOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PER_RUN);
}

/** why an account will not be tried, or null when it will be. a token the
 *  member never granted is a harder blocker than a counter, so it comes first. */
async function skipReason(
  deps: PullDeps,
  guildId: string,
  account: PullAccountView,
  now: Date,
): Promise<string | null> {
  if (!account.hasToken) return "no token was granted";
  if (!account.scopes.includes("guilds.join")) return "the token has no guilds.join scope";
  const counter = await getAccountCounter(deps.db, account.userId, guildId, utcDay(now));
  const decision = decideAttempt(counter, now, deps.limits);
  return decision.allowed ? null : decision.reason;
}

/** the report. every account's counters and its last attempt, and the job that
 *  ran them. */
export async function reportPageFor(
  deps: PullDeps,
  guildId: string,
): Promise<ReturnType<typeof reportPage>> {
  const now = new Date(deps.now());
  const day = utcDay(now);
  const accounts = await deps.accounts(guildId);

  const lines: PullReportLine[] = [];
  let attempts = 0;
  let successes = 0;
  let failures = 0;
  let restricted = 0;

  for (const account of accounts) {
    const counter = await getAccountCounter(deps.db, account.userId, guildId, day);
    const history = (await listPullAttemptsByUser(deps.db, account.userId, ATTEMPT_LIMIT)).filter(
      (row) => row.guild_id === guildId,
    );
    const last = history[0];

    lines.push({
      userId: account.userId,
      username: account.username,
      attempts: counter?.attempts ?? 0,
      successes: counter?.successes ?? 0,
      failures: counter?.failures ?? 0,
      restricted: counter?.restricted ?? false,
      restrictedReason: counter?.restricted_reason ?? null,
      cooldownUntil: counter?.cooldown_until ?? null,
      lastOutcome: last?.outcome ?? null,
      lastSaid: last?.error_body ?? null,
    });

    attempts += counter?.attempts ?? 0;
    successes += counter?.successes ?? 0;
    failures += counter?.failures ?? 0;
    if (counter?.restricted === true) restricted += 1;
  }

  const jobs = (await listJobsByGuild(deps.db, guildId)).filter((job) => job.kind === "pull");
  const latest = jobs[0];
  const running =
    latest !== undefined &&
    (latest.status === "queued" || latest.status === "running" || latest.status === "paused");

  return reportPage({
    guildId,
    lines,
    totals: { attempts, successes, failures, restricted },
    jobId: latest?.id ?? null,
    jobStatus: latest?.status ?? null,
    jobError: latest?.error_code ?? null,
    etaSeconds: latest === undefined ? null : await deps.jobs.eta(latest.id),
    planId: pullCustomId({
      guildId,
      object: PULL_OBJECT.report,
      action: PULL_ACTION.plan,
    }),
    refreshId: pullCustomId({
      guildId,
      object: PULL_OBJECT.report,
      action: PULL_ACTION.refresh,
    }),
    cancelId:
      running && latest !== undefined
        ? pullCustomId({
            guildId,
            object: PULL_OBJECT.report,
            action: PULL_ACTION.cancel,
            cursor: latest.id,
          })
        : null,
    pauseId:
      running && latest !== undefined
        ? pullCustomId({
            guildId,
            object: PULL_OBJECT.report,
            action: PULL_ACTION.pause,
            cursor: latest.id,
          })
        : null,
    paused: latest?.status === "paused",
  });
}

/** the job that pulls the accounts in. one account at a time, so a cancel takes
 *  effect at the next account instead of at the end of the run. */
export function createPullJobHandler(deps: PullDeps): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload_json ?? {}) as { excludeRevoked?: boolean; max?: number };
    const guildId = ctx.job.guild_id;
    const excludeRevoked = payload.excludeRevoked !== false;
    const accounts = await deps.accounts(guildId);
    const eligible = excludeRevoked
      ? accounts.filter((account) => account.tokenStatus !== "revoked")
      : accounts;
    const limit =
      typeof payload.max === "number" && payload.max > 0 ? payload.max : eligible.length;
    const chosen = eligible.slice(0, limit);

    let done = 0;
    for (const account of chosen) {
      if (ctx.signal.cancelled || ctx.signal.paused) break;

      // a paused run picks up where it stopped, so an account an earlier run of
      // this job already pulled is not pulled again.
      if (await alreadyPulled(deps, guildId, account.userId, ctx.job.started_at)) {
        await recordSkip(
          deps,
          guildId,
          account.userId,
          "an earlier run of this job already pulled them",
        );
        done += 1;
        await ctx.checkpoint("pull", { done, total: chosen.length });
        continue;
      }

      const token = await deps.token(account.userId);
      if (token === null) {
        await recordSkip(deps, guildId, account.userId, "no token was granted");
      } else if (!account.scopes.includes("guilds.join")) {
        await recordSkip(deps, guildId, account.userId, "the token has no guilds.join scope");
      } else {
        const report = await deps.pull({
          guildId,
          accounts: [{ userId: account.userId, accessToken: token }],
        });
        for (const entry of report) {
          // the token never reaches the log line, and neither does the address.
          ctx.log.info("pull attempt", {
            userId: entry.userId,
            outcome: entry.outcome,
            code: entry.errorCode,
            said: entry.errorBody,
          });
        }
      }

      done += 1;
      await ctx.checkpoint("pull", { done, total: chosen.length });
    }
  };
}

/** true when this job already pulled the account into this guild. */
async function alreadyPulled(
  deps: PullDeps,
  guildId: string,
  userId: string,
  since: string | null,
): Promise<boolean> {
  if (since === null) return false;
  const rows = await listPullAttemptsByUser(deps.db, userId, ATTEMPT_LIMIT);
  return rows.some(
    (row) =>
      row.guild_id === guildId &&
      row.attempted_at >= since &&
      (row.outcome === "added" || row.outcome === "already_member"),
  );
}

/** a skip is still an attempt row: the operator sees that the bot considered
 *  the account and why it did nothing (D4PLAN 15.2). */
async function recordSkip(
  deps: PullDeps,
  guildId: string,
  userId: string,
  reason: string,
): Promise<void> {
  await insertPullAttempt(deps.db, {
    id: Bun.randomUUIDv7(),
    guild_id: guildId,
    user_id: userId,
    attempted_at: new Date(deps.now()).toISOString(),
    outcome: "skipped",
    error_code: null,
    error_body: reason,
  });
}
