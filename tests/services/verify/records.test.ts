// tests/services/verify/records.test.ts - a record is per (guild, user), the ip
// goes in the column the storage mode chose, and the refresh sweep only touches
// the records that are due.
//
// the refresh sweep is exercised here because the events it writes are the
// record's timeline, and the timeline belongs to this module.
//
// every test uses its own user id: a record is per (guild, user), so two tests
// sharing one user would share one row and one timeline.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import * as recordsDb from "../../../src/db/queries/verify-records.ts";
import type { Database } from "../../../src/db/types.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  addRecordEvent,
  getRecord,
  listRecords,
  type RecordInput,
  upsertRecord,
} from "../../../src/services/verify/records.ts";
import { refreshDue } from "../../../src/services/verify/refresh.ts";

const GUILD_A = "144102483157850112";
const GUILD_B = "144102483157850113";
const GUILD_C = "144102483157850114";
const GUILD_D = "144102483157850115";
const CLOCK = "2024-01-01T00:00:00.000Z";
const SWEEP = Date.parse("2024-06-01T00:00:00.000Z");
const EXPIRED = "2024-05-01T00:00:00.000Z";
const FUTURE = "2024-07-01T00:00:00.000Z";
const HASH = "b1946ac92492d2347c6235b4d2611184a4b2f8d6b0f0f0f0f0f0f0f0f0f0f0f0";
const CIPHER = "enc:v1:9f2c:0011223344556677";
const ADDRESS = "203.0.113.7";

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-verify-records-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: { ipStorage?: "hash" | "encrypted" | "plaintext" } = {}) {
  return {
    db,
    log: createLogger({ level: "error", dir: null }),
    now: () => CLOCK,
    ...overrides,
  };
}

function input(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    userId: "100000000000000001",
    guildId: GUILD_A,
    username: "someone",
    globalName: "Someone",
    discriminator: "0",
    avatarUrl: null,
    email: "someone@example.com",
    emailVerified: true,
    locale: "en-GB",
    mfaEnabled: true,
    premiumType: 0,
    flags: 64,
    connections: [{ type: "github", verified: true }],
    guilds: [{ id: "1", name: "a server" }],
    relationships: [],
    oauthScopes: ["identify", "email"],
    grantedAt: CLOCK,
    firstIpStored: HASH,
    lastIpStored: HASH,
    ...overrides,
  };
}

