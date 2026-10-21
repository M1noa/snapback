// the anti-alt matcher (D4PLAN 14.4). a verification is compared against the
// accounts already in this server: the device, the address, the email, the
// avatar and the name. what comes out is a score and the signals behind it.
//
// the score is a rating, not a proof. two people behind one campus gateway
// look like one address, and two accounts on one cheap windows box look like
// one device. the page shows the signals, so the operator reads them rather
// than trusts a number.
//
// the address only counts when it is stored in a shape that repeats: the hash
// is the same every time, the plaintext address is too, and the encrypted one
// is not, because every encryption uses a fresh iv.

import { createHash } from "node:crypto";
import { findSignalMatches } from "../../db/queries/verify-signals.ts";
import type { Database, VerifySignalKind } from "../../db/types.ts";

/** what one verification can be recognised by. */
export interface AltSignals {
  /** the digest of the device. */
  readonly device: string | null;
  /** the stored address, when the storage mode repeats it. */
  readonly ip: string | null;
  /** the digest of the email. */
  readonly email: string | null;
  /** the discord avatar hash. */
  readonly avatar: string | null;
  /** the lowercased username. */
  readonly name: string | null;
}

export type AltConfidence = "high" | "medium" | "low";

/** how much each signal says that two accounts are the same person. */
export const ALT_WEIGHTS: Readonly<Record<VerifySignalKind, number>> = Object.freeze({
  device: 70,
  ip: 45,
  email: 35,
  avatar: 25,
  name: 10,
});

/** the score at which a match is high, medium or low. */
export const ALT_HIGH = 70;
export const ALT_MEDIUM = 40;
export const ALT_LOW = 15;

/** the signals that are looked at, in the order they are worth. */
const KINDS: readonly VerifySignalKind[] = ["device", "ip", "email", "avatar", "name"];

export interface AltMatch {
  /** the account the verification looks like. */
  readonly userId: string;
  /** the score, out of a hundred. */
  readonly confidence: number;
  readonly label: AltConfidence;
  /** the signals that matched. */
  readonly signals: readonly VerifySignalKind[];
}

/** the score for a set of matched signals. */
export function scoreAlt(signals: readonly VerifySignalKind[]): {
  confidence: number;
  label: AltConfidence;
} {
  let score = 0;
  for (const signal of signals) score += ALT_WEIGHTS[signal];
  const confidence = Math.min(100, score);
  const label: AltConfidence =
    confidence >= ALT_HIGH ? "high" : confidence >= ALT_MEDIUM ? "medium" : "low";
  return { confidence, label };
}

/** the digest of the email, so the address itself is not a second copy. */
export function emailDigest(email: string | null): string | null {
  if (email === null) return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed === "") return null;
  return createHash("sha256").update(trimmed).digest("hex");
}

export interface AltDeps {
  readonly db: Database;
  readonly guildId: string;
  /** the account being verified. its own signals never count. */
  readonly userId: string;
}

/**
 * the accounts in this guild that share a signal with this verification.
 *
 * the guild is part of the lookup on purpose: a signal is compared inside the
 * server that asked for it and nowhere else.
 */
export async function findAltMatches(deps: AltDeps, signals: AltSignals): Promise<AltMatch[]> {
  const byUser = new Map<string, Set<VerifySignalKind>>();
  for (const kind of KINDS) {
    const value = signals[kind];
    if (value === null || value === "") continue;
    const rows = await findSignalMatches(deps.db, deps.guildId, kind, [value]);
    for (const row of rows) {
      if (row.user_id === deps.userId) continue;
      const held = byUser.get(row.user_id) ?? new Set<VerifySignalKind>();
      held.add(kind);
      byUser.set(row.user_id, held);
    }
  }

  const matches: AltMatch[] = [];
  for (const [userId, held] of byUser) {
    const kinds = [...held];
    const { confidence, label } = scoreAlt(kinds);
    // one weak signal is not a match worth naming.
    if (confidence < ALT_LOW) continue;
    matches.push({ userId, confidence, label, signals: kinds });
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}
