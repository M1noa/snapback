// services/verify/attempts.ts. what happens when a verification matches a
// blacklist entry (D4PLAN 19.5).
//
// the match is a signal, so nothing here refuses anything: by the time this runs
// the verification has already been decided by the guard. all this does is keep
// the snapshot and tell the operator. the row is what they read later, so it
// holds every field that was gathered, the fingerprint included.
//
// the address itself never lands in the row or in an alert. what the row keeps is
// the hash the storage mode produced, and only in hash mode: the encrypted mode
// writes a fresh ciphertext on every run, so a ciphertext could never match an
// entry anyway.

import { insertBlacklistAttempt } from "../../db/queries/blacklist-attempts.ts";
import type { BlacklistAttemptRow, Database, JsonObject } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import { v2Message } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";
import type { CapturedIp } from "../../web/capture/ip.ts";
import type { IntelResult } from "../intel/index.ts";
import type { AltSignals } from "./alt.ts";
import { type BlacklistMatch, checkAccount } from "./blacklist.ts";

/** how long an alert may take before it is given up on. */
const ALERT_TIMEOUT_MS = 5_000;

/** how much of the fingerprint an alert shows. the row keeps all of it. */
const FINGERPRINT_PREVIEW = 600;

/** the fields the callback gathered, as the record wrapper holds them. */
export interface AttemptSubject {
  readonly guildId: string;
  readonly userId: string;
  readonly username: string | null;
  readonly globalName: string | null;
  readonly ip: CapturedIp;
  readonly fingerprint: unknown;
  readonly device: string | null;
  readonly signals: AltSignals | null;
  readonly intel: IntelResult | null;
  /** what the guard decided. kept with the match, because a match that was
   *  refused for another reason still explains a lot. */
  readonly status: string;
  readonly refusalReason: string | null;
}

export interface AttemptDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly now: () => number;
  /** the bot owner's id. the alert is addressed to them (D4PLAN 19.5). */
  readonly ownerId: string;
  /** the guild's log channel, or null when it has none set. */
  readonly logChannel: (guildId: string) => Promise<string | null>;
  /** the guild's display name, or null when it cannot be read. */
  readonly guildName: (guildId: string) => Promise<string | null>;
  /** every alert goes through the one client (AGENTS.md rule 6). */
  readonly client: Pick<DiscordClient, "request">;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** what the list can match this verification on. an address only counts when the
 *  storage mode repeats it, which is hash mode alone. */
function accountSignal(subject: AttemptSubject): {
  userId: string;
  ipHashes: readonly string[];
  asn: string | null;
} {
  const hash = subject.ip.mode === "hash" ? subject.ip.stored : null;
  return {
    userId: subject.userId,
    ipHashes: hash === null ? [] : [hash],
    asn: subject.intel?.asn ?? null,
  };
}

/** one match as the row keeps it. the entry's own words, so the operator can
 *  tell which line of the list it hit. */
function matchJson(match: BlacklistMatch): JsonObject {
  return {
    kind: match.kind,
    value: match.value,
    addedAt: match.addedAt,
    addedBy: match.addedBy,
  };
}

function attemptRow(
  subject: AttemptSubject,
  matches: readonly BlacklistMatch[],
  at: Date,
): BlacklistAttemptRow {
  const intel = subject.intel;
  const row: BlacklistAttemptRow = {
    // the app writes its own keys; no helper module and no dependency.
    attempt_id: Bun.randomUUIDv7(),
    guild_id: subject.guildId,
    user_id: subject.userId,
    username: subject.username,
    global_name: subject.globalName,
    status: subject.status,
    refusal_reason: subject.refusalReason,
    ip_mode: subject.ip.mode,
    ip_hash: subject.ip.mode === "hash" ? subject.ip.stored : null,
    asn: intel?.asn ?? null,
    as_org: intel?.asOrg ?? null,
    isp: intel?.isp ?? null,
    country_code: intel?.countryCode ?? null,
    country_name: intel?.countryName ?? null,
    ip_type: intel?.ipType ?? null,
    is_vpn: intel?.isVpn ?? null,
    is_proxy: intel?.isProxy ?? null,
    is_tor: intel?.isTor ?? null,
    is_hosting: intel?.isHosting ?? null,
    matches_json: matches.map(matchJson),
    signals_json: subject.signals === null ? null : { ...subject.signals },
    fingerprint_json: isJsonObject(subject.fingerprint) ? subject.fingerprint : null,
    device: subject.device,
    at: at.toISOString(),
    recorded_at: at.toISOString(),
  };
  return row;
}

/** the lines every alert and every page reads, so the two never disagree. */
export function describeAttempt(row: BlacklistAttemptRow): string[] {
  const network = [
    row.country_name === null ? null : `${row.country_name} (${row.country_code ?? "??"})`,
    row.isp,
    row.asn === null ? null : `as${row.asn}${row.as_org === null ? "" : ` ${row.as_org}`}`,
    row.ip_type,
  ].filter((part): part is string => part !== null && part !== "");

  const flags = [
    row.is_vpn === true ? "vpn" : null,
    row.is_proxy === true ? "proxy" : null,
    row.is_tor === true ? "tor" : null,
    row.is_hosting === true ? "hosting" : null,
  ].filter((part): part is string => part !== null);

  return [
    `network: ${network.length === 0 ? "no intel was run" : network.join(" · ")}${
      flags.length === 0 ? "" : ` · flagged ${flags.join(", ")}`
    }`,
    `address: ${
      row.ip_hash === null ? `not kept as a hash (the storage mode is ${row.ip_mode})` : row.ip_hash
    }`,
    `device: ${row.device ?? "not captured"}`,
    `fingerprint: ${row.fingerprint_json === null ? "not captured" : JSON.stringify(row.fingerprint_json)}`,
    `outcome: ${row.status}${row.refusal_reason === null ? "" : ` (${row.refusal_reason})`}`,
  ];
}

