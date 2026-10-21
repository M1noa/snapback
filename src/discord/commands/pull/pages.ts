// the /pull pages.
//
// the plan page says who will be tried and who will not, and why, before
// anything happens. the report page says what happened, per account, with the
// reason the counters gave when they refused one (D4PLAN 15.2). the counters
// page says what each account may do today. the reset page clears one by hand,
// and the config page says which limits are in force.

import {
  ButtonStyles,
  type ContainerComponent,
  type MessageActionRowComponent,
  type TextDisplayComponent,
} from "oceanic.js";
import type { PullLimits } from "../../../services/pull/counter.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { actionRow, button } from "../../components/row.ts";
import { formatDuration, relativeTimestamp } from "../types.ts";
import type { PullLimitSource } from "./deps.ts";

/** how many accounts the pages list before they say how many more there are. */
export const ACCOUNT_LIST_SIZE = 20;

/** one account on the plan page. */
export interface PullPlanLine {
  readonly userId: string;
  readonly username: string | null;
  /** why the account will not be tried. null when it will be. */
  readonly skippedReason: string | null;
}

export interface PlanPageInput {
  readonly guildId: string;
  readonly lines: readonly PullPlanLine[];
  readonly trying: number;
  readonly skipping: number;
  readonly confirmId: string;
  readonly backId: string;
  readonly expiresAt: number;
}

