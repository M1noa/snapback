import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS, type GuildSettings } from "../../../src/config/defaults.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import type { Logger } from "../../../src/lib/log.ts";
import { SETUP_OBJECT, type SetupDeps, type StepContext } from "../../../src/setup/deps.ts";
import { markStep, WIZARD_STEPS } from "../../../src/setup/state.ts";
import { finishStep, finishSummary } from "../../../src/setup/steps/finish.ts";

const GUILD = "200000000000000002";
const USER = "100000000000000001";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const ISO = "2026-10-16T12:00:00.000Z";
const INVITE = "https://discord.com/oauth2/authorize?client_id=300000000000000003&scope=bot";

const silent: Logger = {
  level: "error",
  debug() {},
  info() {},
  warn() {},
  error() {},
  async flush() {},
};

function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...patch } as GuildSettings;
}

function makeDeps(docs: string | null): SetupDeps {
  return {
    log: silent,
    now: () => NOW,
    state: new MemoryStateStore(),
    logs: async () => ({ posted: true, said: "test event posted", fix: null }),
    postPanel: async () => {},
    store: {
      read: async () => settings(),
      save: async () => ({ settings: settings(), changed: [] }),
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
      listening: async () => true,
    },
    privacy: { ipStorage: "hash", tokenStorage: false },
    app: {
      ownerId: USER,
      gatewayReady: true,
      gatewayPingMs: 10,
      memberIntent: true,
      devGuildId: undefined,
      application: async () => ({
        id: "300000000000000003",
        name: "snapback",
        botUserId: "400000000000000004",
        ownerId: USER,
        flags: 0,
        intents: 0,
      }),
      selfTest: async () => [],
    },
    portal: {
      items: async () => [],
      permissionBits: () => "0",
      invite: () => INVITE,
    },
    images: {
      current: async () => ({ displayName: null, avatarSet: false, bannerSet: false }),
      setAvatar: async () => {},
      setBanner: async () => {},
      setDisplayName: async () => {},
    },
    files: {
      read: async () => ({ bytes: new Uint8Array(), filename: "x.png", contentType: "image/png" }),
    },
    docs: async () => docs,
  };
}

function context(deps: SetupDeps, patch: Partial<GuildSettings> = {}): StepContext {
  const base = settings(patch);
  return { guildId: GUILD, userId: USER, settings: base, wizard: base.wizard, deps };
}

function bodyText(tree: ContainerComponent): string {
  return tree.components
    .filter((child) => child.type === 10)
    .map((child) => (child as { content: string }).content)
    .join("\n");
}

function collectIds(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  const node = value as {
    customID?: unknown;
    components?: unknown;
    accessory?: unknown;
    component?: unknown;
  };
  if (typeof node.customID === "string") out.push(node.customID);
  if (Array.isArray(node.components)) for (const child of node.components) collectIds(child, out);
  if (node.accessory !== undefined) collectIds(node.accessory, out);
  if (node.component !== undefined) collectIds(node.component, out);
  return out;
}

const COMMANDS_DOC = [
  "# Commands",
  "",
  "the slash command surface.",
  "",
  "| Subcommand | Does |",
  "|---|---|",
  "| `/setup` | opens the wizard |",
  "| `/setup status` | every subsystem |",
  "| `/backup create` | queues a backup |",
].join("\n");

describe("finishSummary", () => {
  test("lists what a fresh install still owes", () => {
    const lines = finishSummary(settings());
    expect(lines.length).toBe(8);
    expect(lines[0]).toContain("welcome");
  });

  test("is empty once every step is handled", () => {
    let wizard = settings().wizard;
    for (const step of WIZARD_STEPS) wizard = markStep(wizard, step.key, "done", { now: ISO });
    expect(finishSummary(settings({ wizard }))).toEqual([]);
  });
});

describe("finish render", () => {
  test("is a v2 container carrying the status word", async () => {
    const tree = await finishStep.render(context(makeDeps(COMMANDS_DOC)));
    expect(tree.type).toBe(17);
    expect((tree.components[0] as { content: string }).content).toContain("-# waiting");
  });

  test("shows the invite url, the docs pointer, and outstanding lines", async () => {
    const tree = await finishStep.render(context(makeDeps(COMMANDS_DOC)));
    const body = bodyText(tree);
    expect(body).toContain(INVITE);
    expect(body).toContain("docs/setup.md");
    expect(body).toContain("still outstanding:");
  });

  test("shows a command excerpt from the shipped docs", async () => {
    const tree = await finishStep.render(context(makeDeps(COMMANDS_DOC)));
    expect(bodyText(tree)).toContain("`/setup status`");
  });

  test("says the list is missing rather than inventing one", async () => {
    const tree = await finishStep.render(context(makeDeps(null)));
    const body = bodyText(tree);
    expect(body).toContain("not shipped in this build");
    expect(body).not.toContain("`/setup status`");
  });

  test("every produced customID parses with surface setup", async () => {
    const tree = await finishStep.render(context(makeDeps(COMMANDS_DOC)));
    const ids = collectIds(tree);
    expect(ids.length).toBe(1);
    const parsed = parseCustomId(ids[0]!);
    expect(parsed.surface).toBe("setup");
    expect(parsed.object).toBe(SETUP_OBJECT.step);
    expect(parsed.action).toBe("finish");
  });
});

describe("finish apply", () => {
  test("sets done_at and leaves the cursor on finish", async () => {
    const patch = await finishStep.apply?.(context(makeDeps(COMMANDS_DOC)), {});
    expect(patch?.wizard?.done_at).toBe(ISO);
    expect(patch?.wizard?.current).toBe("finish");
  });
});
