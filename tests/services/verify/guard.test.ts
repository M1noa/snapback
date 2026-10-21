// tests/services/verify/guard.test.ts - the two refusal rules. both default to
// off, the settings are read per call, and a refusal never names the account it
// matched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGuildSettings } from "../../../src/config/defaults.ts";
import { openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import { insertSignals } from "../../../src/db/queries/verify-signals.ts";
import type { Database, VerifySignalKind, VerifySignalRow } from "../../../src/db/types.ts";
import { createLogger } from "../../../src/lib/log.ts";
import type { IntelResult } from "../../../src/services/intel/index.ts";
import { type AltSignals, emailDigest } from "../../../src/services/verify/alt.ts";
import { decideVerification, type GuardDeps } from "../../../src/services/verify/guard.ts";

const GUILD = "144102483157850112";
const USER = "100000000000000001";
const OTHER = "100000000000000002";
const ADDRESS = "203.0.113.7";
const CLOCK = "2024-01-01T00:00:00.000Z";

let dir: string;
let db: Database;
let seq = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-verify-guard-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function intel(overrides: Partial<IntelResult> = {}): IntelResult {
  return {
    countryCode: "gb",
    countryName: "united kingdom",
    isp: "some isp",
    asn: "15169",
    asOrg: "some network",
    ipType: "residential",
    category: "isp",
    isHosting: false,
    isVpn: false,
    isProxy: false,
    isTor: false,
    isAnonymousProxy: false,
    evidence: "a residential network in the united kingdom",
    ...overrides,
  };
}

function signals(overrides: Partial<AltSignals> = {}): AltSignals {
  return { device: null, ip: null, email: null, avatar: null, name: null, ...overrides };
}

function deps(options: {
  settings?: Record<string, unknown>;
  result?: IntelResult | null;
  seen?: { address: string | null };
}): GuardDeps {
  const result = options.result === undefined ? intel() : options.result;
  return {
    db,
    log: createLogger({ level: "error", dir: null }),
    intel: {
      lookup: async (address) => {
        if (options.seen !== undefined) options.seen.address = address;
        return result;
      },
      reload: async () => {},
    },
    settings: async () => readGuildSettings(options.settings ?? {}),
  };
}

async function seed(userId: string, kind: VerifySignalKind, value: string): Promise<void> {
  seq += 1;
  const row: VerifySignalRow = {
    signal_id: `signal-${seq}`,
    guild_id: GUILD,
    user_id: userId,
    kind,
    value,
    created_at: CLOCK,
  };
  await insertSignals(db, [row]);
}

describe("the network rule", () => {
  test("a hosting network passes while the rule is off", async () => {
    const decision = await decideVerification(deps({ result: intel({ isHosting: true }) }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
  });

  test("a vpn is refused when the owner blocks them", async () => {
    const seen: { address: string | null } = { address: null };
    const decision = await decideVerification(
      deps({ settings: { verify_vpn_policy: "block" }, result: intel({ isVpn: true }), seen }),
      { guildId: GUILD, userId: USER, address: ADDRESS, signals: signals() },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("vpn");
    expect(decision.evidence).toBe("a residential network in the united kingdom");
    expect(seen.address).toBe(ADDRESS);
  });

  test("a tor exit is refused by the same rule", async () => {
    const decision = await decideVerification(
      deps({ settings: { verify_vpn_policy: "block" }, result: intel({ isTor: true }) }),
      { guildId: GUILD, userId: USER, address: ADDRESS, signals: signals() },
    );
    expect(decision.reason).toBe("vpn");
  });

  test("a clean network passes even with the rule on", async () => {
    const decision = await decideVerification(deps({ settings: { verify_vpn_policy: "block" } }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.intel?.asn).toBe("15169");
  });

  test("no address means no lookup and no refusal", async () => {
    const seen: { address: string | null } = { address: "untouched" };
    const decision = await decideVerification(
      deps({ settings: { verify_vpn_policy: "block" }, seen }),
      {
        guildId: GUILD,
        userId: USER,
        address: null,
        signals: signals(),
      },
    );
    expect(seen.address).toBe("untouched");
    expect(decision.intel).toBeNull();
    expect(decision.allowed).toBe(true);
    expect(decision.evidence).toBe("the intel files say nothing about this address");
  });
});

describe("the anti-alt rule", () => {
  test("nothing is looked up while the rule is off", async () => {
    await seed(OTHER, "device", "device-off");
    const decision = await decideVerification(deps({}), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals({ device: "device-off" }),
    });
    expect(decision.keepSignals).toBe(false);
    expect(decision.alt).toBeNull();
  });

  test("a matching device is flagged while the rule only flags", async () => {
    await seed(OTHER, "device", "device-flag");
    const decision = await decideVerification(deps({ settings: { verify_alt_policy: "flag" } }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals({ device: "device-flag" }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.keepSignals).toBe(true);
    expect(decision.alt?.userId).toBe(OTHER);
    expect(decision.alt?.label).toBe("high");
  });

  test("a matching device is refused when the owner blocks alts", async () => {
    await seed(OTHER, "device", "device-block");
    const decision = await decideVerification(deps({ settings: { verify_alt_policy: "block" } }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals({ device: "device-block" }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("alt");
    expect(decision.evidence).toBe("the same device as another account in this server");
    // the refusal says what matched, never who.
    expect(decision.evidence).not.toContain(OTHER);
  });

  test("a low match is not enough to refuse", async () => {
    await seed(OTHER, "name", "shared-name");
    const decision = await decideVerification(deps({ settings: { verify_alt_policy: "block" } }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals({ name: "shared-name" }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.alt).toBeNull();
  });

  test("a medium match is flagged but not refused", async () => {
    await seed(OTHER, "ip", "ip-shared");
    const decision = await decideVerification(deps({ settings: { verify_alt_policy: "block" } }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals({ ip: "ip-shared" }),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.alt?.label).toBe("medium");
    expect(decision.evidence).toBe("the same ip as another account in this server");
  });

  test("an anonymous email is not a signal at all", async () => {
    const decision = await decideVerification(deps({ settings: { verify_alt_policy: "block" } }), {
      guildId: GUILD,
      userId: USER,
      address: ADDRESS,
      signals: signals({ email: emailDigest(null) }),
    });
    expect(decision.alt).toBeNull();
    expect(decision.allowed).toBe(true);
  });

  test("without a guild there is nothing to compare against", async () => {
    await seed(OTHER, "device", "device-noguild");
    const decision = await decideVerification(deps({ settings: { verify_alt_policy: "block" } }), {
      guildId: "",
      userId: USER,
      address: ADDRESS,
      signals: signals({ device: "device-noguild" }),
    });
    expect(decision.alt).toBeNull();
    expect(decision.allowed).toBe(true);
  });
});