/** the plan. what the run will do, before the run does it. */
export function planPage(input: PlanPageInput): ContainerComponent {
  const shown = input.lines.slice(0, ACCOUNT_LIST_SIZE);
  const sections = [
    textDisplay(
      `**${input.trying} account(s)** will be tried. **${input.skipping}** will not, and each one says why.`,
    ),
    ...(input.lines.length === 0
      ? [textDisplay("nobody has granted a token in this server yet, so there is nothing to pull.")]
      : shown.map((line) =>
          textDisplay(
            line.skippedReason === null
              ? `**<@${line.userId}>** (${line.username ?? "unknown"}) · will be tried`
              : `**<@${line.userId}>** (${line.username ?? "unknown"}) · skipped: ${line.skippedReason}`,
          ),
        )),
  ];
  if (input.lines.length > shown.length) {
    sections.push(textDisplay(`-# and ${input.lines.length - shown.length} more.`));
  }
  sections.push(
    textDisplay(
      "a member is added with the token they granted themselves. the bot never adds anyone with its own token.",
    ),
    textDisplay(`-# this confirmation expires ${relativeTimestamp(input.expiresAt)}`),
  );

  return page({
    state: input.trying === 0 ? "warning" : "info",
    title: "the pull",
    sections,
    controls: [
      actionRow([
        button({
          id: input.confirmId,
          label: "pull them in",
          style: ButtonStyles.PRIMARY,
          disabled: input.trying === 0,
        }),
        button({ id: input.backId, label: "not now", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** one account on the report page. */
export interface PullReportLine {
  readonly userId: string;
  readonly username: string | null;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly restricted: boolean;
  readonly restrictedReason: string | null;
  readonly cooldownUntil: string | null;
  /** the last attempt's outcome. null when the account was never tried. */
  readonly lastOutcome: string | null;
  /** what discord said, or why the counters refused. */
  readonly lastSaid: string | null;
}

export interface ReportPageInput {
  readonly guildId: string;
  readonly lines: readonly PullReportLine[];
  readonly totals: {
    readonly attempts: number;
    readonly successes: number;
    readonly failures: number;
    readonly restricted: number;
  };
  readonly jobId: string | null;
  readonly jobStatus: string | null;
  readonly jobError: string | null;
  readonly etaSeconds: number | null;
  readonly planId: string;
  readonly refreshId: string;
  /** null when no pull is running, so there is nothing to cancel. */
  readonly cancelId: string | null;
  /** null when no pull is running, so there is nothing to hold. */
  readonly pauseId: string | null;
  /** true when the run is already held, so the button says so. */
  readonly paused: boolean;
}

/** the report. what happened, per account, and what the counters are holding. */
export function reportPage(input: ReportPageInput): ContainerComponent {
  const shown = input.lines.slice(0, ACCOUNT_LIST_SIZE);
  const sections = [
    textDisplay(
      input.jobId === null
        ? "no pull has run in this server yet."
        : `job \`${input.jobId.slice(0, 8)}\` · ${input.jobStatus ?? "queued"}${
            input.etaSeconds === null
              ? ""
              : ` · about ${formatDuration(input.etaSeconds * 1000)} left`
          }`,
    ),
    textDisplay(
      input.jobError === null
        ? `today: ${input.totals.attempts} attempt(s) · ${input.totals.successes} success(es) · ${input.totals.failures} failure(s) · ${input.totals.restricted} restricted`
        : `**${input.jobError}**`,
    ),
    ...(input.lines.length === 0
      ? [textDisplay("nobody has verified in this server yet, so there are no accounts to pull.")]
      : shown.map((line) => textDisplay(reportLine(line)))),
  ];
  if (input.lines.length > shown.length) {
    sections.push(textDisplay(`-# and ${input.lines.length - shown.length} more.`));
  }

  const first: MessageActionRowComponent[] = [];
  first.push(button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY }));
  if (input.pauseId !== null) {
    first.push(
      button({
        id: input.pauseId,
        label: input.paused ? "resume" : "pause",
        style: ButtonStyles.SECONDARY,
      }),
    );
  }
  if (input.cancelId !== null) {
    first.push(button({ id: input.cancelId, label: "cancel", style: ButtonStyles.DANGER }));
  }

  return page({
    state: input.jobError === null ? "info" : "danger",
    title: "the pull",
    sections,
    controls: [
      actionRow(first),
      actionRow([button({ id: input.planId, label: "pull again", style: ButtonStyles.PRIMARY })]),
    ],
  });
}

/** one account's counters and its last attempt. */
function reportLine(line: PullReportLine): string {
  const parts = [
    `${line.attempts} attempt(s)`,
    `${line.successes} success(es)`,
    `${line.failures} failure(s)`,
  ];
  if (line.restricted) {
    parts.push(`restricted: ${line.restrictedReason ?? "discord restricted this account"}`);
  }
  if (line.cooldownUntil !== null) {
    parts.push(`cooldown until ${relativeTimestamp(Date.parse(line.cooldownUntil))}`);
  }
  const last =
    line.lastOutcome === null
      ? "not tried yet"
      : `${line.lastOutcome}${line.lastSaid === null ? "" : `: ${line.lastSaid}`}`;
  return `**<@${line.userId}>** (${line.username ?? "unknown"}) · ${parts.join(" · ")} · last: ${last}`;
}

/** one account's counters. */
export interface PullCounterLine {
  readonly userId: string;
  readonly username: string | null;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly restricted: boolean;
  readonly restrictedReason: string | null;
  readonly cooldownUntil: string | null;
  /** the days before today that have a row of their own. */
  readonly earlierDays: number;
}

export interface CountersPageInput {
  readonly guildId: string;
  readonly lines: readonly PullCounterLine[];
  readonly totals: {
    readonly attempts: number;
    readonly successes: number;
    readonly failures: number;
    readonly restricted: number;
  };
  readonly limits: PullLimits;
  readonly refreshId: string;
  readonly configId: string;
  readonly backId: string;
}

/** the counters. what each account may do today, and what is holding it. */
export function countersPage(input: CountersPageInput): ContainerComponent {
  const shown = input.lines.slice(0, ACCOUNT_LIST_SIZE);
  const sections = [
    textDisplay(
      `today: ${input.totals.attempts} attempt(s) · ${input.totals.successes} success(es) · ${input.totals.failures} failure(s) · ${input.totals.restricted} restricted`,
    ),
    ...(input.lines.length === 0
      ? [textDisplay("nobody has verified in this server yet, so there are no counters to show.")]
      : shown.map((line) => textDisplay(counterLine(line)))),
  ];
  if (input.lines.length > shown.length) {
    sections.push(textDisplay(`-# and ${input.lines.length - shown.length} more.`));
  }
  sections.push(
    textDisplay(
      `the limits in force: ${input.limits.dailyLimit} attempt(s) a day per account, a ${input.limits.failureCooldownMinutes} minute cooldown after a burst of failures, and ${input.limits.restrictedHours} hour(s) of hold for a restricted account.`,
    ),
    textDisplay("-# `/pull config` says where they come from. `/pull reset` clears one by hand."),
  );

  return page({
    state: "info",
    title: "the counters",
    sections,
    controls: [
      actionRow([
        button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY }),
        button({ id: input.configId, label: "the limits", style: ButtonStyles.SECONDARY }),
        button({ id: input.backId, label: "back", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** one account's counters, on their own. */
function counterLine(line: PullCounterLine): string {
  const parts = [
    `${line.attempts} attempt(s)`,
    `${line.successes} success(es)`,
    `${line.failures} failure(s)`,
  ];
  if (line.restricted) {
    parts.push(`restricted: ${line.restrictedReason ?? "discord restricted this account"}`);
  }
  if (line.cooldownUntil !== null) {
    parts.push(`cooldown until ${relativeTimestamp(Date.parse(line.cooldownUntil))}`);
  }
  if (line.earlierDays > 0) {
    parts.push(`${line.earlierDays} earlier day(s)`);
  }
  return `**<@${line.userId}>** (${line.username ?? "unknown"}) · ${parts.join(" · ")}`;
}

export interface ResetPageInput {
  readonly guildId: string;
  readonly userId: string;
  readonly username: string | null;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly restricted: boolean;
  readonly restrictedReason: string | null;
  readonly cooldownUntil: string | null;
  /** the button that asks for the typed confirmation. */
  readonly confirmId: string;
  readonly backId: string;
  /** true when the counters are already cleared. */
  readonly done: boolean;
}

/** the reset. it says what goes, and it asks for the name before it does it. */
export function resetPage(input: ResetPageInput): ContainerComponent {
  const name = input.username ?? "unknown";
  const sections: TextDisplayComponent[] = [];

  if (input.done) {
    sections.push(
      textDisplay(`the counters for **<@${input.userId}>** are cleared.`),
      textDisplay("0 attempt(s) · 0 success(es) · 0 failure(s) · no cooldown · not restricted."),
    );
  } else {
    sections.push(
      textDisplay(
        `this clears today's counters for **<@${input.userId}>** (${name}): ${input.attempts} attempt(s), ${input.successes} success(es), ${input.failures} failure(s).`,
      ),
    );
    if (input.restricted) {
      sections.push(
        textDisplay(`restricted: ${input.restrictedReason ?? "discord restricted this account"}`),
      );
    }
    if (input.cooldownUntil !== null) {
      sections.push(
        textDisplay(`the cooldown lifts ${relativeTimestamp(Date.parse(input.cooldownUntil))}.`),
      );
    }
    sections.push(
      textDisplay(`to confirm, type \`${name}\` in the box. a stray click cannot clear anything.`),
      textDisplay("-# the reset is written to the audit log, with your name on it."),
      textDisplay("-# the confirmation is one-time, and it lives for 15 minutes."),
    );
  }

  return page({
    state: input.done ? "success" : "warning",
    title: "reset the counters",
    sections,
    controls: input.done
      ? [actionRow([button({ id: input.backId, label: "back", style: ButtonStyles.SECONDARY })])]
      : [
          actionRow([
            button({
              id: input.confirmId,
              label: "type to confirm",
              style: ButtonStyles.DANGER,
            }),
            button({ id: input.backId, label: "not now", style: ButtonStyles.SECONDARY }),
          ]),
        ],
  });
}

export interface ConfigPageInput {
  readonly guildId: string;
  readonly limits: PullLimits;
  readonly sources: readonly PullLimitSource[];
  /** the edit button: opens the modal that writes the three values. */
  readonly editId: string;
  readonly backId: string;
}

/** the limits in force, and where each one comes from. */
export function configPage(input: ConfigPageInput): ContainerComponent {
  const sections = input.sources.map((source) =>
    textDisplay(
      `**${input.limits[source.key]}** · ${source.what} · stored as \`${source.setting}\` (default ${source.fallback}, allowed ${source.min}-${source.max})`,
    ),
  );
  sections.push(
    textDisplay("the counters are per account, per server, and they reset at midnight utc."),
    textDisplay("-# `/pull reset` clears one account by hand, and the reset is audited."),
  );

  return page({
    state: "info",
    title: "the pull limits",
    sections,
    controls: [
      actionRow([
        button({ id: input.editId, label: "edit", style: ButtonStyles.PRIMARY }),
        button({ id: input.backId, label: "back", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}
