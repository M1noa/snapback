// the /users pages.
//
// a field that was never captured says so, rather than showing a blank that
// reads like "nothing there". the address appears in the form the storage mode
// produced, and the mode is named next to it, so a reader can tell a hash from
// an address (D4PLAN 17.3).

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import type { IpStorage } from "../../../config/parse-env.ts";
import type { BlacklistAttemptRow, GuildBlacklistRow, VerifyRecordRow } from "../../../db/types.ts";
import {
  describeAttempt,
  describeMatches,
  fingerprintPreview,
} from "../../../services/verify/attempts.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { actionRow, button, stringSelect } from "../../components/row.ts";
import { formatBytes, relativeTimestamp } from "../types.ts";
import {
  type CounterView,
  type ExportScope,
  IP_MODE_NOTE,
  type MembershipView,
  storedIp,
} from "./deps.ts";

/** how many records the list state shows before it says how many more there are. */
export const RECORD_LIST_SIZE = 10;

export interface RecordPageInput {
  readonly guildId: string;
  /** the record being shown. null when the page lists the records instead. */
  readonly record: VerifyRecordRow | null;
  /** the guild's records, for the picker and for the list. */
  readonly records: readonly VerifyRecordRow[];
  readonly membership: MembershipView | null;
  /** today's pull counters for this account. */
  readonly counters: CounterView | null;
  readonly ipStorage: IpStorage;
  readonly selectId: string;
  readonly exportId: string;
}

/** one record in full, with the counters of the account that made it. */
export function recordPage(input: RecordPageInput): ContainerComponent {
  const controls = [] as ReturnType<typeof actionRow>[];
  if (input.records.length > 0) {
    controls.push(
      actionRow([
        stringSelect({
          id: input.selectId,
          placeholder: "open another record",
          options: input.records.slice(0, 25).map((row) => ({
            label: `${row.username ?? "unknown"} ${row.user_id}`.slice(0, 100),
            value: row.user_id,
          })),
        }),
      ]),
    );
  }
  controls.push(
    actionRow([
      button({ id: input.exportId, label: "export the records", style: ButtonStyles.SECONDARY }),
    ]),
  );

  if (input.record === null) {
    return listPage(input, controls);
  }

  const row = input.record;
  const address = storedIp(input.ipStorage, row.last_ip_hash, row.last_ip_enc);
  const sections = [
    textDisplay(
      [
        `**<@${row.user_id}>** · ${row.username ?? "unknown"}${
          row.global_name === null ? "" : ` · ${row.global_name}`
        }`,
        `scopes: ${(row.oauth_scopes_json ?? []).join(", ") || "none"} · token: ${row.token_status}`,
      ].join("\n"),
    ),
    textDisplay(
      [
        `email: ${
          row.email === null ? "not captured (the email scope was not granted)" : row.email
        }${
          row.email_verified === null ? "" : row.email_verified ? " (verified)" : " (not verified)"
        }`,
        `address: ${address === null ? "not captured" : address} · mode: ${input.ipStorage}`,
        `-# ${IP_MODE_NOTE[input.ipStorage]}`,
      ].join("\n"),
    ),
    textDisplay(
      [
        `network: ${row.country_name ?? "no intel was run"} · ${row.isp ?? "no intel was run"}`,
        `as org: ${row.as_org ?? "no intel was run"} · type: ${row.ip_type ?? "no intel was run"}`,
      ].join("\n"),
    ),
    textDisplay(membershipLine(input.membership)),
    textDisplay(countersLine(input.counters)),
    textDisplay(
      `verified ${relativeTimestamp(Date.parse(row.oauth_granted_at ?? row.created_at))}${
        row.oauth_last_checked_at === null
          ? ""
          : ` · last checked ${relativeTimestamp(Date.parse(row.oauth_last_checked_at))}`
      }`,
    ),
  ];

  return page({
    state: "info",
    title: `the record for ${row.username ?? "unknown"}`,
    sections,
    controls,
  });
}

