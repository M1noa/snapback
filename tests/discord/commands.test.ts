import { describe, expect, test } from "bun:test";
import type { ContainerComponent, TextDisplayComponent } from "oceanic.js";
import { buildDefinitions, GROUP_DESCRIPTIONS } from "../../src/discord/commands/index.ts";
import { diagnosticsCommand, type Probe } from "../../src/discord/commands/system/diagnostics.ts";
import { type StatusSnapshot, statusCommand } from "../../src/discord/commands/system/status.ts";
import type { SlashCommand } from "../../src/discord/commands/types.ts";
import { countComponents } from "../../src/discord/components/page.ts";

const ctx = { guildId: "1", userId: "2", options: {} };

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    version: "9.9.9",
    commit: "abc1234",
    oceanicVersion: "1.15.0",
    schemaVersion: 1,
    startedAt: Date.now() - 3 * 3600 * 1000,
    gatewayReady: true,
    gatewayLatencyMs: 42,
    jobDepth: 3,
    jobRunning: 1,
    dbDriver: "duckdb",
    dbBytes: 1024 * 1024 * 13.4,
    trackedGuilds: 5,
    rateLimitBuckets: 2,
    ...overrides,
  };
}

// the page is a plain object tree; pull the text out of it to assert on content.
function textOf(page: ContainerComponent): string {
  return page.components
    .filter((child): child is TextDisplayComponent => child.type === 10)
    .map((child) => child.content)
    .join("\n");
}

describe("statusCommand", () => {
  test("reports every field D4PLAN 8 lists", async () => {
    const result = await statusCommand(() => snapshot()).run(ctx);
    const text = textOf(result.page);
    expect(text).toContain("9.9.9");
    expect(text).toContain("1.15.0");
    expect(text).toContain("v1");
    expect(text).toContain("42 ms");
    expect(text).toContain("3 waiting, 1 running");
    expect(text).toContain("duckdb");
    expect(text).toContain("13.4 MiB");
    expect(text).toContain("5");
  });

  test("uptime is a duration and a discord relative timestamp", async () => {
    const result = await statusCommand(() => snapshot()).run(ctx);
    const text = textOf(result.page);
    expect(text).toContain("3h");
    expect(text).toMatch(/<t:\d+:R>/);
  });

  test("a connected gateway is success", async () => {
    const result = await statusCommand(() => snapshot()).run(ctx);
    expect(result.page.accentColor).toBe(0x57f287);
  });

  test("a down gateway is warning, not a failure", async () => {
    const result = await statusCommand(() =>
      snapshot({ gatewayReady: false, gatewayLatencyMs: null }),
    ).run(ctx);
    expect(result.page.accentColor).toBe(0xfee75c);
    expect(textOf(result.page)).toContain("not connected");
  });

  test("replies ephemerally: it is an operator record", async () => {
    const result = await statusCommand(() => snapshot()).run(ctx);
    expect(result.ephemeral).toBe(true);
  });

  test("the page stays inside the 40 component cap", async () => {
    const result = await statusCommand(() => snapshot()).run(ctx);
    expect(countComponents(result.page)).toBeLessThanOrEqual(40);
  });
});

