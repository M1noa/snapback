// tests/services/verify/token-store.test.ts. the token store (D4PLAN 13.4)
// against a real temp-file duckdb: the row on disk holds ciphertext, the
// store hands the plaintext back, a store without an encryption key refuses to
// hold a token at all, and an update replaces the access token and leaves the
// refresh token where it was.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../../../src/db/types.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  createTokenStore,
  type StoredToken,
  TokenStoreError,
} from "../../../src/services/verify/token-store.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const GUILD = "123456789012345678";
const ACCESS = "the-access-token";
const REFRESH = "the-refresh-token";
const EXPIRES = "2024-01-08T00:00:00.000Z";

// 32 bytes, base64, the shape env.privacy.encryptionKey holds.
const KEY = Buffer.alloc(32, 7).toString("base64");

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function store(key: string = KEY) {
  return createTokenStore({
    db,
    encryptionKey: key,
    log: createLogger({ level: "error", dir: null }),
  });
}

function input(userId: string) {
  return {
    userId,
    guildId: GUILD,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: EXPIRES,
    scopes: ["identify", "email"],
  };
}

describe("the token store", () => {
  test("a stored token is not readable as plaintext from the row", async () => {
    const userId = "111111111111111111";
    const tokens = store();
    await tokens.put(input(userId));

    const rows = await db.query<{
      access_token_enc: string | null;
      refresh_token_enc: string | null;
    }>("SELECT access_token_enc, refresh_token_enc FROM verify_records WHERE user_id = ?", [
      userId,
    ]);
    const row = rows[0];
    expect(row?.access_token_enc).not.toBeNull();
    expect(row?.access_token_enc).not.toContain(ACCESS);
    expect(row?.refresh_token_enc).not.toContain(REFRESH);

    const stored = await tokens.get(userId);
    expect(stored?.accessToken).toBe(ACCESS);
    expect(stored?.refreshToken).toBe(REFRESH);
    expect(stored?.expiresAt).toBe(EXPIRES);
    expect(stored?.guildId).toBe(GUILD);
    expect(stored?.scopes).toEqual(["identify", "email"]);
  });

  test("a token with no encryption key is refused with the fixed code", async () => {
    const userId = "222222222222222222";
    const tokens = store("");

    const attempt = tokens.put(input(userId));
    await expect(attempt).rejects.toThrow(TokenStoreError);
    await expect(attempt).rejects.toThrow("SB_TOKEN_NO_KEY");

    // nothing was written: a plaintext token at rest is what the plan forbids.
    const rows = await db.query<{ count: number }>(
      "SELECT count(*) AS count FROM verify_records WHERE user_id = ?",
      [userId],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  test("a token that is removed is gone", async () => {
    const userId = "333333333333333333";
    const tokens = store();
    await tokens.put(input(userId));
    expect(await tokens.get(userId)).not.toBeNull();

    await tokens.remove(userId);

    expect(await tokens.get(userId)).toBeNull();
    const rows = await db.query<{
      access_token_enc: string | null;
      refresh_token_enc: string | null;
    }>("SELECT access_token_enc, refresh_token_enc FROM verify_records WHERE user_id = ?", [
      userId,
    ]);
    expect(rows[0]?.access_token_enc).toBeNull();
    expect(rows[0]?.refresh_token_enc).toBeNull();
  });

  test("an update replaces the access token and leaves the refresh token", async () => {
    const userId = "444444444444444444";
    const tokens = store();
    await tokens.put(input(userId));

    await tokens.update(userId, { accessToken: "a-new-access-token", expiresAt: "2024-02-01" });

    const stored: StoredToken | null = await tokens.get(userId);
    expect(stored?.accessToken).toBe("a-new-access-token");
    expect(stored?.refreshToken).toBe(REFRESH);
    expect(stored?.expiresAt).toBe("2024-02-01");
  });

  test("a second put for the same guild and user replaces the token in place", async () => {
    const userId = "555555555555555555";
    const tokens = store();
    await tokens.put(input(userId));
    await tokens.put({ ...input(userId), accessToken: "a-second-access-token" });

    const stored = await tokens.get(userId);
    expect(stored?.accessToken).toBe("a-second-access-token");
    const rows = await db.query<{ count: number }>(
      "SELECT count(*) AS count FROM verify_records WHERE user_id = ?",
      [userId],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });
});