describe("the verify records", () => {
  test("a second verification in another guild does not erase the first one's record", async () => {
    const user = "100000000000000010";
    const first = await upsertRecord(deps(), input({ userId: user, email: "a@example.com" }));
    const second = await upsertRecord(
      deps(),
      input({ userId: user, guildId: GUILD_B, email: "b@example.com" }),
    );

    expect(first.record_id).not.toBe(second.record_id);
    expect(first.guild_id).toBe(GUILD_A);
    expect(second.guild_id).toBe(GUILD_B);

    const kept = await getRecord({ db }, GUILD_A, user);
    expect(kept?.email).toBe("a@example.com");
    expect(kept?.record_id).toBe(first.record_id);

    const other = await getRecord({ db }, GUILD_B, user);
    expect(other?.email).toBe("b@example.com");
  });

  test("a re-verification in the same guild updates the row it already has", async () => {
    const user = "100000000000000011";
    const first = await upsertRecord(deps(), input({ userId: user, email: "a@example.com" }));
    const again = await upsertRecord(deps(), input({ userId: user, email: "c@example.com" }));

    expect(again.record_id).toBe(first.record_id);
    const rows = await listRecords({ db }, GUILD_A, 50);
    const mine = rows.filter((row) => row.user_id === user);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.email).toBe("c@example.com");
  });

  test("the email and the ip go in the columns the storage mode chose", async () => {
    const hashed = await upsertRecord(
      deps({ ipStorage: "hash" }),
      input({ userId: "100000000000000012" }),
    );
    expect(hashed.email).toBe("someone@example.com");
    expect(hashed.email_verified).toBe(true);
    expect(hashed.first_ip_hash).toBe(HASH);
    expect(hashed.last_ip_hash).toBe(HASH);
    // a hash was configured, so the address is nowhere in the row.
    expect(hashed.first_ip_enc).toBeNull();
    expect(hashed.last_ip_enc).toBeNull();

    const stored = await db.query<Record<string, unknown>>(
      "SELECT * FROM verify_records WHERE record_id = ?",
      [hashed.record_id],
    );
    expect(JSON.stringify(stored[0])).not.toContain(ADDRESS);

    const encrypted = await upsertRecord(
      deps({ ipStorage: "encrypted" }),
      input({
        userId: "100000000000000013",
        guildId: GUILD_B,
        firstIpStored: CIPHER,
        lastIpStored: CIPHER,
      }),
    );
    expect(encrypted.first_ip_enc).toBe(CIPHER);
    expect(encrypted.last_ip_enc).toBe(CIPHER);
    expect(encrypted.first_ip_hash).toBeNull();
  });

  test("the first ip is the earliest one seen and the last ip moves", async () => {
    const user = "100000000000000014";
    const first = await upsertRecord(
      deps(),
      input({ userId: user, firstIpStored: "hash-a", lastIpStored: "hash-a" }),
    );
    expect(first.first_ip_hash).toBe("hash-a");
    expect(first.last_ip_hash).toBe("hash-a");
    expect(first.ip_history_json).toHaveLength(1);

    const again = await upsertRecord(
      deps(),
      input({ userId: user, firstIpStored: "hash-b", lastIpStored: "hash-b" }),
    );
    expect(again.first_ip_hash).toBe("hash-a");
    expect(again.last_ip_hash).toBe("hash-b");
    expect(again.ip_history_json).toHaveLength(2);
  });

  test("a record write leaves the token columns to the token store", async () => {
    const user = "100000000000000015";
    const row = await upsertRecord(deps(), input({ userId: user }));
    await recordsDb.setRecordTokens(db, row.record_id, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: FUTURE,
      status: "valid",
    });

    const again = await upsertRecord(deps(), input({ userId: user }));
    expect(again.access_token_enc).toBe("enc:access");
    expect(again.refresh_token_enc).toBe("enc:refresh");
    expect(again.token_expires_at).toBe(FUTURE);
    expect(again.token_status).toBe("valid");
  });

  test("every verification is an event on the timeline", async () => {
    const user = "100000000000000016";
    const row = await upsertRecord(deps(), input({ userId: user }));
    const events = await recordsDb.listRecordEvents(db, row.record_id);
    expect(events.map((event) => event.kind)).toEqual(["oauth"]);
    expect(events[0]?.detail_json).toEqual({
      scopes: ["identify", "email"],
      device: null,
      status: "verified",
    });
  });

  test("an event with an unknown kind is refused", async () => {
    await expect(
      addRecordEvent(deps(), {
        userId: "100000000000000016",
        guildId: GUILD_A,
        kind: "not-a-kind",
      }),
    ).rejects.toThrow(/SB_VERIFY_EVENT_KIND/);
  });
});

