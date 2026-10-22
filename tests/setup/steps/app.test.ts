import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS, DEFAULT_WIZARD } from "../../../src/config/defaults.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  type AppFacts,
  type ApplicationFacts,
  type Portal,
  type PortalItem,
  SETUP_ACTION,
  SETUP_OBJECT,
  type SetupDeps,
  type StepContext,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { appStep } from "../../../src/setup/steps/app.ts";

const GUILD = "123456789012345678";
const BASE_URL = "https://verify.example";

function appFacts(over: Partial<AppFacts> = {}): AppFacts {
  const application = async (): Promise<ApplicationFacts> => ({
    id: "222222222222222222",
    name: "snapback",
    botUserId: "333333333333333333",
    ownerId: "111111111111111111",
    flags: 0,
    intents: 0,
  });
  return {
    ownerId: "111111111111111111",
    gatewayReady: true,
    gatewayPingMs: 20,
    memberIntent: true,
    devGuildId: undefined,
    application,
    selfTest: async () => [],
    ...over,
  };
}

function portal(items: readonly PortalItem[]): Portal {
  return {
    items: async () => items,
    permissionBits: () => "0",
    invite: () => "https://discord.com/oauth2/authorize?client_id=222222222222222222",
  };
}

function item(over: Partial<PortalItem> = {}): PortalItem {
  return { index: 1, title: "application created", body: "", done: true, fix: null, ...over };
}

function fakeDeps(over: Partial<SetupDeps> = {}): SetupDeps {
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
      publicBaseUrl: BASE_URL,
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      captcha: "none",
      listening: async () => true,
    },
    privacy: { ipStorage: "hash", tokenStorage: true },
    app: appFacts(),
    portal: portal([]),
    images: {
      current: async () => ({ displayName: null, avatarSet: false, bannerSet: false }),
      setAvatar: async () => {},
      setBanner: async () => {},
      setDisplayName: async () => {},
    },
    files: { read: async () => ({ bytes: new Uint8Array(), filename: "", contentType: "" }) },
    docs: async () => null,
    ...over,
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

describe("appStep", () => {
  test("is the app key with nothing to submit", () => {
    expect(appStep.key).toBe("app");
    expect(appStep.apply).toBeUndefined();
    expect(appStep.modal).toBeUndefined();
  });

  test("renders a components-v2 container inside the cap", async () => {
    const tree = (await appStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
    expect(text(tree)).toMatch(/waiting|done|running|failed/);
  });

  test("prints the exact redirect string to paste", async () => {
    const tree = (await appStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    expect(text(tree)).toContain(`${BASE_URL}/callback`);
  });

  test("a portal item that is not passing renders its fix", async () => {
    const deps = fakeDeps({
      portal: portal([
        item({ index: 1, title: "application created", done: true }),
        item({
          index: 2,
          title: "redirect uris registered",
          done: false,
          fix: `add ${BASE_URL}/callback to Redirect URIs`,
        }),
        item({ index: 3, title: "privileged intents", done: null, fix: "toggle GUILD_MEMBERS" }),
      ]),
    });
    const body = text(await appStep.render(stepCtx(deps)));
    expect(body).toContain(`add ${BASE_URL}/callback to Redirect URIs`);
    expect(body).toContain("toggle GUILD_MEMBERS");
    expect(body).toContain("pass");
    expect(body).toContain("fail");
    expect(body).toContain("unknown");
  });

  test("names GUILD_MEMBERS as privileged and drops GUILD_PRESENCES", async () => {
    const body = text(await appStep.render(stepCtx(fakeDeps())));
    expect(body).toContain("GUILD_MEMBERS");
    expect(body).toContain("privileged");
    expect(body).toContain("GUILD_PRESENCES");
    expect(body).toContain("not requested");
  });

  test("says the interactions endpoint is not used on a gateway client", async () => {
    const body = text(await appStep.render(stepCtx(fakeDeps())));
    expect(body).toContain("interactions endpoint");
    expect(body).toContain("gateway");
    expect(body).toContain("401");
  });

  test("the self-test button carries the app test custom id", async () => {
    const tree = (await appStep.render(stepCtx(fakeDeps()))) as ContainerComponent;
    const buttons: Node[] = [];
    walk(tree, (n) => {
      if (n.type === ComponentTypes.BUTTON) buttons.push(n);
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.label).toBe("run self test");
    const expected = setupCustomId({
      guildId: GUILD,
      object: SETUP_OBJECT.app,
      action: SETUP_ACTION.test,
    });
    expect(buttons[0]!.customID).toBe(expected);
    const parsed = parseCustomId(buttons[0]!.customID as string);
    expect(parsed.surface).toBe("setup");
    expect(parsed.object).toBe("app");
    expect(parsed.action).toBe("test");
  });

  test("a failing checklist item makes the page danger", async () => {
    const deps = fakeDeps({
      portal: portal([item({ done: false, fix: "fix it" })]),
    });
    const tree = (await appStep.render(stepCtx(deps))) as ContainerComponent;
    expect(tree.accentColor).toBe(0xed4245);
  });

  test("a clean checklist is success", async () => {
    const deps = fakeDeps({ portal: portal([item({ done: true })]) });
    const tree = (await appStep.render(stepCtx(deps))) as ContainerComponent;
    expect(tree.accentColor).toBe(0x57f287);
  });

  test("the owner line resolves against the application owner", async () => {
    const match = text(await appStep.render(stepCtx(fakeDeps())));
    expect(match).toContain("matches the application owner");

    const deps = fakeDeps({ app: appFacts({ ownerId: "444444444444444444" }) });
    const miss = text(await appStep.render(stepCtx(deps)));
    expect(miss).toContain("does not match the application owner");
  });
});
