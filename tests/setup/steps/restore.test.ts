import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_WIZARD,
  type GuildSettings,
} from "../../../src/config/defaults.ts";
import { STATUS } from "../../../src/discord/components/colors.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  SETUP_OBJECT,
  type SetupDeps,
  type StepContext,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { restoreStep } from "../../../src/setup/steps/restore.ts";

const GUILD = "123456789012345678";

function fakeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    log: createLogger({ level: "error", dir: null }),
    now: () => 0,
    state: new MemoryStateStore(),
    logs: async () => ({ posted: true, said: "test event posted", fix: null }),
    postPanel: async () => {},
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
      publicBaseUrl: "https://verify.example",
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      listening: async () => true,
    },
    privacy: { ipStorage: "hash", tokenStorage: true },
    app: {
      ownerId: "111111111111111111",
      gatewayReady: true,
      gatewayPingMs: 20,
      memberIntent: true,
      devGuildId: undefined,
      application: async () => ({
        id: "222222222222222222",
        name: "snapback",
        botUserId: "333333333333333333",
        ownerId: "111111111111111111",
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
    ...overrides,
  };
}

function stepCtx(deps: SetupDeps, s: GuildSettings = DEFAULT_GUILD_SETTINGS): StepContext {
  return {
    guildId: GUILD,
    userId: "987654321098765432",
    settings: s,
    wizard: DEFAULT_WIZARD,
    deps,
  };
}

function id(cursor: string): string {
  return setupCustomId({ guildId: GUILD, object: SETUP_OBJECT.step, action: "restore", cursor });
}

interface Node {
  type?: number;
  customID?: string;
  content?: string;
  components?: Node[];
  accessory?: Node;
  component?: Node;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || typeof node !== "object") return;
  const n = node as Node;
  visit(n);
  if (Array.isArray(n.components)) for (const child of n.components) walk(child, visit);
  if (n.accessory) walk(n.accessory, visit);
  if (n.component) walk(n.component, visit);
}

function text(tree: unknown): string {
  const out: string[] = [];
  walk(tree, (n) => {
    if (typeof n.content === "string") out.push(n.content);
  });
  return out.join("\n");
}

describe("restoreStep", () => {
  test("renders a components-v2 container carrying the status word", () => {
    const tree = restoreStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.info.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("carries the three checkboxes with the right ids", () => {
    const tree = restoreStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const boxes: Node[] = [];
    walk(tree, (n) => {
      if (n.type === ComponentTypes.CHECKBOX) boxes.push(n);
    });
    expect(boxes).toHaveLength(3);
    const ids = boxes.map((b) => b.customID);
    expect(ids).toEqual([id("auto"), id("clear"), id("suffix")]);
    for (const produced of ids) {
      expect(parseCustomId(produced!).surface).toBe("setup");
    }
  });

  test("says clearing is destructive, off by default, and keeps its own confirmation", () => {
    const body = text(restoreStep.render(stepCtx(fakeDeps())) as ContainerComponent).toLowerCase();
    expect(body).toContain("destructive");
    expect(body).toContain("off by default");
    expect(body).toContain("safety net");
  });

  test("apply maps the three booleans from the checkbox ids", () => {
    const patch = restoreStep.apply!(stepCtx(fakeDeps()), {
      [id("auto")]: "true",
      [id("clear")]: "true",
      [id("suffix")]: "false",
    }) as {
      auto_restore_enabled: boolean;
      restore_clear_before: boolean;
      restore_message_timestamp_suffix: boolean;
    };
    expect(patch).toEqual({
      auto_restore_enabled: true,
      restore_clear_before: true,
      restore_message_timestamp_suffix: false,
    });
  });

  test("an absent checkbox key keeps the stored value", () => {
    const s = { ...DEFAULT_GUILD_SETTINGS, restore_clear_before: true } as GuildSettings;
    const patch = restoreStep.apply!(stepCtx(fakeDeps(), s), {}) as {
      restore_clear_before: boolean;
    };
    expect(patch.restore_clear_before).toBe(true);
  });
});
