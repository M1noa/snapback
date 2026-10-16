import { describe, expect, test } from "bun:test";
import {
  createDiagnosticsProbes,
  createStatusProbe,
  type DiagnosticsDeps,
  type ProbeDeps,
} from "../../src/boot/probes.ts";
import type { Database } from "../../src/db/types.ts";
import type { ProbeResult } from "../../src/discord/commands/system/diagnostics.ts";

// a database that answers the two status queries and nothing else. typed loosely
// on purpose: the probe reads through db/queries/, which is tested against real
// duckdb in tests/db.
function stubDatabase(rows: Record<string, unknown[]>): Database {
  return {
    kind: "duckdb",
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM jobs")) return (rows.jobs ?? []) as T[];
      if (sql.includes("FROM guilds")) return (rows.guilds ?? []) as T[];
      if (sql.includes("FROM meta")) return (rows.meta ?? []) as T[];
      throw new Error(`unexpected query: ${sql}`);
    },
    async run() {},
    async exec() {},
    async close() {},
  };
}

const STATUS: ProbeDeps = {
  db: () => Promise.resolve(stubDatabase({})),
  version: "0.0.0",
  oceanicVersion: "1.15.0",
  startedAt: 1_000,
  schemaVersion: 1,
  gateway: () => ({ ready: true, ping: 42 }),
  rateLimitBuckets: () => 3,
  dbBytesPath: null,
  dbDriver: "duckdb",
  commit: null,
};

describe("createStatusProbe", () => {
  test("counts queued and running jobs separately", async () => {
    const probe = createStatusProbe({
      ...STATUS,
      db: () =>
        Promise.resolve(
          stubDatabase({
            jobs: [
              { status: "queued" },
              { status: "queued" },
              { status: "running" },
              { status: "paused" },
            ],
            guilds: [{ guild_id: "1" }, { guild_id: "2" }],
          }),
        ),
    });

    const snapshot = await probe();
    expect(snapshot.jobDepth).toBe(2);
    expect(snapshot.jobRunning).toBe(1);
    expect(snapshot.trackedGuilds).toBe(2);
  });

  test("carries the gateway, limiter, and version through", async () => {
    const snapshot = await createStatusProbe(STATUS)();
    expect(snapshot.gatewayReady).toBe(true);
    expect(snapshot.gatewayLatencyMs).toBe(42);
    expect(snapshot.rateLimitBuckets).toBe(3);
    expect(snapshot.version).toBe("0.0.0");
    expect(snapshot.commit).toBeNull();
  });

  test("no db file to measure is null, not zero", async () => {
    const snapshot = await createStatusProbe(STATUS)();
    expect(snapshot.dbBytes).toBeNull();
  });
});

function diagnostics(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    ...STATUS,
    intelFiles: { countryMmdb: "/nonexistent/country.mmdb", asCsv: "/nonexistent/as.csv" },
    intelEnabled: true,
    tokenStorage: true,
    commandCount: () => 1,
    handlerKeys: [],
    ...overrides,
  };
}

function probeNamed(probes: ReturnType<typeof createDiagnosticsProbes>, name: string) {
  const probe = probes.find((entry) => entry.name === name);
  if (probe === undefined) throw new Error(`no probe named ${name}`);
  return probe;
}

describe("createDiagnosticsProbes", () => {
  test("reports the schema version when the database answers", async () => {
    const probes = createDiagnosticsProbes(
      diagnostics({ db: () => Promise.resolve(stubDatabase({ meta: [{ value: "1" }] })) }),
    );
    const result = (await probeNamed(probes, "database").run()) as ProbeResult;

    expect(result.state).toBe("ok");
    expect(result.detail).toContain("schema v1");
  });

  test("a database that throws is a failed line, not a failed page", async () => {
    const probes = createDiagnosticsProbes(
      diagnostics({
        db: () => {
          throw new Error("SB_DB_LOCKED: could not set lock on file");
        },
      }),
    );
    const result = (await probeNamed(probes, "database").run()) as ProbeResult;

    expect(result.state).toBe("fail");
    expect(result.detail).toContain("SB_DB_LOCKED");
  });

  test("a connected gateway is ok, a missing one is not", async () => {
    const up = await probeNamed(createDiagnosticsProbes(diagnostics()), "gateway").run();
    expect(up.state).toBe("ok");

    const down = await probeNamed(
      createDiagnosticsProbes(diagnostics({ gateway: () => ({ ready: false, ping: null }) })),
      "gateway",
    ).run();
    expect(down.state).toBe("fail");
  });

  test("a missing geo file warns and says geo is skipped", async () => {
    const result = await probeNamed(createDiagnosticsProbes(diagnostics()), "geo data").run();
    expect(result.state).toBe("warn");
    expect(result.detail).toContain("skipped");
  });

  test("geo files are not checked when intel is off", async () => {
    const result = await probeNamed(
      createDiagnosticsProbes(diagnostics({ intelEnabled: false })),
      "geo data",
    ).run();
    expect(result.state).toBe("ok");
  });

  test("token storage without a key warns rather than fails", async () => {
    const result = await probeNamed(
      createDiagnosticsProbes(diagnostics({ tokenStorage: false })),
      "token storage",
    ).run();
    expect(result.state).toBe("warn");
  });

  test("the surfaces line counts commands and lists handlers", async () => {
    const result = await probeNamed(
      createDiagnosticsProbes(diagnostics({ commandCount: () => 4, handlerKeys: ["setup:save"] })),
      "surfaces",
    ).run();
    expect(result.detail).toContain("4 command(s)");
    expect(result.detail).toContain("setup:save");
  });

  test("every probe is named, and names are unique", () => {
    const probes = createDiagnosticsProbes(diagnostics());
    const names = probes.map((probe) => probe.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });
});
