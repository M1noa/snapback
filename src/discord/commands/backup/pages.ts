// the /backup pages. every one goes through page(), so the accent, the status
// word, the title line and the control rows are the same shape as everywhere else
// (D4PLAN 9.2, AGENTS.md consistency).

import { ButtonStyles, type ContainerComponent, type SelectOption } from "oceanic.js";
import type { BackupRow, JobRow, RetentionRow } from "../../../db/types.ts";
import { confirmPage } from "../../../setup/pages.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { actionRow, button, stringSelect } from "../../components/row.ts";
import { formatBytes, formatDuration, relativeTimestamp } from "../types.ts";
import { BACKUP_ACTION, BACKUP_OBJECT, backupCustomId } from "./deps.ts";

/** one row of a list: a label, and the backup it opens. the select carries the
 *  backup id; the page keeps the rest. */
export interface BackupListRow {
  readonly backup: BackupRow;
}

// how many rows one page holds. the select plus the two control rows and the
// header stay well inside the 40-component budget.
export const LIST_PAGE_SIZE = 20;

function statusWord(row: BackupRow): string {
  const check = row.self_check_json;
  if (check === null) return "incomplete (still open)";
  if (!check.ok) return `incomplete (${check.failures.length} failure(s))`;
  if (check.skipped.length > 0) return `done (${check.skipped.length} skipped)`;
  return "done";
}

export function backupLine(row: BackupRow): string {
  const label = row.label ?? "(no label)";
  return `\`${row.backup_id.slice(0, 8)}\` **${label}** ${row.kind} ${relativeTimestamp(
    Date.parse(row.created_at),
  )} ${statusWord(row)}`;
}

export interface ListPageInput {
  readonly guildId: string;
  readonly rows: readonly BackupRow[];
  readonly page: number;
  readonly total: number;
  readonly selectId: string;
  readonly prevId: string;
  readonly nextId: string;
  readonly createId: string;
}

/** the list. an empty list says what to run rather than showing a blank page. */
export function listPage(input: ListPageInput): ContainerComponent {
  const pages = Math.max(1, Math.ceil(input.total / LIST_PAGE_SIZE));
  const options: SelectOption[] = input.rows.map((row) => ({
    label: `${row.label ?? "(no label)"} ${row.kind}`.slice(0, 100),
    value: row.backup_id,
    description: `${statusWord(row)} ${relativeTimestamp(Date.parse(row.created_at))} ${formatBytes(
      row.size_bytes,
    )}`.slice(0, 100),
  }));

  const sections = [
    textDisplay(
      `**${input.total} backup(s)** kept for this server. page ${input.page} of ${pages}.`,
    ),
    ...(input.rows.length === 0
      ? [textDisplay("no backups yet, run `/backup create` to capture this server.")]
      : input.rows.map((row) => textDisplay(backupLine(row)))),
  ];

  const controls = [] as ReturnType<typeof actionRow>[];
  if (options.length > 0) {
    controls.push(
      actionRow([
        stringSelect({
          id: input.selectId,
          placeholder: "open a backup",
          options,
        }),
      ]),
    );
  }
  controls.push(
    actionRow([
      button({ id: input.prevId, label: "previous", style: ButtonStyles.SECONDARY }),
      button({ id: input.nextId, label: "next", style: ButtonStyles.SECONDARY }),
      button({ id: input.createId, label: "refresh", style: ButtonStyles.SECONDARY }),
    ]),
  );

  return page({
    state: input.total === 0 ? "warning" : "info",
    title: `backups (page ${input.page} of ${pages})`,
    sections,
    controls,
  });
}

export interface InfoPageInput {
  readonly guildId: string;
  readonly backup: BackupRow;
  readonly contents: readonly string[];
  readonly deleteId: string;
  readonly exportId: string;
  readonly listId: string;
}

/** one backup in detail: counts, age, size, what is inside, and the two actions.
 *  the self-check's failures and every skip are shown, never summarised away. */
export function infoPage(input: InfoPageInput): ContainerComponent {
  const row = input.backup;
  const check = row.self_check_json;

  const sections = [
    textDisplay(
      [
        `**${row.label ?? "(no label)"}** · ${row.kind} · captured ${relativeTimestamp(
          Date.parse(row.created_at),
        )}`,
        `server: ${row.guild_name ?? "unknown"} · by <@${row.created_by}>`,
      ].join("\n"),
    ),
    textDisplay(
      [
        `roles ${row.role_count} · channels ${row.channel_count} · members ${row.member_count} · messages ${row.message_count}`,
        `size ${formatBytes(row.size_bytes)} · payload schema ${row.schema_version}`,
      ].join("\n"),
    ),
    ...input.contents.map((line) => textDisplay(line)),
  ];

  if (check === null) {
    sections.push(
      textDisplay(
        "**still open or never sealed.** a step did not finish, so the counts above may be short.",
      ),
    );
  } else {
    const state = check.ok ? "done" : "failed";
    sections.push(textDisplay(`**self-check ${state}.**`));
    for (const failure of check.failures.slice(0, 8)) {
      sections.push(textDisplay(`- ${failure}`));
    }
    if (check.failures.length > 8) {
      sections.push(textDisplay(`- and ${check.failures.length - 8} more failure(s)`));
    }
    for (const skip of check.skipped.slice(0, 8)) {
      sections.push(textDisplay(`- skipped ${skip.category}: ${skip.what} (${skip.why})`));
    }
    if (check.skipped.length > 8) {
      sections.push(textDisplay(`- and ${check.skipped.length - 8} more skip(s)`));
    }
  }

  return page({
    state: check === null || !check.ok ? "warning" : "info",
    title: `backup ${row.backup_id.slice(0, 8)}`,
    sections,
    controls: [
      actionRow([
        button({ id: input.exportId, label: "export", style: ButtonStyles.SECONDARY }),
        button({ id: input.listId, label: "back to list", style: ButtonStyles.SECONDARY }),
      ]),
      actionRow([button({ id: input.deleteId, label: "delete", style: ButtonStyles.DANGER })]),
    ],
  });
}

