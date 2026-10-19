// the /users pages.
//
// a field that was never captured says so, rather than showing a blank that
// reads like "nothing there". the address appears in the form the storage mode
// produced, and the mode is named next to it, so a reader can tell a hash from
// an address (D4PLAN 17.3).

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import type { IpStorage } from "../../../config/parse-env.ts";
import type { VerifyRecordRow } from "../../../db/types.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { actionRow, button, stringSelect } from "../../components/row.ts";
import { formatBytes, relativeTimestamp } from "../types.ts";
import { type CounterView, IP_MODE_NOTE, type MembershipView, storedIp } from "./deps.ts";

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
  /** the export job, when there is one. */
  readonly jobId: string | null;
  readonly jobStatus: string | null;
  readonly jobError: string | null;
  /** the record count the job will write. */
  readonly recordCount: number | null;
  readonly filePath: string | null;
  readonly fileBytes: number | null;
  readonly ipStorage: IpStorage;
  readonly backId: string;
  readonly refreshId: string;
}

/** the export. what it holds, what it leaves out, and where the file is. */
export function exportPage(input: ExportPageInput): ContainerComponent {
  const sections = [
    textDisplay(
      input.jobId === null
        ? "no export has run in this server yet."
        : `job \`${input.jobId.slice(0, 8)}\` · ${input.jobStatus ?? "queued"}`,
    ),
    textDisplay(
      input.jobError === null
        ? "the file holds every field of every record, with the tokens left out entirely."
        : `**${input.jobError}**`,
    ),
    textDisplay(
      `the address is written in the \`${input.ipStorage}\` form, and the header names it.`,
    ),
    textDisplay(
      input.filePath === null
        ? "the file is not written yet."
        : `file: \`${input.filePath}\` · ${formatBytes(input.fileBytes)}${
            input.recordCount === null ? "" : ` · ${input.recordCount} record(s)`
          }`,
    ),
  ];

  return page({
    state: input.jobError === null ? "info" : "danger",
    title: "the export",
    sections,
    controls: [
      actionRow([button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY })]),
      actionRow([
        button({ id: input.backId, label: "back to the record", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}