/** the records of this server, and a picker to open one. */
function listPage(
  input: RecordPageInput,
  controls: ReturnType<typeof actionRow>[],
): ContainerComponent {
  const shown = input.records.slice(0, RECORD_LIST_SIZE);
  const sections = [
    textDisplay(`**${input.records.length} record(s)** in this server.`),
    ...(input.records.length === 0
      ? [textDisplay("nobody has verified here yet. post the verification panel and someone will.")]
      : shown.map((row) =>
          textDisplay(
            `**<@${row.user_id}>** (${row.username ?? "unknown"}) · ${row.token_status} · ${
              (row.oauth_scopes_json ?? []).join(", ") || "no scopes"
            }`,
          ),
        )),
  ];
  if (input.records.length > shown.length) {
    sections.push(textDisplay(`-# and ${input.records.length - shown.length} more.`));
  }

  return page({
    state: input.records.length === 0 ? "warning" : "info",
    title: "the records of this server",
    sections,
    controls,
  });
}

/** where the person stands in this server. */
function membershipLine(membership: MembershipView | null): string {
  if (membership === null || membership.state === "unknown") {
    return "membership: could not be read.";
  }
  if (membership.state === "not_member") return "membership: not in this server.";
  const nickname = membership.nickname === null ? "" : ` · nickname ${membership.nickname}`;
  const joined =
    membership.joinedAt === null
      ? ""
      : ` · joined ${relativeTimestamp(Date.parse(membership.joinedAt))}`;
  return `membership: in this server${nickname}${joined}.`;
}

/** today's pull counters for the account. */
function countersLine(counters: CounterView | null): string {
  if (counters === null) return "pull counters: no attempt today.";
  const parts = [
    `${counters.attempts} attempt(s)`,
    `${counters.successes} success(es)`,
    `${counters.failures} failure(s)`,
  ];
  if (counters.restricted) {
    parts.push(`restricted: ${counters.restrictedReason ?? "discord restricted this account"}`);
  }
  if (counters.cooldownUntil !== null) {
    parts.push(`cooldown until ${relativeTimestamp(Date.parse(counters.cooldownUntil))}`);
  }
  return `pull counters today: ${parts.join(" · ")}.`;
}

export interface ExportPageInput {
  readonly guildId: string;
  /** which of the three exports this page is about. */
  readonly scope: ExportScope;
  /** whose timeline it holds, when the scope is one person's. */
  readonly subjectId: string | null;
  /** the export job, when there is one. */
  readonly jobId: string | null;
  readonly jobStatus: string | null;
  readonly jobError: string | null;
  /** how many records or events the file holds. */
  readonly count: number | null;
  /** whether the file's cap cut the oldest out. */
  readonly truncated: boolean;
  readonly filePath: string | null;
  readonly fileBytes: number | null;
  readonly ipStorage: IpStorage;
  readonly backId: string;
  readonly refreshId: string;
}