/** the line that says what the list matched, in the entry's own words. */
export function describeMatches(row: BlacklistAttemptRow): string {
  const matches = row.matches_json ?? [];
  if (matches.length === 0) return "no entry was recorded";
  return matches
    .map((match) => {
      const kind = typeof match.kind === "string" ? match.kind : "entry";
      const value = typeof match.value === "string" ? match.value : "";
      return `**${kind}** \`${value}\``;
    })
    .join(" · ");
}

/** the fingerprint as one line, cut to the caller's cap. the row keeps all of it. */
export function fingerprintPreview(row: BlacklistAttemptRow, cap: number): string {
  if (row.fingerprint_json === null) return "not captured";
  const full = JSON.stringify(row.fingerprint_json);
  return full.length <= cap ? full : `${full.slice(0, cap)}…`;
}

/** the alert's body. one tree, so the dm and the log channel read the same. */
function alertPage(row: BlacklistAttemptRow, guildName: string | null) {
  const preview = fingerprintPreview(row, FINGERPRINT_PREVIEW);
  const lines = describeAttempt(row).filter((line) => !line.startsWith("fingerprint: "));

  return page({
    state: "warning",
    title: "a verification matched the blacklist",
    sections: [
      textDisplay(
        [
          `**<@${row.user_id}>** · ${row.username ?? "unknown"}${
            row.global_name === null ? "" : ` · ${row.global_name}`
          }`,
          `${guildName === null ? `server \`${row.guild_id}\`` : guildName} · ${relative(row.at)}`,
        ].join("\n"),
      ),
      textDisplay(`matched: ${describeMatches(row)}`),
      textDisplay(lines.join("\n")),
      textDisplay(`fingerprint: \`\`\`json\n${preview}\n\`\`\``),
      textDisplay(
        "-# this is a signal, not a ban. nothing was refused over this match: shared networks, student halls and mobile carriers all produce false ones.",
      ),
    ],
  });
}

function relative(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** a per-guild read that must not take the alert down with it. */
async function safe(
  deps: AttemptDeps,
  read: () => Promise<string | null>,
  what: string,
): Promise<string | null> {
  try {
    return await read();
  } catch (error) {
    deps.log.warn(`${what} could not be read`, { message: messageOf(error) });
    return null;
  }
}

/** post the alert. a failure here never affects the verification that produced
 *  it, so each destination is tried on its own and reported, never thrown. */
async function notify(deps: AttemptDeps, row: BlacklistAttemptRow): Promise<void> {
  const guildName = await safe(deps, () => deps.guildName(row.guild_id), "the guild name");
  const tree = v2Message(alertPage(row, guildName));
  const body = { ...tree, allowed_mentions: { parse: [] } };

  try {
    // the dm channel to the owner. discord hands back the existing one when it
    // exists, so this is not a new channel on every attempt.
    const dm = await deps.client.request<{ id: string }>({
      method: "POST",
      route: "/users/@me/channels",
      body: { recipient_id: deps.ownerId },
      timeoutMs: ALERT_TIMEOUT_MS,
    });
    await deps.client.request({
      method: "POST",
      route: `/channels/${dm.id}/messages`,
      body,
      timeoutMs: ALERT_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof DiscordApiError) {
      deps.log.warn("the blacklist alert could not reach the owner", {
        status: error.status,
        code: error.code,
        message: error.message,
        route: error.route,
        method: error.method,
      });
    } else {
      deps.log.warn("the blacklist alert could not reach the owner", {
        message: messageOf(error),
      });
    }
  }

  const channelId = await safe(deps, () => deps.logChannel(row.guild_id), "the log channel");
  if (channelId === null) return;

  try {
    await deps.client.request({
      method: "POST",
      route: `/channels/${channelId}/messages`,
      body,
      timeoutMs: ALERT_TIMEOUT_MS,
    });
  } catch (error) {
    deps.log.warn("the blacklist alert could not reach the log channel", {
      guild: row.guild_id,
      channel: channelId,
      message:
        error instanceof DiscordApiError
          ? `${error.code ?? ""} ${error.message}`.trim()
          : messageOf(error),
    });
  }
}

/**
 * check one verification against the list, and on a match keep the snapshot and
 * tell the operator. returns the attempt when there was a match, so the caller
 * can say so on its page, and null the rest of the time.
 *
 * the caller is responsible for having already decided the verification: this
 * never returns a decision and never throws on a match (D4PLAN 19.4).
 */
export async function matchBlacklist(
  deps: AttemptDeps,
  subject: AttemptSubject,
): Promise<BlacklistAttemptRow | null> {
  const check = await checkAccount(
    { db: deps.db, now: deps.now },
    subject.guildId,
    accountSignal(subject),
  );
  if (!check.matched) return null;

  const row = attemptRow(subject, check.matches, new Date(deps.now()));
  await insertBlacklistAttempt(deps.db, row);
  deps.log.info("a verification matched the blacklist", {
    guild: row.guild_id,
    user: row.user_id,
    matches: row.matches_json?.length ?? 0,
  });

  // the row is the record; the alerts are best effort and never fail the caller.
  await notify(deps, row);
  return row;
}
