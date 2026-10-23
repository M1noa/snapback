// tests/services/verify/attempts.test.ts
//
// what a blacklist match keeps and who it tells (D4PLAN 19.5). the row is the
// record: every field the verification gathered, the fingerprint included, and
// the address only in the form the storage mode produced. the two alerts are
// best effort and never touch the decision, because a match is a signal
// (D4PLAN 19.4).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import {
  countBlacklistAttempts,
  listBlacklistAttempts,
} from "../../../src/db/queries/blacklist-attempts.ts";
import type { Database } from "../../../src/db/types.ts";
import type { RequestOptions } from "../../../src/discord/client.ts";
import { createLogger } from "../../../src/lib/log.ts";
import type { IntelResult } from "../../../src/services/intel/index.ts";
import {
  type AttemptDeps,
  type AttemptSubject,
  matchBlacklist,
} from "../../../src/services/verify/attempts.ts";
import { addEntry } from "../../../src/services/verify/blacklist.ts";
import type { CapturedIp } from "../../../src/web/capture/ip.ts";

const GUILD = "123456789012345678";
const OTHER_GUILD = "222222222222222222";
const USER = "987654321098765432";
const OWNER = "111111111111111111";
const LOG_CHANNEL = "555555555555555555";
const DM_CHANNEL = "444444444444444444";
const AT = "2024-06-01T12:00:00.000Z";
/** the hash the storage mode produced. the address itself never appears. */
const IP_HASH = "b7f0c2d9a1e4c3b5d6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9";
const ADDRESS = "203.0.113.44";

let dir: string;
let db: Database;

interface Sent {
  readonly route: string;
  readonly method: string;
  readonly body: unknown;
}

function fakeClient(sent: Sent[]): AttemptDeps["client"] {
  return {
    async request<T>(request: RequestOptions): Promise<T> {
      sent.push({ route: request.route, method: request.method, body: request.body });
      if (request.route === "/users/@me/channels") return { id: DM_CHANNEL } as T;
      return {} as T;
    },
  };
}

function subject(ip: CapturedIp, intel: IntelResult | null = null): AttemptSubject {
  return {
    guildId: GUILD,
    userId: USER,
    username: "someone",
    globalName: "Someone",
    ip,
    fingerprint: { canvas: "8d3f", audio: 12.5, fonts: ["dejavu"], platform: "macos" },
    device: "d41d8cd98f00b204",
    signals: {
      device: "d41d8cd98f00b204",
      ip: IP_HASH,
      email: null,
      avatar: null,
      name: null,
    },
    intel,
    status: "refused",
    refusalReason: "the account could not be vouched for",
  };
}

function intel(): IntelResult {
  return {
    countryCode: "de",
    countryName: "germany",
    isp: "a carrier",
    asn: "64500",
    asOrg: "AS-CARRIER",
    ipType: "mobile",
    category: null,
    isHosting: false,
    isVpn: false,
    isProxy: false,
    isTor: false,
    evidence: "a mobile network in germany",
    isAnonymousProxy: false,
  };
}

function deps(sent: Sent[], overrides: Partial<AttemptDeps> = {}): AttemptDeps {
  return {
    db,
    log: createLogger({ level: "error", dir: null }),
    now: () => Date.parse(AT),
    ownerId: OWNER,
    logChannel: async () => LOG_CHANNEL,
    guildName: async () => "the test server",
    client: fakeClient(sent),
    ...overrides,
  };
}

