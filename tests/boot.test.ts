import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createDiagnosticsProbes,
  createStatusProbe,
  type DiagnosticsDeps,
} from "../src/boot/probes.ts";
import { DEFAULT_GUILD_SETTINGS } from "../src/config/defaults.ts";
import type { Database } from "../src/db/types.ts";
import {
  buildDefinitions,
  diagnosticsCommand,
  statusCommand,
} from "../src/discord/commands/index.ts";
import { setupCommands } from "../src/discord/commands/setup/index.ts";
import { Router } from "../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../src/discord/interactions/state.ts";
import { createLogger } from "../src/lib/log.ts";
import type { SetupDeps } from "../src/setup/deps.ts";
import { registerSetupHandlers, SETUP_SPECS } from "../src/setup/handlers.ts";

// boots the real entry point in a child process with a hand-built environment.
// this is the only way to cover the exit-on-missing-key path, and it is the
// phase 1 acceptance check: a fresh checkout starts or says exactly why not.
//
// the config cases pass --print-config: a real boot opens the database and dials
// the gateway, which needs a live token and should not happen in a test run.
const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;
const PRINT_CONFIG = ["--print-config"];

async function boot(
  env: Record<string, string>,
  args: readonly string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  // cwd off in a temp dir so a developer's real .env beside the checkout is
  // never loaded by the child: the fixture env alone is what this tests
  const cwd = mkdtempSync(`${tmpdir()}/snapback-boot-`);
  const child = Bun.spawn({
    cmd: [process.execPath, ENTRY, ...args],
    env,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out, err };
}

const MINIMAL = {
  DISCORD_TOKEN: "test-token",
  DISCORD_OWNER_ID: "100000000000000001",
  DISCORD_CLIENT_ID: "100000000000000002",
  PUBLIC_BASE_URL: "https://snapback.example",
  OAUTH_CLIENT_SECRET: "test-secret",
  IP_STORAGE: "hash",
  IP_HASH_PEPPER: "pepper",
};

describe("boot", () => {
  test("prints the resolved config and stops at the flag", async () => {
    const { code, out } = await boot(MINIMAL, PRINT_CONFIG);

    expect(code).toBe(0);
    // the version comes from the package, so the release bump does not break
    // this test.
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version?: string;
    };
    expect(out).toContain(`snapback ${manifest.version ?? ""}`);
    expect(out).toContain("./data/snapback.duckdb");
    expect(out).toContain("https://snapback.example on :8080");
    expect(out).toContain("ip        hash");
    expect(out).toContain("tokens    storage unavailable");
    expect(out).toContain("100000000000000001");
  });

  test("refuses to start without a token and lists what is missing", async () => {
    const { code, err } = await boot({ PUBLIC_BASE_URL: "https://snapback.example" });

    expect(code).toBe(1);
    expect(err).toContain("cannot start");
    expect(err).toContain("1. DISCORD_TOKEN is not set");
    expect(err).toContain("2. DISCORD_OWNER_ID is not set");
    expect(err).toContain("3. DISCORD_CLIENT_ID is not set");
    expect(err).toContain("4. OAUTH_CLIENT_SECRET is not set");
  });

  test("reports a warning on stderr without failing", async () => {
    const { code, err } = await boot({ ...MINIMAL, IP_STORAGE: "plaintext" }, PRINT_CONFIG);

    expect(code).toBe(0);
    expect(err).toContain("personal data");
  });
});

// src/boot.ts builds the setup surface, registers it on the router, then asserts
// every produced id has a handler. that path needs a database, a rest client, and
// a gateway, so it cannot run here without a token. this rebuilds the exact same
// composition over a router, in the order boot does it, and asserts what the boot
// assertion exists to catch: a produced id with no handler, and a command group
// with no description.

const OWNER = "200000000000000002";

// a database that answers nothing. nothing in this composition queries it.
function stubDatabase(): Database {
  return {
    kind: "duckdb",
    async query<T>(): Promise<T[]> {
      return [];
    },
    async run() {},
    async exec() {},
    async close() {},
  };
}

