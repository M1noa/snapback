// services/verify/blacklist.ts. the per-guild blacklist (D4PLAN 8).
//
// an entry is a signal shown to an operator. this module never refuses
// anything: the check below reports a match and stops there, and its result
// carries no decision field, so there is no path from a match to a refusal.
// D4PLAN 19.4 says why: shared nat, student halls and mobile carriers all
// produce false matches, so a hash match alone is never a ban.
//
// the list lives in its own table, not in guilds.settings_json: it grows, and
// the pull engine reads it on every join.

import {
  addBlacklistEntry,
  findBlacklistEntries,
  listBlacklistEntries,
  removeBlacklistEntry,
} from "../../db/queries/blacklist.ts";
import type { BlacklistKind, Database, GuildBlacklistRow } from "../../db/types.ts";

/** what an entry can name. the same three the plan names. */
export const BLACKLIST_KINDS = ["user_id", "ip_hash", "asn"] as const;

export interface BlacklistDeps {
  readonly db: Database;
  /** epoch ms. injected so a row's timestamp is testable. */
  readonly now: () => number;
}

export interface BlacklistEntryInput {
  readonly guildId: string;
  readonly kind: BlacklistKind;
  readonly value: string;
  /** who added it. null when the list was written by a job. */
  readonly addedBy: string | null;
  readonly reason: string | null;
}

/** what a check found. it names the entries that matched and nothing else. */
export interface BlacklistMatch {
  readonly kind: BlacklistKind;
  readonly value: string;
  readonly addedAt: string;
  readonly addedBy: string | null;
}

/**
 * the result of a check. there is no decision field here on purpose: a match
 * is something to show an operator, and a caller that wanted a refusal would
 * have to invent one.
 */
export interface BlacklistCheck {
  readonly guildId: string;
  readonly matched: boolean;
  readonly matches: readonly BlacklistMatch[];
}

/** what a check looks at. the account, in the forms the list can name. */
export interface AccountSignal {
  readonly userId: string;
  /** the address hashes the record holds. the plain address is never a value. */
  readonly ipHashes: readonly string[];
  readonly asn: string | null;
}

/** add an entry. `added` is false when it was already there. */
export async function addEntry(
  deps: BlacklistDeps,
  input: BlacklistEntryInput,
): Promise<{ added: boolean; entry: GuildBlacklistRow }> {
  const row: GuildBlacklistRow = {
    guild_id: input.guildId,
    kind: input.kind,
    value: input.value,
    added_by: input.addedBy,
    added_at: new Date(deps.now()).toISOString(),
    reason: input.reason,
  };
  const added = await addBlacklistEntry(deps.db, row);
  return { added, entry: row };
}

/** remove an entry. false when there was nothing to remove. */
export async function removeEntry(
  deps: BlacklistDeps,
  input: { guildId: string; kind: BlacklistKind; value: string },
): Promise<boolean> {
  return await removeBlacklistEntry(deps.db, input.guildId, input.kind, input.value);
}

/** the whole list of one guild. */
export async function listEntries(
  deps: BlacklistDeps,
  guildId: string,
): Promise<GuildBlacklistRow[]> {
  return await listBlacklistEntries(deps.db, guildId);
}

/**
 * report whether an account matches the list. it reports: the result names the
 * entries that matched and carries no decision, so no caller can turn a match
 * into a refusal by reading it.
 */
export async function checkAccount(
  deps: BlacklistDeps,
  guildId: string,
  account: AccountSignal,
): Promise<BlacklistCheck> {
  const matches: BlacklistMatch[] = [];
  const seen = new Set<string>();

  const collect = (rows: readonly GuildBlacklistRow[]): void => {
    for (const row of rows) {
      const key = `${row.kind}:${row.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        kind: row.kind,
        value: row.value,
        addedAt: row.added_at,
        addedBy: row.added_by,
      });
    }
  };

  collect(await findBlacklistEntries(deps.db, guildId, "user_id", [account.userId]));
  collect(await findBlacklistEntries(deps.db, guildId, "ip_hash", account.ipHashes));
  if (account.asn !== null) {
    collect(await findBlacklistEntries(deps.db, guildId, "asn", [account.asn]));
  }

  return { guildId, matched: matches.length > 0, matches };
}

/**
 * whether a value can be an entry of that kind. the kind says what the value
 * is, so the value is checked against it: a name is not a user id, and a bare
 * address is not an address hash.
 */
export function isValidEntryValue(kind: BlacklistKind, value: string): boolean {
  if (value === "") return false;
  if (kind === "user_id") return /^\d{5,20}$/.test(value);
  if (kind === "asn") return /^(AS)?\d+$/i.test(value);
  // an address hash is opaque: the pepper is ours, so the shape is not ours to
  // demand. it must not be a bare address though.
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}
