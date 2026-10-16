import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS, DEFAULT_WIZARD } from "../../../src/config/defaults.ts";
import { STATUS } from "../../../src/discord/components/colors.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  SETUP_ACTION,
  SETUP_OBJECT,
  type SetupDeps,
  type StepContext,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { welcomeStep } from "../../../src/setup/steps/welcome.ts";

const GUILD = "123456789012345678";

// a full SetupDeps with everything the welcome step does not touch stubbed.
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

function stepCtx(deps: SetupDeps): StepContext {
  return {
    guildId: GUILD,
    userId: "987654321098765432",
    settings: DEFAULT_GUILD_SETTINGS,
    wizard: DEFAULT_WIZARD,
    deps,
  };
}

interface Node {
  type?: number;
  customID?: string;
  label?: string;
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

describe("welcomeStep", () => {
  test("is the welcome key with nothing to submit", () => {
    expect(welcomeStep.key).toBe("welcome");
    expect(welcomeStep.apply).toBeUndefined();
    expect(welcomeStep.modal).toBeUndefined();
  });

  test("renders a components-v2 container carrying the status word", () => {
    const tree = welcomeStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.info.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("says what snapback does: backup and restore", () => {
    const tree = welcomeStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const body = text(tree);
    expect(body).toContain("backup");
    expect(body).toContain("restore");
  });

  test("discloses exactly what verification captures", () => {
    const body = text(welcomeStep.render(stepCtx(fakeDeps())) as ContainerComponent);
    expect(body).toContain("discord id and username");
    expect(body).toContain("`email` scope");
    expect(body).toContain("ip address");
    expect(body).toContain("user agent");
  });

  test("uses no reward, nitro, or gift phrasing", () => {
    const body = text(welcomeStep.render(stepCtx(fakeDeps())) as ContainerComponent).toLowerCase();
    for (const banned of ["nitro", "gift", "reward", "prize"]) {
      expect(body).not.toContain(banned);
    }
  });

  test("the continue button carries the nav next custom id", () => {
    const tree = welcomeStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const buttons: Node[] = [];
    walk(tree, (n) => {
      if (n.type === ComponentTypes.BUTTON) buttons.push(n);
    });
    expect(buttons).toHaveLength(1);
    const expected = setupCustomId({
      guildId: GUILD,
      object: SETUP_OBJECT.nav,
      action: SETUP_ACTION.next,
    });
    expect(buttons[0]!.customID).toBe(expected);
    expect(buttons[0]!.label).toBe("continue");
  });

  test("the produced id parses with surface setup", () => {
    const id = setupCustomId({
      guildId: GUILD,
      object: SETUP_OBJECT.nav,
      action: SETUP_ACTION.next,
    });
    const parsed = parseCustomId(id);
    expect(parsed.surface).toBe("setup");
    expect(parsed.action).toBe("next");
    expect(parsed.guild).toBe(GUILD);
  });
});
