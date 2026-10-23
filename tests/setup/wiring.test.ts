// tests/setup/wiring.test.ts - the wiring is the only place /setup touches a db, a
// socket, or env, so this is where the integration is proven: a real duckdb file
// in a temp dir, a real offline gateway, and a fetch that refuses to leave the
// machine. no .env is read (createSetupDeps goes through parse-env) and no file
// outside the temp dir is written.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { DEFAULT_GUILD_SETTINGS, DEFAULT_VERIFY_PANEL, LIMITS } from "../../src/config/defaults.ts";
import * as auditDb from "../../src/db/queries/audit.ts";
import type { AuditLogRow, Database, SqlParam } from "../../src/db/types.ts";
import { DiscordClient } from "../../src/discord/client.ts";
import { Gateway } from "../../src/discord/gateway.ts";
import { type Clock, RateLimiter } from "../../src/discord/ratelimit.ts";
import { createLogger } from "../../src/lib/log.ts";
import type { SetupDeps } from "../../src/setup/deps.ts";
import { createSetupDeps } from "../../src/setup/wiring.ts";

const SCHEMA = new URL("../../src/db/schema.sql", import.meta.url);
const OWNER = "111111111111111111";
const GUILD_A = "222222222222222222";
const GUILD_B = "333333333333333333";
const GUILD_C = "444444444444444444";
const CHANNEL = "555555555555555555";

// createSetupDeps validates env in-process and throws instead of exiting. bun
// auto-loads the developer's real .env into process.env, so every snapback key
// is cleared first: the test's env is exactly these values, and nothing on disk
// is touched.
const ENV_KEYS = [
  "DISCORD_TOKEN",
  "DISCORD_OWNER_ID",
  "DISCORD_CLIENT_ID",
  "OAUTH_CLIENT_SECRET",
  "DATABASE_URL",
  "PUBLIC_BASE_URL",
  "PORT",
  "IP_STORAGE",
  "IP_HASH_PEPPER",
  "ENCRYPTION_KEY",
  "BEHIND_CLOUDFLARE_TUNNEL",
  "TRUSTED_PROXY_DEPTH",
  "DBIP_COUNTRY_MMDB",
  "AS_METADATA_CSV",
  "INTEL_ENABLED",
  "MAX_MESSAGES_PER_CHANNEL",
  "MAX_MESSAGES_TOTAL",
  "MAX_CONCURRENT_JOBS",
  "PULL_DAILY_LIMIT_PER_ACCOUNT",
  "PULL_COOLDOWN_HOURS",
  "PULL_FAILURE_COOLDOWN_MINUTES",
  "BACKUP_DIR",
  "EXPORT_DIR",
  "MAX_ASSET_BYTES",
  "LOG_LEVEL",
  "AUTOMATION_ENABLED",
  "DISCORD_DEV_GUILD_ID",
] as const;
for (const key of ENV_KEYS) delete process.env[key];
process.env.DISCORD_TOKEN = "test-token";
process.env.DISCORD_OWNER_ID = OWNER;
process.env.DISCORD_CLIENT_ID = "100000000000000003";
process.env.OAUTH_CLIENT_SECRET = "test-secret";
process.env.PUBLIC_BASE_URL = "https://verify.example";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "snapback-wiring-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeClock implements Clock {
  #now = 1_700_000_000_000;
  async sleep(ms: number): Promise<void> {
    this.#now += ms;
  }
  now(): number {
    return this.#now;
  }
}

// the adapter duckdb's connection needs to look like src/db's Database.
function adapter(connection: DuckDBConnection): Database {
  return {
    kind: "duckdb",
    async query<T>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const reader = await connection.runAndReadAll(sql, params as never);
      return reader.getRowObjectsJS() as unknown as T[];
    },
    async run(sql: string, params?: SqlParam[]): Promise<void> {
      await connection.run(sql, params as never);
    },
    async exec(script: string): Promise<void> {
      await connection.run(script);
    },
    async close(): Promise<void> {
      connection.closeSync();
    },
  };
}

interface Handle {
  readonly db: Database;
  close(): void;
}

