// the records a verification produced (D4PLAN 5.1, 13.3). one row per (guild,
// user) and an event for every thing that happened to it.
//
// a record is per guild on purpose: revoking in one server must not erase
// another server's record, and the owner's list of who removed the app is per
// guild.
//
// the tokens are never written here. they belong to the token store, so this
// module leaves access_token_enc, refresh_token_enc, token_expires_at and
// token_status alone, and a re-verification does not wipe them.

import type { IpStorage } from "../../config/parse-env.ts";
import * as recordsDb from "../../db/queries/verify-records.ts";
import type { Database, JsonObject, VerifyRecordRow } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import { oneOf } from "../../lib/validate.ts";

// the event kinds the timeline knows. the union lives in db/types.ts; this is
// the same list at runtime, so an unknown kind is refused instead of being
// written into the timeline.
const EVENT_KINDS = [
  "oauth",
  "refresh",
  "revoked",
  "refreshed_ok",
  "refreshed_fail",
  "note",
] as const;

const MAX_LIST = 500;

export interface RecordInput {
  readonly userId: string;
  readonly guildId: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly discriminator: string | null;
  readonly avatarUrl: string | null;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly locale: string | null;
  readonly mfaEnabled: boolean | null;
  readonly premiumType: number | null;
  readonly flags: number | null;
  readonly connections: readonly unknown[];
  readonly guilds: readonly unknown[];
  readonly relationships: readonly unknown[];
  readonly oauthScopes: readonly string[];
  readonly grantedAt: string;
  readonly firstIpStored: string | null;
  readonly lastIpStored: string | null;
}

export interface RecordDeps {
  readonly db: Database;
  readonly log: Logger;
  /** injectable clock in iso-8601. */
  readonly now?: () => string;
  /** the ip storage mode in force. it picks the column (D4PLAN 14.5). */
  readonly ipStorage?: IpStorage;
}

interface IpColumns {
  readonly hash: string | null;
  readonly enc: string | null;
}

// the storage mode picks the column (D4PLAN 14.5). the hash mode keeps the
// hash and leaves the other slot empty, so an address is never kept as a bare
// string where a hash was configured. the encrypted mode keeps the ciphertext.
// the schema has no plaintext column, so the plaintext mode uses the same slot
// as the encrypted one, and nothing decrypts that slot unless the mode says
// encrypted.
function ipColumns(mode: IpStorage, value: string | null): IpColumns {
  if (value === null) return { hash: null, enc: null };
  if (mode === "hash") return { hash: value, enc: null };
  return { hash: null, enc: value };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// the captured lists are json. only plain objects are kept, so a broken entry
// cannot reach the ui in the wrong shape.
function jsonObjects(values: readonly unknown[]): JsonObject[] {
  return values.filter(isJsonObject);
}

// the ip history keeps one entry per address the record was seen from, so a
// second verification from a different address is visible (D4PLAN 14.5).
function history(previous: JsonObject[] | null, value: string | null, at: string): JsonObject[] {
  const entries = previous ?? [];
  if (value === null) return entries;
  const latest = entries[entries.length - 1];
  if (latest !== undefined && latest.hash === value) return entries;
  return [...entries, { hash: value, at, event: "verify" }];
}

// the detail is free-form and the column holds an object, so a bare value is
// wrapped rather than dropped.
function detailOf(detail: unknown): JsonObject | null {
  if (detail === undefined || detail === null) return null;
  if (isJsonObject(detail)) return detail;
  return { value: detail };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_LIST;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST);
}

/** write the record of one verification. the row is per (guild, user), so a
 *  verification in another server is another row and never an overwrite. */