/** the export. what it holds, what it leaves out, and where the file is. */
export function exportPage(input: ExportPageInput): ContainerComponent {
  const records = input.scope === "records";
  const what =
    input.scope === "records"
      ? "the file holds every field of every record, with the tokens left out entirely."
      : "the file holds every change this server recorded, with no message text and no attachment bytes.";
  const middle = records
    ? [`the address is written in the \`${input.ipStorage}\` form, and the header names it.`]
    : [
        input.scope === "tracking_user" && input.subjectId !== null
          ? `it covers one person: \`${input.subjectId}\`.`
          : "it covers every change in this server.",
        input.truncated
          ? "the file holds the newest events only. the older ones were left out, and the header says so."
          : "the file holds every event this server still keeps.",
      ];

  const sections = [
    textDisplay(
      input.jobId === null
        ? "no export has run in this server yet."
        : `job \`${input.jobId.slice(0, 8)}\` · ${input.jobStatus ?? "queued"}`,
    ),
    textDisplay(input.jobError === null ? what : `**${input.jobError}**`),
    ...middle.map((line) => textDisplay(line)),
    textDisplay(
      input.filePath === null
        ? "the file is not written yet."
        : `file: \`${input.filePath}\` · ${formatBytes(input.fileBytes)}${
            input.count === null ? "" : ` · ${input.count} ${records ? "record(s)" : "event(s)"}`
          }`,
    ),
  ];

  return page({
    state: input.jobError === null ? "info" : "danger",
    title: records ? "the export" : "the timeline",
    sections,
    controls: [
      actionRow([button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY })]),
      actionRow([
        button({ id: input.backId, label: "back to the record", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** how many entries the page shows before it says how many more there are. */
export const BLACKLIST_LIST_SIZE = 25;

export interface BlacklistPageInput {
  readonly guildId: string;
  readonly entries: readonly GuildBlacklistRow[];
  /** what just happened, in the operator's words. */
  readonly note: string | null;
  readonly refreshId: string;
  /** the same button, pointed at the attempts instead of the entries. */
  readonly openAttemptsId: string;
}

/**
 * the blacklist of this server. the first line says what an entry is, because
 * a page that only listed ids would read like a ban list (D4PLAN 19.4).
 */
export function blacklistPage(input: BlacklistPageInput): ContainerComponent {
  const shown = input.entries.slice(0, BLACKLIST_LIST_SIZE);
  const sections = [
    textDisplay(
      "**an entry is a signal for you, not a ban.** nothing is blocked on a match: no join is refused over a user id, an address hash or an asn. shared networks, student halls and mobile carriers all produce false matches, so the list is yours to read, not the bot's to act on.",
    ),
    ...(input.note === null ? [] : [textDisplay(input.note)]),
    ...(input.entries.length === 0
      ? [
          textDisplay(
            "the list is empty. add one with `/users blacklist action:add kind:user_id value:123456789012345678`.",
          ),
        ]
      : shown.map((entry) =>
          textDisplay(
            `**${entry.kind}** \`${entry.value}\` · added ${relativeTimestamp(
              Date.parse(entry.added_at),
            )}${entry.added_by === null ? "" : ` by <@${entry.added_by}>`}${
              entry.reason === null ? "" : ` · ${entry.reason}`
            }`,
          ),
        )),
  ];
  if (input.entries.length > shown.length) {
    sections.push(
      textDisplay(
        `-# and ${input.entries.length - shown.length} more that this page does not show.`,
      ),
    );
  }

  return page({
    state: "info",
    title: "the blacklist of this server",
    sections,
    controls: [
      actionRow([button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY })]),
      actionRow([
        button({ id: input.openAttemptsId, label: "the attempts", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** how many attempts the page shows before it says how many more there are. */
export const ATTEMPT_LIST_SIZE = 5;

/** how much of a fingerprint the page shows. the dm and the log channel hold it all. */
const FINGERPRINT_PAGE_CAP = 400;

export interface AttemptsPageInput {
  readonly guildId: string;
  /** the newest attempts of this server. */
  readonly attempts: readonly BlacklistAttemptRow[];
  /** every attempt this server holds, which is more than one page shows. */
  readonly total: number;
  readonly backId: string;
  readonly refreshId: string;
}

/**
 * what a match kept. each attempt is the snapshot the verification gathered, so
 * the operator can read it long after the alert scrolled away.
 */
export function attemptsPage(input: AttemptsPageInput): ContainerComponent {
  const shown = input.attempts.slice(0, ATTEMPT_LIST_SIZE);
  const sections = [
    textDisplay(
      "**an attempt is a snapshot, not a conviction.** a match keeps what was gathered at the time. nothing was refused over it: shared networks, student halls and mobile carriers all produce false matches (D4PLAN 19.4).",
    ),
    textDisplay(
      input.total === 0
        ? "no verification has matched the list yet."
        : `**${input.total} attempt(s)** recorded. newest first.`,
    ),
    ...shown.flatMap((row) => [
      textDisplay(
        `**<@${row.user_id}>** · ${row.username ?? "unknown"}${
          row.global_name === null ? "" : ` · ${row.global_name}`
        } · ${relativeTimestamp(Date.parse(row.at))}`,
      ),
      textDisplay(
        [
          `matched: ${describeMatches(row)}`,
          ...describeAttempt(row).map((line) =>
            line.startsWith("fingerprint: ")
              ? `fingerprint: ${fingerprintPreview(row, FINGERPRINT_PAGE_CAP)}`
              : line,
          ),
        ].join("\n"),
      ),
    ]),
  ];
  if (input.total > shown.length) {
    sections.push(
      textDisplay(`-# and ${input.total - shown.length} older attempt(s) this page does not show.`),
    );
  }

  return page({
    state: input.total === 0 ? "info" : "warning",
    title: "the attempts that hit the blacklist",
    sections,
    controls: [
      actionRow([button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY })]),
      actionRow([
        button({ id: input.backId, label: "back to the list", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}