// a fresh handle on the one temp database. close is idempotent so a test that
// reopens mid-flight can close in a finally without double-closing duckdb.
async function openHandle(): Promise<Handle> {
  const instance = await DuckDBInstance.create(join(dir, "wiring.duckdb"));
  const connection = await instance.connect();
  await connection.run(await Bun.file(SCHEMA).text());
  let done = false;
  return {
    db: adapter(connection),
    close(): void {
      if (done) return;
      done = true;
      connection.closeSync();
      instance.closeSync();
    },
  };
}

interface Net {
  readonly fetch: typeof fetch;
  readonly calls: string[];
}

// every test's client refuses to leave the machine. a call that reaches this is a
// bug in the code under test, so the rejection names the url.
function offline(): Net {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    throw new Error(`unexpected network call to ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

// the one endpoint this file mocks, recorded so the request shape can be asserted.
function recording(body: string, status = 200): Net & { recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    recorded.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: impl, calls, recorded };
}

function makeDeps(
  db: Database,
  net: Net,
  settingsSaved?: (guildId: string) => void | Promise<void>,
): SetupDeps {
  // level error + dir null: the test never writes a log file.
  const log = createLogger({ level: "error", dir: null });
  const client = new DiscordClient({
    token: "test-token",
    fetchImpl: net.fetch,
    limiter: new RateLimiter({ clock: new FakeClock() }),
    log,
  });
  // constructing the gateway is offline: it builds oceanic's Client and connects
  // only on connect(), which no test here calls.
  const gateway = new Gateway({ token: "test-token", log });
  return createSetupDeps({ db, client, gateway, log, ownerId: OWNER, settingsSaved });
}

describe("setup wiring: the settings store", () => {
  test("reads defaults, saves, audits once, and a new wiring sees the row", async () => {
    const net = offline();
    let handle = await openHandle();
    try {
      const first = makeDeps(handle.db, net);

      const before = await first.store.read(GUILD_A);
      expect(before).toEqual(DEFAULT_GUILD_SETTINGS);
      expect(before.log_channel_id).toBeNull();

      const saved = await first.store.save({
        guildId: GUILD_A,
        actorUserId: OWNER,
        action: "setup.logs",
        patch: { log_channel_id: CHANNEL, log_events: ["backup", "restore"] },
      });
      expect(saved.settings.log_channel_id).toBe(CHANNEL);
      expect([...saved.changed].sort()).toEqual(["log_channel_id", "log_events"]);

      const rows: AuditLogRow[] = await auditDb.listAuditByGuild(handle.db, GUILD_A);
      expect(rows.length).toBe(1);
      expect(rows[0]?.action).toBe("setup.logs");
      expect(rows[0]?.actor_user_id).toBe(OWNER);
      expect(rows[0]?.guild_id).toBe(GUILD_A);

      // a genuinely separate wiring over the same file: nothing is cached in memory.
      handle.close();
      handle = await openHandle();
      const second = makeDeps(handle.db, net);
      const after = await second.store.read(GUILD_A);
      expect(after.log_channel_id).toBe(CHANNEL);
      expect(after.log_events).toEqual(["backup", "restore"]);

      expect(net.calls).toEqual([]); // a settings save is a db write, not a request
    } finally {
      handle.close();
    }
  });

  test("tells the caller that settings moved, once per save", async () => {
    const net = offline();
    const handle = await openHandle();
    try {
      const seen: string[] = [];
      const deps = makeDeps(handle.db, net, (guildId) => {
        seen.push(guildId);
      });

      await deps.store.save({
        guildId: GUILD_A,
        actorUserId: OWNER,
        action: "setup.logs",
        patch: {},
      });
      await deps.store.save({
        guildId: GUILD_B,
        actorUserId: OWNER,
        action: "setup.tracking",
        patch: { tracking: { history: false, palantir: false, keep_days: 30 } },
      });
      expect(seen).toEqual([GUILD_A, GUILD_B]);
    } finally {
      handle.close();
    }
  });

  test("a throwing listener does not fail a save that already landed", async () => {
    const net = offline();
    const handle = await openHandle();
    try {
      const deps = makeDeps(handle.db, net, () => {
        throw new Error("cache is down");
      });

      // the row is written before the cache is told, so a broken cache must not
      // turn a durable save into a failure the operator has to retry.
      const saved = await deps.store.save({
        guildId: GUILD_A,
        actorUserId: OWNER,
        action: "setup.logs",
        patch: { log_channel_id: CHANNEL },
      });
      expect(saved.settings.log_channel_id).toBe(CHANNEL);

      const rows: AuditLogRow[] = await auditDb.listAuditByGuild(handle.db, GUILD_A);
      expect(rows.length).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("clamps an out-of-range number and normalises a colour", async () => {
    const net = offline();
    const handle = await openHandle();
    try {
      const deps = makeDeps(handle.db, net);

      const clamped = await deps.store.save({
        guildId: GUILD_B,
        actorUserId: OWNER,
        action: "setup.backup",
        patch: { auto_backup_interval_hours: 9999 },
      });
      expect(clamped.settings.auto_backup_interval_hours).toBe(
        LIMITS.auto_backup_interval_hours.max,
      );

      const bare = await deps.store.save({
        guildId: GUILD_B,
        actorUserId: OWNER,
        action: "setup.verify",
        patch: { verify_panel: { ...DEFAULT_VERIFY_PANEL, colour: "ABCDEF" } },
      });
      expect(bare.settings.verify_panel?.colour).toBe("#abcdef"); // normalised, not rejected

      const bad = await deps.store.save({
        guildId: GUILD_B,
        actorUserId: OWNER,
        action: "setup.verify",
        patch: { verify_panel: { ...DEFAULT_VERIFY_PANEL, colour: "not-a-colour" } },
      });
      expect(bad.settings.verify_panel?.colour).toBe(DEFAULT_VERIFY_PANEL.colour); // falls back
    } finally {
      handle.close();
    }
  });
});

describe("setup wiring: the edges", () => {
  test("files.read refuses a non-cdn url without a request", async () => {
    const net = offline();
    const handle = await openHandle();
    try {
      const deps = makeDeps(handle.db, net);
      await expect(deps.files.read("https://example.com/evil.png")).rejects.toThrow(
        "SB_SETUP_FILE_HOST",
      );
      expect(net.calls).toEqual([]);
    } finally {
      handle.close();
    }
  });

  test("docs returns null for a missing guide and text for a shipped one", async () => {
    const net = offline();
    const handle = await openHandle();
    try {
      const deps = makeDeps(handle.db, net);
      expect(await deps.docs("no-such-guide")).toBeNull();
      // a name is a slug, never a path: nothing resolves outside docs/.
      expect(await deps.docs("../../etc/passwd")).toBeNull();

      const setup = await deps.docs("setup");
      expect(setup).not.toBeNull();
      expect(setup ?? "").toContain("#");
    } finally {
      handle.close();
    }
  });

  test("logs with no channel reports a fix and never throws", async () => {
    const net = offline();
    const handle = await openHandle();
    try {
      const deps = makeDeps(handle.db, net);
      const result = await deps.logs(GUILD_C);
      expect(result.posted).toBe(false);
      expect(result.said.length).toBeGreaterThan(0);
      expect(result.fix).toContain("/setup logs");
      expect(net.calls).toEqual([]);
    } finally {
      handle.close();
    }
  });

  test("app.application maps the payload and takes its intents from the gateway", async () => {
    const payload = JSON.stringify({
      id: "999999999999999999",
      name: "snapback v2",
      flags: 565248,
      bot: { id: "888888888888888888" },
      owner: { id: OWNER },
    });
    const net = recording(payload);
    const handle = await openHandle();
    try {
      const deps = makeDeps(handle.db, net);
      const app = await deps.app.application();

      expect(net.recorded.length).toBe(1);
      expect(net.recorded[0]?.url).toBe("https://discord.com/api/v10/applications/@me");
      expect(net.recorded[0]?.method).toBe("GET");

      expect(app.id).toBe("999999999999999999");
      expect(app.name).toBe("snapback v2");
      expect(app.botUserId).toBe("888888888888888888");
      expect(app.ownerId).toBe(OWNER);
      expect(app.flags).toBe(565248);
      // the intents come from the gateway the boot path built, not from a config
      // read: GUILD_MEMBERS is bit 1, and GATEWAY_INTENTS requests it.
      expect(deps.app.memberIntent).toBe(true);
      expect(app.intents & 2).toBe(2);
      expect(app.intents).toBeGreaterThan(0);
      expect(deps.app.gatewayReady).toBe(false); // offline gateway
      expect(deps.app.gatewayPingMs).toBeNull();
    } finally {
      handle.close();
    }
  });
});
