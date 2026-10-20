// tests/services/verify/blacklist.test.ts
//
// the blacklist service (D4PLAN 8, 19.4). an entry is a signal shown to an
// operator, never a ban: the check reports a match and carries no decision, so
// there is no path from a match to a refusal.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import type { Database } from "../../../src/db/types.ts";
import * as blacklist from "../../../src/services/verify/blacklist.ts";
import {
  addEntry,
  type BlacklistCheck,
  type BlacklistDeps,
  checkAccount,
  listEntries,
  removeEntry,
} from "../../../src/services/verify/blacklist.ts";

const GUILD = "123456789012345678";
const OTHER_GUILD = "222222222222222222";
const USER = "987654321098765432";
const OWNER = "111111111111111111";
const AT = "2024-06-01T12:00:00.000Z";

let dir: string;
let db: Database;
let deps: BlacklistDeps;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-blacklist-svc-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
  deps = { db, now: () => Date.parse(AT) };
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the blacklist service", () => {
  test("an entry is added, listed and removed", async () => {
    const added = await addEntry(deps, {
      guildId: GUILD,
      kind: "user_id",
      value: USER,
      addedBy: OWNER,
      reason: null,
    });
    expect(added.added).toBe(true);
    expect(added.entry.added_at).toBe(AT);

    const entries = await listEntries(deps, GUILD);
    const found = entries.find((entry) => entry.value === USER);
    expect(found?.kind).toBe("user_id");
    expect(found?.added_by).toBe(OWNER);

    expect(await removeEntry(deps, { guildId: GUILD, kind: "user_id", value: USER })).toBe(true);
    const after = await listEntries(deps, GUILD);
    expect(after.find((entry) => entry.value === USER)).toBeUndefined();
  });

  test("adding the same entry twice does not make a second row", async () => {
    const first = await addEntry(deps, {
      guildId: GUILD,
      kind: "ip_hash",
      value: "sha256-of-an-address",
      addedBy: OWNER,
      reason: null,
    });
    expect(first.added).toBe(true);

    const second = await addEntry(deps, {
      guildId: GUILD,
      kind: "ip_hash",
      value: "sha256-of-an-address",
      addedBy: OWNER,
      reason: null,
    });
    expect(second.added).toBe(false);

    const entries = await listEntries(deps, GUILD);
    expect(entries.filter((entry) => entry.value === "sha256-of-an-address")).toHaveLength(1);
  });

  test("a check reports a match and says which entry matched", async () => {
    await addEntry(deps, {
      guildId: GUILD,
      kind: "ip_hash",
      value: "sha256-of-the-address",
      addedBy: OWNER,
      reason: "seen before",
    });

    const result = await checkAccount(deps, GUILD, {
      userId: USER,
      ipHashes: ["sha256-of-the-address"],
      asn: null,
    });

    expect(result.matched).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("ip_hash");
    expect(result.matches[0]?.value).toBe("sha256-of-the-address");
    expect(result.matches[0]?.addedBy).toBe(OWNER);
  });

  test("a check that finds nothing says so", async () => {
    const result = await checkAccount(deps, GUILD, {
      userId: "404040404040404040",
      ipHashes: ["a-hash-nobody-listed"],
      asn: "AS64500",
    });

    expect(result.matched).toBe(false);
    expect(result.matches).toEqual([]);
  });

  test("another guild's list is not this one's", async () => {
    await addEntry(deps, {
      guildId: OTHER_GUILD,
      kind: "user_id",
      value: "777000111222333444",
      addedBy: OWNER,
      reason: null,
    });

    const result = await checkAccount(deps, GUILD, {
      userId: "777000111222333444",
      ipHashes: [],
      asn: null,
    });

    expect(result.matched).toBe(false);
  });
});

describe("a match is a signal, not a decision", () => {
  test("the result carries no decision field", async () => {
    const result = await checkAccount(deps, GUILD, {
      userId: USER,
      ipHashes: [],
      asn: null,
    });

    expect(Object.keys(result).sort()).toEqual(["guildId", "matched", "matches"]);
    for (const name of ["decision", "allowed", "denied", "blocked", "action", "refuse"]) {
      expect(name in result).toBe(false);
    }
  });

  test("the result type cannot grow a decision field", () => {
    // this only compiles while the result type carries none of these names. a
    // decision field would fail the constraint, so typecheck catches it.
    type DecisionKeys =
      | "decision"
      | "allowed"
      | "denied"
      | "blocked"
      | "action"
      | "refuse"
      | "shouldBlock";
    type AssertNever<T extends never> = T;
    type NoDecision = AssertNever<Extract<DecisionKeys, keyof BlacklistCheck>>;

    const noDecision: NoDecision[] = [];
    expect(noDecision).toEqual([]);
  });

  test("the service offers no way to refuse", () => {
    const names = Object.keys(blacklist);
    expect(names.filter((name) => /block|deny|refus|reject|ban/i.test(name))).toEqual([]);
  });
});