// a stand-in for createSetupDeps(): the real one opens a client and a gateway,
// which this test cannot have. registration only closes over these, so empty
// fakes prove the wiring without exercising a handler.
function fakeSetupDeps(): SetupDeps {
  return {
    log: createLogger({ level: "error", dir: null }),
    now: () => 0,
    store: {
      read: async () => DEFAULT_GUILD_SETTINGS,
      save: async () => ({ settings: DEFAULT_GUILD_SETTINGS, changed: [] }),
    },
    admins: {
      list: async () => [],
      add: async () => {},
      remove: async () => {},
      setFlag: async () => {},
    },
    web: {
      publicBaseUrl: "https://snapback.example",
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      listening: async () => false,
    },
    privacy: { ipStorage: "hash", tokenStorage: false },
    app: {
      ownerId: OWNER,
      gatewayReady: false,
      gatewayPingMs: null,
      memberIntent: false,
      devGuildId: undefined,
      application: async () => ({
        id: null,
        name: null,
        botUserId: null,
        ownerId: OWNER,
        flags: 0,
        intents: 0,
      }),
      selfTest: async () => [],
    },
    portal: {
      items: async () => [],
      permissionBits: () => "0",
      invite: () => "https://discord.com/oauth2/authorize",
    },
    images: {
      current: async () => ({ displayName: null, avatarSet: false, bannerSet: false }),
      setAvatar: async () => {},
      setBanner: async () => {},
      setDisplayName: async () => {},
    },
    files: { read: async () => ({ bytes: new Uint8Array(), filename: "", contentType: "" }) },
    docs: async () => null,
    state: new MemoryStateStore(),
    logs: async () => ({ posted: false, said: "", fix: null }),
    postPanel: async () => {},
  };
}

// the router boot builds, then the setup registration, in boot's order: register
// the whole surface, then assert every produced id is handled.
function bootRouter(): Router {
  const router = new Router({ authorize: () => ({ kind: "allow" }) });
  registerSetupHandlers(router, fakeSetupDeps());
  return router;
}

describe("the boot composition", () => {
  test("every produced setup id has a handler, and a gap fails the boot", () => {
    const router = bootRouter();

    expect(SETUP_SPECS.length).toBeGreaterThan(0);
    expect(() => router.assertComplete(SETUP_SPECS)).not.toThrow();

    // a control shipped without a handler is exactly what the boot refuses on.
    expect(() =>
      router.assertComplete([...SETUP_SPECS, { surface: "setup", action: "ghost" }]),
    ).toThrow();
  });

  test("registered setup keys and SETUP_SPECS agree in both directions", () => {
    const router = bootRouter();

    const registered = router
      .registeredKeys()
      .filter((key) => key.startsWith("setup:"))
      .map((key) => key.slice("setup:".length))
      .sort();
    const fromSpecs = [
      ...new Set(SETUP_SPECS.filter((spec) => spec.surface === "setup").map((spec) => spec.action)),
    ].sort();

    expect(registered).toEqual(fromSpecs);
  });

  test("the command list builds, so the setup group has a description", () => {
    const probes: DiagnosticsDeps = {
      db: () => Promise.resolve(stubDatabase()),
      version: "0.0.0",
      oceanicVersion: "1.15.0",
      startedAt: 0,
      schemaVersion: 1,
      gateway: () => ({ ready: false, ping: null }),
      rateLimitBuckets: () => 0,
      dbBytesPath: null,
      dbDriver: "duckdb",
      commit: null,
      intelFiles: { countryMmdb: "", asCsv: "" },
      intelEnabled: false,
      tokenStorage: false,
      commandCount: () => 0,
      handlerKeys: [],
    };

    // the same list src/boot.ts assembles: the two system commands and the whole
    // /setup group. buildDefinitions throws when a group has no description, so
    // this passing is what proves GROUP_DESCRIPTIONS.setup landed.
    const commands = [
      statusCommand(createStatusProbe(probes)),
      diagnosticsCommand(createDiagnosticsProbes(probes)),
      ...setupCommands(fakeSetupDeps()),
    ];
    const definitions = buildDefinitions(commands);

    const setup = definitions.find((definition) => definition.name === "setup");
    expect(setup).toBeDefined();
    expect(setup?.options?.length).toBeGreaterThan(0);
  });
});
