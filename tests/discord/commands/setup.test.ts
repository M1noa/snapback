// /setup's command surface: the subcommand list, the pages it answers with, and
// the hand-over every step subcommand goes through.

import { describe, expect, test } from "bun:test";
import { ComponentTypes } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  type GuildSettings,
  type WizardState,
} from "../../../src/config/defaults.ts";
import { buildDefinitions } from "../../../src/discord/commands/index.ts";
import { setupCommands } from "../../../src/discord/commands/setup/index.ts";
import type { CommandContext, SlashCommand } from "../../../src/discord/commands/types.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { OPTION_TYPE } from "../../../src/discord/registry.ts";
import { createLogger } from "../../../src/lib/log.ts";
import type { SaveInput, SettingsStore, SetupDeps } from "../../../src/setup/deps.ts";
import { GUIDE_DOCS } from "../../../src/setup/guide.ts";
import { WIZARD_STEP_KEYS } from "../../../src/setup/state.ts";

const GUILD = "123456789012345678";
const OPENER = "987654321098765432";
const OTHER = "555555555555555555";
const OWNER = "111111111111111111";

// the wizard steps that carry their own subcommand, in the wizard's own order.
const STEP_SUBCOMMANDS = [
  "app",
  "web",
  "branding",
  "admins",
  "logs",
  "backup",
  "restore",
  "verify",
];

// ---- fixtures (the shape tests/setup/handlers.test.ts uses) ----------------

interface Recorder extends SettingsStore {
  readonly saves: SaveInput[];
  current: GuildSettings;
}

function fakeStore(settings: GuildSettings = DEFAULT_GUILD_SETTINGS): Recorder {
  const recorder: Recorder = {
    saves: [],
    current: settings,
    async read(): Promise<GuildSettings> {
      return recorder.current;
    },
    async save(input: SaveInput) {
      recorder.saves.push(input);
      recorder.current = { ...recorder.current, ...input.patch };
      return { settings: recorder.current, changed: [] };
    },
  };
  return recorder;
}