export async function upsertRecord(deps: RecordDeps, input: RecordInput): Promise<VerifyRecordRow> {
  const at = deps.now?.() ?? new Date().toISOString();
  const mode = deps.ipStorage ?? "hash";
  const existing = await recordsDb.getRecord(deps.db, input.guildId, input.userId);

  const last = ipColumns(mode, input.lastIpStored);
  // the first ip is the earliest one seen, so a re-verification never moves it.
  const first =
    existing === null
      ? ipColumns(mode, input.firstIpStored ?? input.lastIpStored)
      : { hash: existing.first_ip_hash, enc: existing.first_ip_enc };

  const row: VerifyRecordRow = {
    record_id: existing?.record_id ?? Bun.randomUUIDv7(),
    guild_id: input.guildId,
    user_id: input.userId,
    username: input.username,
    global_name: input.globalName,
    discriminator: input.discriminator,
    avatar_url: input.avatarUrl,
    email: input.email,
    email_verified: input.emailVerified,
    locale: input.locale,
    mfa_enabled: input.mfaEnabled,
    premium_type: input.premiumType,
    flags: input.flags,
    connections_json: jsonObjects(input.connections),
    guilds_json: jsonObjects(input.guilds),
    relationships_json: jsonObjects(input.relationships),
    oauth_scopes_json: [...input.oauthScopes],
    oauth_granted_at: input.grantedAt,
    oauth_last_checked_at: at,
    // the token store owns these four. a record write never touches them.
    access_token_enc: null,
    refresh_token_enc: null,
    token_expires_at: null,
    token_status: "missing",
    first_ip_hash: first.hash,
    first_ip_enc: first.enc,
    last_ip_hash: last.hash,
    last_ip_enc: last.enc,
    ip_history_json: history(existing?.ip_history_json ?? null, last.hash ?? last.enc, at),
    // the intel, fingerprint and note columns belong to their own modules.
    country_code: null,
    country_name: null,
    city: null,
    region: null,
    isp: null,
    asn: null,
    as_org: null,
    ip_type: null,
    is_vpn: null,
    is_proxy: null,
    is_tor: null,
    intel_checked_at: null,
    fingerprint_json: null,
    referrer: null,
    user_agent: null,
    revoked_at: null,
    notes: null,
    created_at: existing?.created_at ?? at,
    updated_at: at,
  };

  await recordsDb.upsertRecord(deps.db, row);
  const saved = await recordsDb.getRecord(deps.db, input.guildId, input.userId);
  if (saved === null) {
    throw new Error("SB_VERIFY_RECORD_MISSING: the record was written but cannot be read back");
  }

  // a verification is an event on the timeline (D4PLAN 13.3, step 12).
  await addRecordEvent(deps, {
    userId: input.userId,
    guildId: input.guildId,
    kind: "oauth",
    detail: { scopes: input.oauthScopes },
  });

  deps.log.info("verify record written", {
    recordId: saved.record_id,
    guildId: saved.guild_id,
    userId: saved.user_id,
  });
  return saved;
}

/** write an event on a record's timeline. without a guild id the event lands
 *  on every record the user has, since a user can be verified in several
 *  servers. */
export async function addRecordEvent(
  deps: { db: Database; log: Logger; now?: () => string },
  input: { userId: string; guildId?: string; kind: string; detail?: unknown },
): Promise<void> {
  const kind = oneOf(input.kind, EVENT_KINDS);
  if (kind === null) {
    throw new Error(
      `SB_VERIFY_EVENT_KIND: unknown record event kind ${JSON.stringify(input.kind)}`,
    );
  }
  const at = deps.now?.() ?? new Date().toISOString();
  const records =
    input.guildId === undefined
      ? await recordsDb.listRecordsForUser(deps.db, input.userId)
      : [await recordsDb.getRecord(deps.db, input.guildId, input.userId)].filter(
          (row): row is VerifyRecordRow => row !== null,
        );
  for (const record of records) {
    await recordsDb.insertRecordEvent(deps.db, {
      record_id: record.record_id,
      at,
      kind,
      detail_json: detailOf(input.detail),
    });
  }
}

/** the records of one guild, newest first. */
export async function listRecords(
  deps: { db: Database },
  guildId: string,
  limit: number,
): Promise<VerifyRecordRow[]> {
  return await recordsDb.listRecords(deps.db, guildId, clampLimit(limit));
}

/** one record, by guild and user. */
export async function getRecord(
  deps: { db: Database },
  guildId: string,
  userId: string,
): Promise<VerifyRecordRow | null> {
  return await recordsDb.getRecord(deps.db, guildId, userId);
}