export interface JobPageInput {
  readonly job: JobRow;
  readonly guildId: string;
  readonly etaSeconds: number | null;
  readonly refreshId: string;
  readonly pauseId: string;
  readonly cancelId: string;
  readonly infoId: string | null;
  /** one extra line about the result, such as where an export landed. */
  readonly note?: string | null;
}

/** a job's page. the words say what the colour says, and the ETA appears only
 *  once there is progress to compute one from (AGENTS.md quality of life). */
export function jobPage(input: JobPageInput): ContainerComponent {
  const { job } = input;
  const state =
    job.status === "succeeded"
      ? "success"
      : job.status === "failed"
        ? "danger"
        : job.status === "running"
          ? "busy"
          : "warning";

  const lines = [
    `job \`${job.id.slice(0, 8)}\` · ${job.kind} · ${job.status}`,
    job.started_at === null ? "queued" : `started ${relativeTimestamp(Date.parse(job.started_at))}`,
  ];
  if (input.etaSeconds !== null)
    lines.push(`about ${formatDuration(input.etaSeconds * 1000)} left`);
  if (job.error_code !== null) lines.push(`**${job.error_code}** ${job.error_body ?? ""}`);
  if (input.note != null) lines.push(input.note);

  const controls = [] as ReturnType<typeof actionRow>[];
  const live = job.status === "queued" || job.status === "running" || job.status === "paused";
  const row = [button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY })];
  if (live) {
    row.push(
      job.status === "paused"
        ? button({ id: input.pauseId, label: "resume", style: ButtonStyles.PRIMARY })
        : button({ id: input.pauseId, label: "pause", style: ButtonStyles.SECONDARY }),
      button({ id: input.cancelId, label: "cancel", style: ButtonStyles.DANGER }),
    );
  }
  if (input.infoId !== null) {
    row.push(button({ id: input.infoId, label: "open backup", style: ButtonStyles.PRIMARY }));
  }
  controls.push(actionRow(row));

  return page({ state, title: `backup ${job.status}`, sections: lines.map(textDisplay), controls });
}

/** the prune plan: what would go, why, and what stays. */
export function prunePage(input: {
  readonly guildId: string;
  readonly policy: RetentionRow;
  readonly removals: readonly { readonly label: string; readonly reason: string }[];
  readonly keptCount: number;
  readonly confirmId: string;
  readonly policyId: string;
  readonly listId: string;
  readonly dryRun: boolean;
}): ContainerComponent {
  const policy = input.policy;
  const summary =
    policy.keep_days === null && policy.keep_count === null
      ? "no policy is set, so nothing is ever pruned. press **set the policy** and give it a number of days, a count, or both."
      : `keeping ${[
          policy.keep_days === null ? null : `anything newer than ${policy.keep_days} day(s)`,
          policy.keep_count === null ? null : `the newest ${policy.keep_count}`,
        ]
          .filter((part) => part !== null)
          .join(
            " and ",
          )}${policy.keep_kind_json === null ? "" : `, only ${policy.keep_kind_json.join(", ")}`}.`;

  const sections = [
    textDisplay(summary),
    textDisplay(
      input.removals.length === 0
        ? "nothing to remove."
        : `**${input.removals.length} backup(s) would go**, ${input.keptCount} stay.`,
    ),
    ...input.removals.map((removal) => textDisplay(`- ${removal.label}: ${removal.reason}`)),
  ];

  return page({
    state: input.removals.length === 0 ? "info" : "warning",
    title: input.dryRun ? "prune (dry run)" : "prune",
    sections,
    controls: [
      actionRow([
        button({ id: input.policyId, label: "set the policy", style: ButtonStyles.PRIMARY }),
        // nothing to delete means no delete button: a danger control that leads
        // to an empty plan teaches the wrong thing.
        ...(input.removals.length === 0
          ? []
          : [button({ id: input.confirmId, label: "delete them", style: ButtonStyles.DANGER })]),
        button({ id: input.listId, label: "cancel", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** the second page a delete gets: what goes, what it costs, and a one-time nonce
 *  on the confirm button (AGENTS.md destructive actions). */
export function confirmDeletePage(input: {
  readonly guildId: string;
  readonly backup: BackupRow;
  readonly nonce: string;
  readonly expiresAt: number;
}): ContainerComponent {
  const row = input.backup;
  return confirmPage({
    guildId: input.guildId,
    title: "delete this backup",
    what: `delete \`${row.backup_id.slice(0, 8)}\` (${row.label ?? "no label"}), its ${row.message_count} message(s) and every file it wrote.`,
    consequence:
      "this cannot be undone. the backup is gone from this server, and no restore can use it afterwards.",
    nonce: input.nonce,
    cancel: backupCustomId({
      guildId: input.guildId,
      object: BACKUP_OBJECT.info,
      action: BACKUP_ACTION.delete,
      cursor: row.backup_id,
    }),
    expiresAt: input.expiresAt,
    buildId: (nonce) =>
      backupCustomId({
        guildId: input.guildId,
        object: BACKUP_OBJECT.del,
        action: BACKUP_ACTION.confirm,
        cursor: nonce,
      }),
  });
}