describe("diagnosticsCommand", () => {
  test("all probes ok is success and says so", async () => {
    const probes: Probe[] = [
      { name: "database", run: () => ({ name: "database", state: "ok", detail: "reachable" }) },
      { name: "disk", run: () => ({ name: "disk", state: "ok", detail: "4 GiB free" }) },
    ];
    const result = await diagnosticsCommand(probes).run(ctx);
    expect(result.page.accentColor).toBe(0x57f287);
    expect(textOf(result.page)).toContain("all 2 checks passed");
  });

  test("a failure is danger and counts the rest", async () => {
    const probes: Probe[] = [
      { name: "database", run: () => ({ name: "database", state: "ok", detail: "reachable" }) },
      { name: "gateway", run: () => ({ name: "gateway", state: "fail", detail: "4004" }) },
      { name: "disk", run: () => ({ name: "disk", state: "warn", detail: "400 MiB free" }) },
    ];
    const result = await diagnosticsCommand(probes).run(ctx);
    expect(result.page.accentColor).toBe(0xed4245);
    expect(textOf(result.page)).toContain("1 failed, 1 warned, 1 ok");
  });

  test("a warning with no failure is warning", async () => {
    const probes: Probe[] = [
      { name: "disk", run: () => ({ name: "disk", state: "warn", detail: "low" }) },
    ];
    const result = await diagnosticsCommand(probes).run(ctx);
    expect(result.page.accentColor).toBe(0xfee75c);
  });

  test("a throwing probe becomes a failed line, not a failed page", async () => {
    const probes: Probe[] = [
      {
        name: "database",
        run: () => {
          throw new Error("SB_DB_LOCKED: the database file is locked");
        },
      },
      { name: "disk", run: () => ({ name: "disk", state: "ok", detail: "fine" }) },
    ];
    const result = await diagnosticsCommand(probes).run(ctx);
    expect(result.page.accentColor).toBe(0xed4245);
    const text = textOf(result.page);
    // the probe's own words, kept verbatim
    expect(text).toContain("SB_DB_LOCKED: the database file is locked");
    expect(text).toContain("disk: fine");
  });

  test("the report is in a fenced block so discord gives a copy button", async () => {
    const probes: Probe[] = [
      { name: "db", run: () => ({ name: "db", state: "ok", detail: "ok" }) },
    ];
    const result = await diagnosticsCommand(probes).run(ctx);
    const text = textOf(result.page);
    expect(text).toContain("```");
    expect(text).toContain("ok    db: ok");
  });

  test("the page stays inside the 40 component cap", async () => {
    const probes: Probe[] = Array.from({ length: 30 }, (_, i) => ({
      name: `probe${i}`,
      run: () => ({ name: `probe${i}`, state: "ok" as const, detail: "fine" }),
    }));
    const result = await diagnosticsCommand(probes).run(ctx);
    expect(countComponents(result.page)).toBeLessThanOrEqual(40);
  });
});

describe("buildDefinitions", () => {
  const a: SlashCommand = {
    group: "snapback",
    subcommand: "status",
    description: "status",
    run: () => {
      throw new Error("unused");
    },
  };
  const b: SlashCommand = {
    group: "snapback",
    subcommand: "diagnostics",
    description: "diagnostics",
    run: () => {
      throw new Error("unused");
    },
  };

  test("two entries with one group merge into a single command", () => {
    const definitions = buildDefinitions([a, b]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe("snapback");
  });

  test("the merged command carries one subcommand option per entry", () => {
    const [definition] = buildDefinitions([b, a]);
    expect(definition?.options?.map((option) => option.name).sort()).toEqual([
      "diagnostics",
      "status",
    ]);
    expect(definition?.options?.every((option) => option.type === 1)).toBe(true);
  });

  test("default_member_permissions is never set, so commands stay visible", () => {
    const [definition] = buildDefinitions([a, b]);
    expect(definition).not.toHaveProperty("default_member_permissions");
    expect(definition).not.toHaveProperty("defaultMemberPermissions");
  });

  test("a group with no description is a bug, not a guess", () => {
    const orphan: SlashCommand = {
      group: "not-in-the-map",
      subcommand: "thing",
      description: "x",
      run: () => {
        throw new Error("unused");
      },
    };
    expect(() => buildDefinitions([orphan])).toThrow(/no group description/);
  });

  test("mixing a subcommand with a bare entry for one group is refused", () => {
    const bare: SlashCommand = {
      group: "snapback",
      description: "x",
      run: () => {
        throw new Error("unused");
      },
    };
    expect(() => buildDefinitions([a, bare])).toThrow(/mixes subcommands/);
  });

  test("every group in the map is a real group name", () => {
    for (const name of Object.keys(GROUP_DESCRIPTIONS)) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });
});