const HASHED: CapturedIp = { address: ADDRESS, stored: IP_HASH, mode: "hash" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-attempts-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a match against the blacklist", () => {
  test("keeps the snapshot in the row and tells the owner", async () => {
    await addEntry(
      { db, now: () => Date.parse(AT) },
      { guildId: GUILD, kind: "ip_hash", value: IP_HASH, addedBy: OWNER, reason: null },
    );

    const sent: Sent[] = [];
    const row = await matchBlacklist(deps(sent), subject(HASHED, intel()));

    expect(row).not.toBeNull();
    expect(row?.ip_mode).toBe("hash");
    expect(row?.ip_hash).toBe(IP_HASH);
    expect(row?.device).toBe("d41d8cd98f00b204");
    expect(row?.fingerprint_json).toEqual({
      canvas: "8d3f",
      audio: 12.5,
      fonts: ["dejavu"],
      platform: "macos",
    });
    expect(row?.asn).toBe("64500");
    expect(row?.country_code).toBe("de");
    expect(row?.matches_json?.[0]).toMatchObject({ kind: "ip_hash", value: IP_HASH });

    const kept = await listBlacklistAttempts(db, GUILD);
    expect(kept.map((attempt) => attempt.attempt_id)).toEqual([row?.attempt_id ?? ""]);
    expect(await countBlacklistAttempts(db, GUILD)).toBe(1);

    // the dm to the owner, then the guild's log channel, both with the tree.
    expect(sent.map((request) => request.route)).toEqual([
      "/users/@me/channels",
      `/channels/${DM_CHANNEL}/messages`,
      `/channels/${LOG_CHANNEL}/messages`,
    ]);
    expect(sent[0]?.body).toEqual({ recipient_id: OWNER });
    for (const message of sent.slice(1)) {
      const body = message.body as { flags?: number; allowed_mentions?: unknown };
      expect(body.flags).toBe(32768);
      expect(body.allowed_mentions).toEqual({ parse: [] });
    }
  });

  test("the row never holds the address itself", async () => {
    const kept = await listBlacklistAttempts(db, GUILD);
    expect(JSON.stringify(kept)).not.toContain(ADDRESS);
  });

  test("an encrypted address cannot match an entry", async () => {
    const sent: Sent[] = [];
    const encrypted: CapturedIp = {
      address: ADDRESS,
      // a fresh ciphertext on every run, so no entry could ever hold it.
      stored: "v1.YWJj.ZGVm.Z2hp",
      mode: "encrypted",
    };
    const row = await matchBlacklist(deps(sent), subject(encrypted));
    expect(row).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test("a non-matching account writes nothing and sends nothing", async () => {
    const sent: Sent[] = [];
    const row = await matchBlacklist(
      deps(sent),
      subject({ address: ADDRESS, stored: "0".repeat(64), mode: "hash" }),
    );
    expect(row).toBeNull();
    expect(sent).toHaveLength(0);
    expect(await countBlacklistAttempts(db, GUILD)).toBe(1);
  });

  test("another server's list does not match", async () => {
    await addEntry(
      { db, now: () => Date.parse(AT) },
      {
        guildId: OTHER_GUILD,
        kind: "ip_hash",
        value: "1".repeat(64),
        addedBy: OWNER,
        reason: null,
      },
    );
    const sent: Sent[] = [];
    const row = await matchBlacklist(
      deps(sent),
      subject({ address: ADDRESS, stored: "1".repeat(64), mode: "hash" }),
    );
    expect(row).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test("a failed alert never fails the verification", async () => {
    const row = await matchBlacklist(
      deps([], {
        client: {
          request: async () => {
            throw new Error("discord is down");
          },
        },
        logChannel: async () => {
          throw new Error("the settings could not be read");
        },
        guildName: async () => {
          throw new Error("the guild could not be read");
        },
      }),
      subject(HASHED, intel()),
    );
    // the record is still written: the row is the thing the operator reads later.
    expect(row).not.toBeNull();
    expect(await countBlacklistAttempts(db, GUILD)).toBe(2);
  });

  test("a server with no log channel gets the dm only", async () => {
    const sent: Sent[] = [];
    const row = await matchBlacklist(deps(sent, { logChannel: async () => null }), subject(HASHED));
    expect(row).not.toBeNull();
    expect(sent.map((request) => request.route)).toEqual([
      "/users/@me/channels",
      `/channels/${DM_CHANNEL}/messages`,
    ]);
  });
});