function fakeDeps(settings: GuildSettings = DEFAULT_GUILD_SETTINGS): {
  deps: SetupDeps;
  store: Recorder;
} {
  const store = fakeStore(settings);
  const deps: SetupDeps = {
    log: createLogger({ level: "error", dir: null }),
    now: () => 0,
    store,
    admins: {
      list: async () => [],
      add: async () => {},
      remove: async () => {},
      setFlag: async () => {},
    },
    web: {
      publicBaseUrl: "https://verify.example",
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      listening: async () => true,
    },
    privacy: { ipStorage: "hash", tokenStorage: true },
    app: {
      ownerId: OWNER,
      gatewayReady: true,
      gatewayPingMs: 20,
      memberIntent: true,
      devGuildId: undefined,
      application: async () => ({
        id: "222222222222222222",
        name: "snapback",
        botUserId: "333333333333333333",
        ownerId: OWNER,
        flags: 0,
        intents: 0,
      }),
      selfTest: async () => [
        { step: "token", passed: true, said: "the token authenticated", fix: null },
      ],
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
    docs: async () => "# a shipped doc\n\nbody line",
    state: new MemoryStateStore(),
    logs: async () => ({ posted: true, said: "test event posted", fix: null }),
    postPanel: async () => {},
  };
  return { deps, store };
}

function withOpener(userId: string | null): GuildSettings {
  const wizard: WizardState = { ...DEFAULT_GUILD_SETTINGS.wizard, opened_by: userId };
  return { ...DEFAULT_GUILD_SETTINGS, wizard };
}

function commandOf(deps: SetupDeps, subcommand: string): SlashCommand {
  const found = setupCommands(deps).find((entry) => entry.subcommand === subcommand);
  if (found === undefined) throw new Error(`no /setup ${subcommand}`);
  return found;
}

function contextOf(options: Readonly<Record<string, string | number>> = {}): CommandContext {
  return { guildId: GUILD, userId: OPENER, options };
}

// ---- the tree walker -------------------------------------------------------

interface Node {
  type?: number;
  content?: string;
  components?: Node[];
  customID?: string;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  visit(n);
  if (Array.isArray(n.components)) for (const child of n.components) walk(child, visit);
}

function textOf(tree: unknown): string {
  const out: string[] = [];
  walk(tree, (n) => {
    if (typeof n.content === "string") out.push(n.content);
  });
  return out.join("\n");
}

function producedIds(tree: unknown): string[] {
  const out: string[] = [];
  walk(tree, (n) => {
    if (typeof n.customID === "string") out.push(n.customID);
  });
  return out;
}

// ---- the manifest ----------------------------------------------------------

describe("the /setup command surface", () => {
  test("builds one setup command with one subcommand option per entry", () => {
    const { deps } = fakeDeps();
    const definitions = buildDefinitions(setupCommands(deps));

    expect(definitions).toHaveLength(1);
    const [definition] = definitions;
    expect(definition?.name).toBe("setup");
    expect(definition?.options?.map((option) => option.name)).toEqual([
      "open",
      "status",
      ...STEP_SUBCOMMANDS,
      "guide",
    ]);
    expect(definition?.options?.every((option) => option.type === OPTION_TYPE.subCommand)).toBe(
      true,
    );
  });

  test("the step subcommands are the wizard's own step keys, minus the three it walks itself", () => {
    const { deps } = fakeDeps();
    const names = setupCommands(deps).map((command) => command.subcommand ?? "");
    const offered = names.filter((name) => WIZARD_STEP_KEYS.includes(name));

    // every step key with a subcommand is a real wizard step, and they are exactly
    // the jump targets. a step added to the wizard's table lands here.
    expect(offered).toEqual(STEP_SUBCOMMANDS);
    expect(WIZARD_STEP_KEYS.filter((key) => !offered.includes(key))).toEqual([
      "welcome",
      "scopes",
      "finish",
    ]);
  });

  test("every subcommand is described once, in a form discord accepts", () => {
    const { deps } = fakeDeps();
    const commands = setupCommands(deps);
    const names = commands.map((command) => command.subcommand ?? "");

    expect(new Set(names).size).toBe(commands.length);
    for (const command of commands) {
      expect(command.group).toBe("setup");
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(100);
    }
  });

  test("every subcommand is in docs/commands.md", async () => {
    const { deps } = fakeDeps();
    const doc = await Bun.file(new URL("../../../docs/commands.md", import.meta.url)).text();

    for (const command of setupCommands(deps)) {
      expect(doc).toContain(`\`/setup ${command.subcommand}\``);
    }
  });
});

// ---- the options -----------------------------------------------------------

describe("the guide subcommand's options", () => {
  test("the doc choice is built from GUIDE_DOCS", () => {
    const { deps } = fakeDeps();
    const guide = commandOf(deps, "guide");
    const doc = guide.options?.find((option) => option.name === "doc");
    // registry.ts's CommandOption carries no choices field yet, so this reads the
    // shape discord actually receives.
    const choices = (doc as { choices?: readonly { name: string; value: string }[] } | undefined)
      ?.choices;

    expect(choices?.map((choice) => choice.value)).toEqual(GUIDE_DOCS.map((entry) => entry.name));
    expect(choices?.map((choice) => choice.name)).toEqual(GUIDE_DOCS.map((entry) => entry.title));
  });

  test("the page option is an optional integer bounded at 999", () => {
    const { deps } = fakeDeps();
    const page = commandOf(deps, "guide").options?.find((option) => option.name === "page");
    const bounds = page as { max_value?: number; min_value?: number } | undefined;

    expect(page?.type).toBe(OPTION_TYPE.integer);
    expect(page?.required ?? false).toBe(false);
    expect(bounds?.min_value).toBe(1);
    expect(bounds?.max_value).toBe(999);
  });
});

// ---- the pages -------------------------------------------------------------

describe("the page each subcommand answers with", () => {
  test("every subcommand answers a v2 container under the 40 component cap, privately", async () => {
    const { deps, store } = fakeDeps();

    for (const command of setupCommands(deps)) {
      const options: Record<string, string | number> =
        command.subcommand === "guide" ? { doc: "setup" } : {};
      const result = await command.run(contextOf(options));

      expect(result.page.type).toBe(ComponentTypes.CONTAINER);
      expect(countComponents(result.page)).toBeLessThanOrEqual(PAGE_LIMIT);
      expect(result.ephemeral).toBe(true);
    }
    // only the wizard's own entry point writes anything on this surface
    expect(store.saves.every((save) => save.action === "setup.open")).toBe(true);
  });

  test("every step subcommand opens through openSetup, which hands the wizard over", async () => {
    for (const subcommand of STEP_SUBCOMMANDS) {
      const { deps, store } = fakeDeps(withOpener(OTHER));
      const result = await commandOf(deps, subcommand).run(contextOf());

      // running the command takes the wizard over (D4PLAN 10.4), and the step it
      // opened is the carrier of the chrome's cursor.
      expect(store.saves[0]?.action).toBe("setup.open");
      expect(store.saves[0]?.actorUserId).toBe(OPENER);
      expect(store.saves[0]?.patch.wizard?.opened_by).toBe(OPENER);
      expect(
        producedIds(result.page).some((raw) => parseCustomId(raw)?.cursor === subcommand),
      ).toBe(true);
    }
  });

  test("open, with no step key, starts at the first step still open", async () => {
    const { deps, store } = fakeDeps(withOpener(OTHER));
    const result = await commandOf(deps, "open").run(contextOf());

    expect(store.saves[0]?.action).toBe("setup.open");
    expect(store.saves[0]?.detail).toEqual({ step: null });
    expect(textOf(result.page)).toContain("welcome");
  });

  test("status reports the wizard without moving it", async () => {
    const { deps, store } = fakeDeps(withOpener(OTHER));
    const result = await commandOf(deps, "status").run(contextOf());

    expect(store.saves).toHaveLength(0);
    const text = textOf(result.page);
    expect(text).toContain("setup status");
    // the step list is the wizard's own table, not a second one
    expect(text).toContain("app check");
  });

  test("guide, with no doc, lists every guide and answers with routeable ids", async () => {
    const { deps } = fakeDeps();
    const result = await commandOf(deps, "guide").run(contextOf());
    const text = textOf(result.page);

    for (const doc of GUIDE_DOCS) expect(text).toContain(doc.name);
    for (const raw of producedIds(result.page)) {
      expect(parseCustomId(raw)?.surface).toBe("setup");
    }
  });

  test("guide, with a doc, renders that doc", async () => {
    const { deps } = fakeDeps();
    const result = await commandOf(deps, "guide").run(contextOf({ doc: "setup", page: 2 }));

    expect(textOf(result.page)).toContain("Setup");
    expect(textOf(result.page)).toContain("a shipped doc");
  });
});
