// the /pull pages.
//
// the plan page says who will be tried and who will not, and why, before
// anything happens. the report page says what happened, per account, with the
// reason the counters gave when they refused one (D4PLAN 15.2).

import { ButtonStyles, type ContainerComponent, type MessageActionRowComponent } from "oceanic.js";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { actionRow, button } from "../../components/row.ts";
import { formatDuration, relativeTimestamp } from "../types.ts";

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
