// the policy (D4PLAN 14.4). what happens to a verification, given the network
// it came from and the accounts this server already holds.
//
// two rules, both off until the owner turns them on:
//   - the network rule: a hosting, vpn or tor network is refused
//   - the anti-alt rule: a verification that looks like another account here
//     is refused, and a less certain one is flagged
//
// the refusal is about the network and the match, never about the account it
// matched: the page does not tell one member about another.

import type { GuildSettings } from "../../config/defaults.ts";
import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import type { IntelResult, IntelService } from "../intel/index.ts";
import { type AltMatch, type AltSignals, findAltMatches } from "./alt.ts";

/** why a verification was refused. */
export type RefusalReason = "vpn" | "alt";

export interface GuardInput {
  readonly guildId: string;
  readonly userId: string;
  /** the address, for the intel. null when the capture found none. */
  readonly address: string | null;
  readonly signals: AltSignals;
}

export interface GuardDecision {
  readonly allowed: boolean;
  readonly reason: RefusalReason | null;
  /** what the files say about the network. */
  readonly intel: IntelResult | null;
  /** the account this verification looks like, when there is one. */
  readonly alt: AltMatch | null;
  /** the signals are kept when the owner asked for the anti-alt check. */
  readonly keepSignals: boolean;
  /** the line the operator reads on the record. */
  readonly evidence: string;
}

export interface GuardDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly intel: IntelService;
  readonly settings: (guildId: string) => Promise<GuildSettings>;
}

/** the network looks like a vpn, a hosting provider or a tor exit. */
function looksBlocked(intel: IntelResult): boolean {
  return intel.isHosting || intel.isVpn || intel.isTor;
}

/**
 * the decision.
 *
 * the settings are read per call, so a policy the owner changed a minute ago
 * is the policy that runs now (AGENTS.md rule 8).
 */
export async function decideVerification(
  deps: GuardDeps,
  input: GuardInput,
): Promise<GuardDecision> {
  const settings = await deps.settings(input.guildId);
  const intel = input.address === null ? null : await deps.intel.lookup(input.address);

  // the anti-alt check only runs when the owner asked for it. an owner who
  // left it off gets no lookup and no signal rows.
  const keepSignals = settings.verify_alt_policy !== "off";
  const alt =
    keepSignals && input.guildId !== ""
      ? ((
          await findAltMatches(
            { db: deps.db, guildId: input.guildId, userId: input.userId },
            input.signals,
          )
        )[0] ?? null)
      : null;

  if (settings.verify_vpn_policy === "block" && intel !== null && looksBlocked(intel)) {
    deps.log.warn("the verification was refused by the network rule", {
      guild_id: input.guildId,
      user_id: input.userId,
      asn: intel.asn,
      ip_type: intel.ipType,
      is_vpn: intel.isVpn,
      is_tor: intel.isTor,
    });
    return {
      allowed: false,
      reason: "vpn",
      intel,
      alt,
      keepSignals,
      evidence: intel.evidence,
    };
  }

  if (settings.verify_alt_policy === "block" && alt !== null && alt.label === "high") {
    deps.log.warn("the verification was refused by the anti-alt rule", {
      guild_id: input.guildId,
      user_id: input.userId,
      matched_user_id: alt.userId,
      confidence: alt.confidence,
      signals: alt.signals.join(","),
    });
    return {
      allowed: false,
      reason: "alt",
      intel,
      alt,
      keepSignals,
      evidence: `the same ${alt.signals.join(" and ")} as another account in this server`,
    };
  }

  return {
    allowed: true,
    reason: null,
    intel,
    alt,
    keepSignals,
    evidence:
      alt === null
        ? (intel?.evidence ?? "the intel files say nothing about this address")
        : `the same ${alt.signals.join(" and ")} as another account in this server`,
  };
}