describe("the refresh sweep", () => {
  async function seed(
    userId: string,
    guildId: string,
    tokens: {
      readonly accessTokenEnc: string | null;
      readonly refreshTokenEnc: string | null;
      readonly expiresAt: string | null;
      readonly status: "valid" | "unauthorized" | "revoked" | "missing";
    },
  ): Promise<string> {
    const row = await upsertRecord(deps(), input({ userId, guildId }));
    await recordsDb.setRecordTokens(db, row.record_id, tokens);
    return row.record_id;
  }

  test("it only touches the records that are due", async () => {
    const user = "100000000000000020";
    const due = await seed(user, GUILD_A, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: EXPIRED,
      status: "valid",
    });
    // not due: the token has not expired yet.
    const fresh = await seed("100000000000000021", GUILD_A, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: FUTURE,
      status: "valid",
    });
    // not due: expired, but the token store already gave up on it.
    const dead = await seed("100000000000000022", GUILD_A, {
      accessTokenEnc: null,
      refreshTokenEnc: null,
      expiresAt: EXPIRED,
      status: "unauthorized",
    });
    // not due: expired and valid, but there is no refresh token to use.
    const bare = await seed("100000000000000023", GUILD_A, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: null,
      expiresAt: EXPIRED,
      status: "valid",
    });
    // due, but another server's. a sweep scoped to one guild leaves it alone.
    const elsewhere = await seed("100000000000000030", GUILD_B, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: EXPIRED,
      status: "valid",
    });

    const asked: string[] = [];
    const result = await refreshDue(
      {
        db,
        log: createLogger({ level: "error", dir: null }),
        refresh: async (userId) => {
          asked.push(userId);
          return true;
        },
        now: () => SWEEP,
        guildId: GUILD_A,
      },
      10,
    );

    expect(result).toEqual({ refreshed: 1, failed: 0 });
    expect(asked).toEqual([user]);

    const dueEvents = await recordsDb.listRecordEvents(db, due);
    expect(dueEvents.map((event) => event.kind)).toEqual(["oauth", "refreshed_ok"]);
    for (const id of [fresh, dead, bare, elsewhere]) {
      const events = await recordsDb.listRecordEvents(db, id);
      expect(events.map((event) => event.kind)).toEqual(["oauth"]);
    }
  });

  test("without a guild the sweep covers every guild", async () => {
    const asked: string[] = [];
    const result = await refreshDue(
      {
        db,
        log: createLogger({ level: "error", dir: null }),
        refresh: async (userId) => {
          asked.push(userId);
          return true;
        },
        now: () => SWEEP,
      },
      100,
    );

    expect(result.refreshed).toBe(asked.length);
    expect(asked).toContain("100000000000000030");
    expect(asked).toContain("100000000000000020");
  });

  test("a user with a record in two guilds is refreshed once", async () => {
    const user = "100000000000000040";
    const inA = await seed(user, GUILD_A, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: EXPIRED,
      status: "valid",
    });
    const inB = await seed(user, GUILD_B, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: EXPIRED,
      status: "valid",
    });

    const asked: string[] = [];
    await refreshDue(
      {
        db,
        log: createLogger({ level: "error", dir: null }),
        refresh: async (userId) => {
          asked.push(userId);
          return true;
        },
        now: () => SWEEP,
      },
      100,
    );

    // the token store keeps one live token per user, so the user is refreshed
    // once and both of their due records get the outcome.
    expect(asked.filter((id) => id === user)).toHaveLength(1);
    for (const id of [inA, inB]) {
      const events = await recordsDb.listRecordEvents(db, id);
      expect(events.map((event) => event.kind)).toEqual(["oauth", "refreshed_ok"]);
    }
  });

  test("a refused refresh is an event, and the record keeps its status", async () => {
    const due = await seed("100000000000000024", GUILD_C, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: EXPIRED,
      status: "valid",
    });

    const result = await refreshDue(
      {
        db,
        log: createLogger({ level: "error", dir: null }),
        refresh: async () => false,
        now: () => SWEEP,
        guildId: GUILD_C,
      },
      10,
    );

    expect(result).toEqual({ refreshed: 0, failed: 1 });
    const events = await recordsDb.listRecordEvents(db, due);
    expect(events.map((event) => event.kind)).toEqual(["oauth", "refreshed_fail"]);
    const row = await recordsDb.getRecordById(db, due);
    expect(row?.token_status).toBe("valid");
  });

  test("a transport failure is a failed event, not a crash", async () => {
    const due = await seed("100000000000000025", GUILD_D, {
      accessTokenEnc: "enc:access",
      refreshTokenEnc: "enc:refresh",
      expiresAt: EXPIRED,
      status: "valid",
    });

    const result = await refreshDue(
      {
        db,
        log: createLogger({ level: "error", dir: null }),
        refresh: async () => {
          throw new Error("the network is down");
        },
        now: () => SWEEP,
        guildId: GUILD_D,
      },
      10,
    );

    expect(result).toEqual({ refreshed: 0, failed: 1 });
    const events = await recordsDb.listRecordEvents(db, due);
    expect(events.map((event) => event.kind)).toEqual(["oauth", "refreshed_fail"]);
  });
});
