// the token store (D4PLAN 13.4). the access token and the refresh token are
// encrypted with aes-256-gcm before they touch the database, and the plaintext
// never reaches a log line, an export, or a query result (AGENTS.md rule 10).
//
// the store owns the token columns on verify_records and nothing else: the ip,
// the fingerprint and the profile belong to the record writer, so this file
// never writes a column it does not own.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseJson, type SqlValue, stringifyJson, toId, toText } from "../../db/rows.ts";
import type { Database, TokenStatus } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";

/** a stored token, decrypted. the plaintext exists only in memory. */
export interface StoredToken {
  readonly userId: string;
  readonly guildId: string;
  readonly accessToken: string;
  /** null when the row holds no refresh token, or none that can be read. */
  readonly refreshToken: string | null;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

export interface TokenStore {
  put(input: {
    userId: string;
    guildId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes: readonly string[];
  }): Promise<void>;
  get(userId: string): Promise<StoredToken | null>;
  /** replaces the access token after a refresh. */
  update(userId: string, input: { accessToken: string; expiresAt: string }): Promise<void>;
  /**
   * clears the token. the status defaults to "revoked" (the user hit /revoke);
   * a refresh that discord refused passes "unauthorized" (D4PLAN 13.5).
   */
  remove(userId: string, status?: TokenStatus): Promise<void>;
}

export type TokenStoreErrorCode = "SB_TOKEN_NO_KEY" | "SB_TOKEN_BAD_KEY";

const MESSAGES: Record<TokenStoreErrorCode, string> = {
  SB_TOKEN_NO_KEY: "no encryption key is configured, so a token cannot be stored",
  SB_TOKEN_BAD_KEY: "the encryption key does not decode to 32 bytes",
};

export class TokenStoreError extends Error {
  readonly code: TokenStoreErrorCode;
  constructor(code: TokenStoreErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "TokenStoreError";
    this.code = code;
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const COLUMNS =
  "record_id, guild_id, user_id, access_token_enc, refresh_token_enc, token_expires_at, oauth_scopes_json";

// the ciphertext is iv | tag | body, base64. the iv is per write, so two rows
// with the same token do not share a ciphertext.
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

// a row that cannot be decrypted is a row with no usable token: a rotated key,
// a truncated write. null, and the caller says so in the log.
function decrypt(key: Buffer, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function readScopes(stored: string | null): readonly string[] {
  if (stored === null) return [];
  const parsed = parseJson<unknown>(stored);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((scope): scope is string => typeof scope === "string");
}

function readRow(raw: Record<string, SqlValue>) {
  return {
    record_id: toId(raw.record_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    user_id: toId(raw.user_id) ?? "",
    access_token_enc: toText(raw.access_token_enc) ?? null,
    refresh_token_enc: toText(raw.refresh_token_enc) ?? null,
    token_expires_at: toText(raw.token_expires_at) ?? null,
    oauth_scopes_json: toText(raw.oauth_scopes_json) ?? null,
  };
}

/**
 * the store over a verify_records table. without an encryption key it holds
 * nothing: a plaintext token at rest is exactly what the plan forbids, so the
 * store refuses with one code rather than quietly writing the column.
 */
export function createTokenStore(options: {
  db: Database;
  encryptionKey: string;
  log: Logger;
}): TokenStore {
  const { db, log } = options;
  const key = readKey(options.encryptionKey);

  function requireKey(): Buffer {
    if (key === null) throw new TokenStoreError("SB_TOKEN_NO_KEY");
    return key;
  }

  // the row for this (guild, user). verify_records is keyed by record_id and
  // holds one row per (guild, user), so the pair is looked up rather than
  // upserted.
  async function findRecordId(guildId: string, userId: string): Promise<string | null> {
    const rows = await db.query<Record<string, SqlValue>>(
      "SELECT record_id FROM verify_records WHERE guild_id = ? AND user_id = ? LIMIT 1",
      [guildId, userId],
    );
    const first = rows[0];
    return first === undefined ? null : (toId(first.record_id) ?? null);
  }

  // the user's newest row that holds a token. a user can hold a row per guild;
  // the token is the app's, and the newest one is the live one.
  async function findTokenRecordId(userId: string): Promise<string | null> {
    const rows = await db.query<Record<string, SqlValue>>(
      `SELECT record_id FROM verify_records
       WHERE user_id = ? AND access_token_enc IS NOT NULL
       ORDER BY created_at DESC, record_id DESC
       LIMIT 1`,
      [userId],
    );
    const first = rows[0];
    return first === undefined ? null : (toId(first.record_id) ?? null);
  }

  async function put(input: {
    userId: string;
    guildId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes: readonly string[];
  }): Promise<void> {
    const secret = requireKey();
    const now = new Date().toISOString();
    const access = encrypt(secret, input.accessToken);
    const refresh = encrypt(secret, input.refreshToken);
    const scopes = stringifyJson([...input.scopes]);
    const recordId = await findRecordId(input.guildId, input.userId);

    if (recordId === null) {
      await db.run(
        `INSERT INTO verify_records (
           record_id, guild_id, user_id, access_token_enc, refresh_token_enc,
           token_expires_at, oauth_scopes_json, token_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Bun.randomUUIDv7(),
          input.guildId,
          input.userId,
          access,
          refresh,
          input.expiresAt,
          scopes,
          "valid",
          now,
          now,
        ],
      );
      return;
    }

    await db.run(
      `UPDATE verify_records SET
         access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?,
         oauth_scopes_json = ?, token_status = ?, updated_at = ?
       WHERE record_id = ?`,
      [access, refresh, input.expiresAt, scopes, "valid", now, recordId],
    );
  }

  async function get(userId: string): Promise<StoredToken | null> {
    if (key === null) return null;
    const rows = await db.query<Record<string, SqlValue>>(
      `SELECT ${COLUMNS} FROM verify_records
       WHERE user_id = ? AND access_token_enc IS NOT NULL
       ORDER BY created_at DESC, record_id DESC
       LIMIT 1`,
      [userId],
    );
    const first = rows[0];
    if (first === undefined) return null;
    const row = readRow(first);
    if (row.access_token_enc === null) return null;

    const accessToken = decrypt(key, row.access_token_enc);
    if (accessToken === null) {
      log.warn("a stored token could not be decrypted, the record counts as having none", {
        user_id: userId,
      });
      return null;
    }
    const refreshToken =
      row.refresh_token_enc === null ? null : decrypt(key, row.refresh_token_enc);

    return {
      userId: row.user_id,
      guildId: row.guild_id,
      accessToken,
      refreshToken,
      expiresAt: row.token_expires_at ?? "",
      scopes: readScopes(row.oauth_scopes_json),
    };
  }

  async function update(userId: string, input: { accessToken: string; expiresAt: string }) {
    const secret = requireKey();
    const recordId = await findTokenRecordId(userId);
    if (recordId === null) {
      log.warn("there is no stored token to update", { user_id: userId });
      return;
    }
    await db.run(
      `UPDATE verify_records SET
         access_token_enc = ?, token_expires_at = ?, token_status = ?, updated_at = ?
       WHERE record_id = ?`,
      [
        encrypt(secret, input.accessToken),
        input.expiresAt,
        "valid",
        new Date().toISOString(),
        recordId,
      ],
    );
  }

  async function remove(userId: string, status: TokenStatus = "revoked"): Promise<void> {
    // every row for the user, not one: the token is the application's, so
    // revoking it in one guild revokes it in the others too.
    await db.run(
      `UPDATE verify_records SET
         access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL,
         token_status = ?, updated_at = ?
       WHERE user_id = ?`,
      [status, new Date().toISOString(), userId],
    );
  }

  return { put, get, update, remove };
}

// a missing key is a valid configuration (the operator has no token storage);
// a key of the wrong length is a mistake and stops the store at once.
function readKey(encryptionKey: string): Buffer | null {
  const trimmed = encryptionKey.trim();
  if (trimmed === "") return null;
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) throw new TokenStoreError("SB_TOKEN_BAD_KEY");
  return key;
}
