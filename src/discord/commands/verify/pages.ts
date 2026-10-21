// the /verify pages.
//
// the scope checkboxes carry the consequence line from D4PLAN 7.2 verbatim, one
// per scope, so a person reads what a scope costs before they tick it.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import type { VerifyRecordRow } from "../../../db/types.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import {
  actionRow,
  button,
  channelSelect,
  checkboxGroup,
  stringSelect,
} from "../../components/row.ts";
import { relativeTimestamp } from "../types.ts";
import { VERIFY_ACTION, VERIFY_OBJECT, verifyCustomId } from "./deps.ts";

/** the scopes and what each one asks for (D4PLAN 7.2). */
export const SCOPES: readonly { key: string; consequence: string }[] = [
  { key: "identify", consequence: "basic profile: id, username, avatar" },
  { key: "email", consequence: "email address and whether it is verified" },
  {
    key: "connections",
    consequence: "linked accounts: Steam, Twitch, GitHub, Spotify and similar",
  },
  { key: "guilds", consequence: "the list of servers they are in (names and ids, not contents)" },
  { key: "guilds.join", consequence: "allows the bot to add them to a server you own" },
  {
    key: "guilds.members.read",
    consequence: "their nickname and roles inside a server you own",
  },
  {
    key: "role_connections.write",
    consequence: "required if you use Discord's linked-roles feature",
  },
  { key: "webhook.incoming", consequence: "creates a webhook in a channel they pick" },
  {
    key: "relationships.read",
    consequence:
      "their friends list, pending friend requests, and blocked users. restricted scope, requires Discord approval, and you must disclose and handle it under Discord's Social SDK terms.",
  },
  { key: "gdm.join", consequence: "join a group DM" },
];

/** the scopes a panel may ask for without the restricted acknowledgement. */
export const DEFAULT_SCOPES: readonly string[] = ["identify", "email", "guilds.join"];

export interface PanelPageInput {
  readonly guildId: string;
  readonly channelId: string | null;
  readonly title: string;
  readonly description: string;
  readonly scopes: readonly string[];
  readonly buttonLabel: string;
  /** true when the restricted scope is asked for without the acknowledgement. */
  readonly restrictedWithoutAcknowledgement: boolean;
  readonly channelSelectId: string;
  readonly submitId: string;
  readonly scopeGroupId: string;
  readonly detailsId: string;
  readonly backId: string;
}

