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
import { webStep } from "../../../src/setup/steps/web.ts";

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
      behindCloudflareTunnel: true,
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

describe("webStep", () => {
  test("is the web key with nothing to submit", () => {
    expect(webStep.key).toBe("web");
    expect(webStep.apply).toBeUndefined();
  });

  test("renders a components-v2 container carrying the status word", async () => {
    const tree = (await webStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.success.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("shows the environment facts it owns", async () => {
    const tree = (await webStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    const body = text(tree);
    expect(body).toContain("https://verify.example");
    expect(body).toContain("8080");
    expect(body).toContain("BEHIND_CLOUDFLARE_TUNNEL");
    expect(body).toContain("TRUSTED_PROXY_DEPTH");
  });

  test("says https is required, that the tunnel changes the ip source, and that localhost captures ::1", async () => {
    const tree = (await webStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    const body = text(tree).toLowerCase();
    expect(body).toContain("https");
    expect(body).toContain("cf-connecting-ip");
    expect(body).toContain("::1");
    expect(body).toContain("restart");
  });

  test("prints the deployment table as tunnel, reverse proxy, and direct lines", async () => {
    const tree = (await webStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    const body = text(tree).toLowerCase();
    expect(body).toContain("cloudflare tunnel");
    expect(body).toContain("reverse proxy");
    expect(body).toContain("direct exposure");
  });

  test("the probe button carries the nav probe custom id", async () => {
    const tree = (await webStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    const buttons: Node[] = [];
    walk(tree, (n) => {
      if (n.type === ComponentTypes.BUTTON) buttons.push(n);
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.label).toBe("probe");
    const expected = setupCustomId({
      guildId: GUILD,
      object: SETUP_OBJECT.nav,
      action: SETUP_ACTION.probe,
    });
    expect(buttons[0]!.customID).toBe(expected);
    const parsed = parseCustomId(buttons[0]!.customID!);
    expect(parsed.surface).toBe("setup");
    expect(parsed.action).toBe(SETUP_ACTION.probe);
    expect(parsed.guild).toBe(GUILD);
  });

  test("a socket that is not accepting is warning and says what to do", async () => {
    const deps = fakeDeps({
      web: {
        publicBaseUrl: "https://verify.example",
        port: 8080,
        behindCloudflareTunnel: false,
        trustedProxyDepth: 1,
        listening: async () => false,
      },
    });
    const tree = (await webStep.render(stepCtx(deps))) as ContainerComponent;
    expect(tree.accentColor).toBe(STATUS.warning.accent);
    expect(text(tree).toLowerCase()).toContain("nothing is accepting");
  });
});
