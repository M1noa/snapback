// tests/services/verify/alt.test.ts - the anti-alt matcher. a signal is only
// compared inside the guild that asked for it, the account being verified never
// matches itself, and one weak signal is not worth naming as a match.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import { insertSignals } from "../../../src/db/queries/verify-signals.ts";
import type { Database, VerifySignalKind, VerifySignalRow } from "../../../src/db/types.ts";
import {
  ALT_HIGH,
  ALT_MEDIUM,
  ALT_WEIGHTS,
  type AltSignals,
  emailDigest,
  findAltMatches,
  scoreAlt,
} from "../../../src/services/verify/alt.ts";

const GUILD = "144102483157850112";
const OTHER_GUILD = "144102483157850113";
const USER = "100000000000000001";
const OTHER = "100000000000000002";
const CLOCK = "2024-01-01T00:00:00.000Z";

let dir: string;
let db: Database;
let seq = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-verify-alt-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(
  guildId: string,
  userId: string,
  kind: VerifySignalKind,
  value: string,
): VerifySignalRow {
  seq += 1;
  return {
    signal_id: `signal-${seq}`,
    guild_id: guildId,
    user_id: userId,
    kind,
    value,
    created_at: CLOCK,
  };
}

function seed(guildId: string, userId: string, held: Partial<Record<VerifySignalKind, string>>) {
  const rows = Object.entries(held).map(([kind, value]) =>
    row(guildId, userId, kind as VerifySignalKind, value as string),
  );
  return insertSignals(db, rows);
}

function signals(overrides: Partial<AltSignals> = {}): AltSignals {
  return { device: null, ip: null, email: null, avatar: null, name: null, ...overrides };
}

describe("the score", () => {
  test("a shared device is a high match on its own", () => {
    expect(scoreAlt(["device"])).toEqual({ confidence: ALT_HIGH, label: "high" });
  });

  test("a shared address is a medium match on its own", () => {
    expect(scoreAlt(["ip"])).toEqual({ confidence: ALT_WEIGHTS.ip, label: "medium" });
    expect(ALT_WEIGHTS.ip).toBeGreaterThanOrEqual(ALT_MEDIUM);
  });

  test("a shared name is a low match, because names are not unique", () => {
    expect(scoreAlt(["name"])).toEqual({ confidence: 10, label: "low" });
  });

  test("everything shared clamps at a hundred", () => {
    expect(scoreAlt(["device", "ip", "email", "avatar", "name"])).toEqual({
      confidence: 100,
      label: "high",
    });
  });

  test("nothing shared is a zero", () => {
    expect(scoreAlt([])).toEqual({ confidence: 0, label: "low" });
  });
});

describe("the email digest", () => {
  test("the same address in different case is the same digest", () => {
    expect(emailDigest("Someone@Example.COM")).toBe(emailDigest(" someone@example.com "));
  });

  test("two addresses are two digests", () => {
    expect(emailDigest("a@example.com")).not.toBe(emailDigest("b@example.com"));
  });

  test("no address and a blank address are both null", () => {
    expect(emailDigest(null)).toBeNull();
    expect(emailDigest("   ")).toBeNull();
  });
});

describe("the matches", () => {
  test("a shared device is found", async () => {
    await seed(GUILD, OTHER, { device: "device-a" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ device: "device-a" }),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.userId).toBe(OTHER);
    expect(matches[0]?.confidence).toBe(ALT_HIGH);
    expect(matches[0]?.signals).toEqual(["device"]);
  });

  test("an unshared device is not", async () => {
    await seed(GUILD, "100000000000000003", { device: "device-b" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ device: "device-c" }),
    );
    expect(matches).toEqual([]);
  });

  test("the account being verified never matches itself", async () => {
    await seed(GUILD, USER, { device: "device-self", email: "self@example.com" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ device: "device-self", email: emailDigest("self@example.com") }),
    );
    expect(matches).toEqual([]);
  });

  test("another server's signals are not compared", async () => {
    await seed(OTHER_GUILD, "100000000000000004", { device: "device-elsewhere" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ device: "device-elsewhere" }),
    );
    expect(matches).toEqual([]);
  });

  test("two signals add up and clamp", async () => {
    await seed(GUILD, "100000000000000005", { device: "device-d", ip: "ip-d", avatar: "avatar-d" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ device: "device-d", ip: "ip-d", avatar: "avatar-d" }),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe(100);
    expect([...(matches[0]?.signals ?? [])].sort()).toEqual(["avatar", "device", "ip"]);
  });

  test("a name on its own is below the line and is not reported", async () => {
    await seed(GUILD, "100000000000000006", { name: "alex" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ name: "alex" }),
    );
    expect(matches).toEqual([]);
  });

  test("a name on top of an address is reported, and the strongest comes first", async () => {
    await seed(GUILD, "100000000000000007", { name: "sam", ip: "ip-e" });
    await seed(GUILD, "100000000000000008", { device: "device-e" });

    const matches = await findAltMatches(
      { db, guildId: GUILD, userId: USER },
      signals({ name: "sam", ip: "ip-e", device: "device-e" }),
    );
    expect(matches.map((match) => match.userId)).toEqual([
      "100000000000000008",
      "100000000000000007",
    ]);
    expect(matches[1]?.signals).toEqual(["ip", "name"]);
  });

  test("an empty set of signals is not a lookup", async () => {
    expect(await findAltMatches({ db, guildId: GUILD, userId: USER }, signals())).toEqual([]);
    expect(
      await findAltMatches({ db, guildId: GUILD, userId: USER }, signals({ device: "" })),
    ).toEqual([]);
  });
});