/** the panel builder. a channel, the copy, the scopes, and a button. */
export function panelPage(input: PanelPageInput): ContainerComponent {
  const sections = [
    textDisplay(
      [
        "**what the verification asks for.** untick a scope and the panel stops asking for it.",
        input.restrictedWithoutAcknowledgement
          ? "**the friends list scope needs an acknowledgement.** it is a restricted scope, and the panel will not ask for it until the wizard has recorded that you accept discord's Social SDK terms."
          : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    ),
    textDisplay(
      `**title:** ${input.title || "(not set)"} · **button:** ${input.buttonLabel || "Verify"}`,
    ),
    textDisplay(
      input.description === ""
        ? "**the copy is empty.** the panel says what it is for."
        : input.description,
    ),
    checkboxGroup({
      id: input.scopeGroupId,
      options: SCOPES.map((scope) => ({
        label: scope.key,
        value: scope.key,
        description: scope.consequence,
        default: input.scopes.includes(scope.key),
      })),
    }) as unknown as ContainerComponent["components"][number],
  ];

  return page({
    state: input.restrictedWithoutAcknowledgement ? "warning" : "info",
    title: "the verification panel",
    sections,
    controls: [
      actionRow([
        channelSelect({
          id: input.channelSelectId,
          placeholder: "the channel the panel goes in",
        }),
      ]),
      actionRow([
        button({
          id: input.detailsId,
          label: "the copy and the look",
          style: ButtonStyles.SECONDARY,
        }),
        button({ id: input.submitId, label: "post the panel", style: ButtonStyles.PRIMARY }),
        button({ id: input.backId, label: "cancel", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

export interface RecordsPageInput {
  readonly guildId: string;
  readonly rows: readonly VerifyRecordSummary[];
  readonly page: number;
  readonly pages: number;
  readonly selectId: string;
  readonly prevId: string;
  readonly nextId: string;
  readonly refreshId: string;
  readonly deleteId: string;
}

export interface VerifyRecordSummary {
  readonly userId: string;
  readonly username: string;
  readonly scopes: readonly string[];
  readonly lastChecked: string | null;
  readonly tokenStatus: string;
}

/** the records this server holds. ten per page, one select to open one. */
export function recordsPage(input: RecordsPageInput): ContainerComponent {
  const sections = [
    textDisplay(
      `**${input.rows.length} record(s)** on this page, page ${input.page} of ${input.pages}.`,
    ),
    ...(input.rows.length === 0
      ? [textDisplay("nobody has verified here yet. post a panel and someone will.")]
      : input.rows.map((row) =>
          textDisplay(
            `**<@${row.userId}>** (${row.username}) · ${row.scopes.join(", ") || "no scopes"} · ${
              row.tokenStatus
            }${
              row.lastChecked === null
                ? ""
                : ` · checked ${relativeTimestamp(Date.parse(row.lastChecked))}`
            }`,
          ),
        )),
  ];

  const controls = [] as ReturnType<typeof actionRow>[];
  if (input.rows.length > 0) {
    controls.push(
      actionRow([
        stringSelect({
          id: input.selectId,
          placeholder: "open a record",
          options: input.rows.map((row) => ({
            label: `${row.username} ${row.userId}`.slice(0, 100),
            value: row.userId,
          })),
        }),
      ]),
    );
  }
  controls.push(
    actionRow([
      button({ id: input.prevId, label: "previous", style: ButtonStyles.SECONDARY }),
      button({ id: input.nextId, label: "next", style: ButtonStyles.SECONDARY }),
      button({ id: input.refreshId, label: "refresh the tokens", style: ButtonStyles.SECONDARY }),
      button({ id: input.deleteId, label: "delete a record", style: ButtonStyles.DANGER }),
    ]),
  );

  return page({
    state: input.rows.length === 0 ? "warning" : "info",
    title: `the records (page ${input.page} of ${input.pages})`,
    sections,
    controls,
  });
}

export interface RecordPageInput {
  readonly guildId: string;
  readonly record: RecordFields;
  readonly revokeId: string;
  readonly deleteId: string;
  readonly backId: string;
}

export interface RecordFields {
  readonly userId: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly scopes: readonly string[];
  readonly countryName: string | null;
  readonly isp: string | null;
  readonly asOrg: string | null;
  readonly ipType: string | null;
  readonly asn: string | null;
  readonly isVpn: boolean | null;
  readonly isTor: boolean | null;
  /** how the last verification ended, and why it was refused. */
  readonly verifyStatus: string;
  readonly refusalReason: string | null;
  /** the account this one looks like, with the confidence. */
  readonly altMatch: {
    readonly userId: string;
    readonly confidence: number;
    readonly label: string;
    readonly signals: readonly string[];
  } | null;
  /** what each verification said about the network at the time. */
  readonly history: readonly {
    readonly at: string;
    readonly status: string;
    readonly reason: string | null;
    readonly ipType: string | null;
    readonly asOrg: string | null;
    readonly isVpn: boolean | null;
    readonly isTor: boolean | null;
  }[];
  readonly guilds: readonly string[];
  readonly connections: readonly string[];
  readonly relationshipsCaptured: boolean;
  readonly fingerprint: string | null;
  readonly tokenStatus: string;
  readonly lastChecked: string | null;
  readonly events: readonly {
    readonly at: string;
    readonly kind: string;
    readonly detail: string;
  }[];
}

/** why a verification was refused, in the operator's words. */
export function refusalReasonText(reason: string | null): string {
  if (reason === "vpn") return "the network looks like a vpn or a hosting provider";
  if (reason === "alt") return "it looks like another account in this server";
  return reason ?? "not refused";
}

/** one record in full. a field that was not captured says so, rather than
 *  showing an empty space that reads like "nothing there". */
export function recordPage(input: RecordPageInput): ContainerComponent {
  const record = input.record;
  const or = (value: string | null, when: string): string =>
    value === null || value === "" ? `not captured (${when})` : value;

  const sections = [
    textDisplay(
      [
        `**<@${record.userId}>** · ${record.username}${
          record.globalName === null ? "" : ` · ${record.globalName}`
        }`,
        `scopes: ${record.scopes.join(", ") || "none"} · token: ${record.tokenStatus}`,
        `verification: ${record.verifyStatus}${
          record.refusalReason === null ? "" : ` · ${refusalReasonText(record.refusalReason)}`
        }`,
      ].join("\n"),
    ),
    textDisplay(
      [
        `email: ${or(record.email, "the email scope was not granted")}${
          record.emailVerified === null
            ? ""
            : record.emailVerified
              ? " (verified)"
              : " (not verified)"
        }`,
        `country: ${or(record.countryName, "no intel was run")} · network: ${or(
          record.isp,
          "no intel was run",
        )}`,
        `as org: ${or(record.asOrg, "no intel was run")} · type: ${or(
          record.ipType,
          "no intel was run",
        )}`,
        `asn: ${or(record.asn, "no intel was run")} · vpn: ${
          record.isVpn === null ? "not looked up" : record.isVpn ? "likely" : "no"
        } · tor: ${record.isTor === null ? "not looked up" : record.isTor ? "yes" : "no"}`,
      ].join("\n"),
    ),
    textDisplay(
      `servers: ${
        record.guilds.length === 0
          ? "not captured (the guilds scope was not granted)"
          : record.guilds.join(", ")
      }`,
    ),
    textDisplay(
      `linked accounts: ${
        record.connections.length === 0
          ? "not captured (the connections scope was not granted)"
          : record.connections.join(", ")
      }`,
    ),
    textDisplay(
      record.relationshipsCaptured
        ? "friends list: captured"
        : "friends list: not captured (discord gates that scope behind the Social SDK)",
    ),
    textDisplay(`fingerprint: ${or(record.fingerprint, "the browser sent nothing")}`),
    ...(record.altMatch === null
      ? []
      : [
          textDisplay(
            `possible alt of <@${record.altMatch.userId}> · confidence ${record.altMatch.confidence} (${record.altMatch.label}) · the same ${record.altMatch.signals.join(" and ")}`,
          ),
        ]),
    ...(record.history.length === 0
      ? []
      : [
          textDisplay(
            [
              "**verifications**",
              ...record.history.map(
                (entry) =>
                  `-# ${relativeTimestamp(Date.parse(entry.at))} · ${entry.status}${
                    entry.reason === null ? "" : ` (${refusalReasonText(entry.reason)})`
                  } · ${entry.ipType ?? "unknown"}${
                    entry.asOrg === null ? "" : ` · ${entry.asOrg}`
                  }${entry.isVpn === true ? " · likely a vpn" : ""}${
                    entry.isTor === true ? " · tor" : ""
                  }`,
              ),
            ].join("\n"),
          ),
        ]),
    ...(record.events.length === 0
      ? [textDisplay("no events yet.")]
      : record.events.map((event) =>
          textDisplay(
            `${relativeTimestamp(Date.parse(event.at))} · ${event.kind} · ${event.detail}`,
          ),
        )),
  ];

  return page({
    state: "info",
    title: `the record for ${record.username}`,
    sections,
    controls: [
      actionRow([
        button({ id: input.revokeId, label: "revoke their access", style: ButtonStyles.SECONDARY }),
        button({ id: input.deleteId, label: "delete", style: ButtonStyles.DANGER }),
        button({ id: input.backId, label: "back", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** the delete page. the scope of what goes, and a typed confirmation. */
export function deletePage(input: {
  readonly guildId: string;
  readonly userId: string;
  readonly username: string;
  readonly scopes: readonly { key: string; what: string }[];
  readonly submitId: string;
  readonly backId: string;
}): ContainerComponent {
  return page({
    state: "danger",
    title: "delete a record",
    sections: [
      textDisplay(`**${input.username}** (<@${input.userId}>). choose how much of it goes.`),
      textDisplay(
        "a record is the only thing that erases captured data, and the only path that does it is this one.",
      ),
      checkboxGroup({
        id: input.submitId,
        options: input.scopes.map((scope) => ({
          label: scope.key,
          value: scope.key,
          description: scope.what,
          default: scope.key === "record",
        })),
      }) as unknown as ContainerComponent["components"][number],
    ],
    controls: [
      actionRow([
        button({ id: input.submitId, label: "delete it", style: ButtonStyles.DANGER }),
        button({ id: input.backId, label: "cancel", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/**
 * the page the panel's button answers with: a link to discord's consent screen.
 * the state was minted when the url was built, so the consent screen comes back
 * to the callback with a state that is still valid.
 */
export function startPage(input: { guildId: string; url: string }): ContainerComponent {
  return page({
    state: "info",
    title: "verify yourself",
    sections: [
      textDisplay(
        "this server uses snapback to verify you. discord will ask what it may share, and nothing is captured before you approve it.",
      ),
    ],
    controls: [
      actionRow([
        button({
          url: input.url,
          label: "continue to discord",
          style: ButtonStyles.LINK,
        }),
      ]),
    ],
  });
}

/** the job's page. a refresh runs as a job, because a sweep outlives an
 *  interaction. */
export function jobPage(input: {
  readonly guildId: string;
  readonly lines: readonly string[];
  readonly state: "info" | "success" | "warning" | "danger";
  readonly refreshId: string;
}): ContainerComponent {
  return page({
    state: input.state,
    title: "the refresh",
    sections: input.lines.map((line) => textDisplay(line)),
    controls: [
      actionRow([button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY })]),
    ],
  });
}

export { VERIFY_ACTION, VERIFY_OBJECT, verifyCustomId };

/** the token statuses a record can be in, in the order the page shows them. */
const TOKEN_STATUSES = ["valid", "unauthorized", "revoked", "refused", "missing"] as const;

export interface VerifyStats {
  readonly records: number;
  /** true when the list was cut short, so the count is a floor and not a total. */
  readonly truncated: boolean;
  readonly byTokenStatus: readonly { status: string; count: number }[];
  readonly byCountry: readonly { country: string; count: number }[];
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

/**
 * the counts for one server. numbers about what the server holds, and nothing
 * about any one person: no name, no id, no address.
 */
export function verifyStats(rows: readonly VerifyRecordRow[], truncated = false): VerifyStats {
  const statuses = new Map<string, number>();
  const countries = new Map<string, number>();
  let first: string | null = null;
  let last: string | null = null;

  for (const row of rows) {
    statuses.set(row.token_status, (statuses.get(row.token_status) ?? 0) + 1);
    const country = row.country_name ?? row.country_code;
    if (country !== null && country !== "") {
      countries.set(country, (countries.get(country) ?? 0) + 1);
    }
    const at = row.created_at;
    if (at === "") continue;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
  }

  const byCountry = [...countries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([country, count]) => ({ country, count }));

  return {
    records: rows.length,
    truncated,
    byTokenStatus: TOKEN_STATUSES.map((status) => ({
      status,
      count: statuses.get(status) ?? 0,
    })),
    byCountry,
    firstAt: first,
    lastAt: last,
  };
}

/** the numbers of this server. what an operator can act on. */
export function statsPage(input: {
  readonly guildId: string;
  readonly stats: VerifyStats;
  readonly backId: string;
}): ContainerComponent {
  const stats = input.stats;
  const tokens = stats.byTokenStatus.map((row) => `${row.count} ${row.status}`).join(" · ");
  const countries =
    stats.byCountry.length === 0
      ? "countries: none captured."
      : `countries: ${stats.byCountry.map((row) => `${row.country} ${row.count}`).join(" · ")}`;

  const sections = [
    textDisplay(
      `**${stats.records} record(s)** in this server${stats.truncated ? ", at least" : ""}.`,
    ),
    textDisplay(`tokens: ${tokens}`),
    textDisplay(countries),
    textDisplay(
      stats.firstAt === null
        ? "dates: no record yet."
        : `first record ${relativeTimestamp(Date.parse(stats.firstAt))} · last ${
            stats.lastAt === null ? "unknown" : relativeTimestamp(Date.parse(stats.lastAt))
          }`,
    ),
    textDisplay(
      "these are counts of what this server holds. they say nothing about any one person.",
    ),
  ];

  return page({
    state: "info",
    title: "the numbers of this server",
    sections,
    controls: [
      actionRow([
        button({ id: input.backId, label: "back to the records", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}
