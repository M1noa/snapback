import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_WIZARD,
  type GuildSettings,
  LOG_EVENT_FAMILIES,
} from "../../../src/config/defaults.ts";
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
import { logsStep } from "../../../src/setup/steps/logs.ts";

const GUILD = "123456789012345678";
const CHANNEL = "223456789012345678";

function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...patch } as GuildSettings;
}

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
      captcha: "none",
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

interface Node {
  type?: number;
  customID?: string;
  placeholder?: string;
  label?: string;
  value?: string;
  content?: string;
  components?: Node[];
  options?: Node[];
  accessory?: Node;
  component?: Node;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || typeof node !== "object") return;
  const n = node as Node;
  visit(n);
  if (Array.isArray(n.components)) for (const child of n.components) walk(child, visit);
  if (Array.isArray(n.options)) for (const child of n.options) walk(child, visit);
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

function idChannel(): string {
  return setupCustomId({
    guildId: GUILD,
    object: SETUP_OBJECT.log,
    action: SETUP_ACTION.toggle,
    cursor: "channel",
  });
}

function idFamilies(): string {
  return setupCustomId({
    guildId: GUILD,
    object: SETUP_OBJECT.log,
    action: SETUP_ACTION.toggle,
    cursor: "families",
  });
}

describe("logsStep", () => {
  test("renders a components-v2 container carrying the status word", () => {
    const tree = logsStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.info.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("shows the current channel as a mention, or not set", () => {
    const withChannel = logsStep.render(
      stepCtx(fakeDeps(), settings({ log_channel_id: CHANNEL })),
    ) as ContainerComponent;
    expect(text(withChannel)).toContain(`<#${CHANNEL}>`);

    const without = logsStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(text(without)).toContain("not set");
  });

  test("the checkbox group carries exactly the seven families", () => {
    const tree = logsStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const groups: Node[] = [];
    walk(tree, (n) => {
      if (n.type === ComponentTypes.CHECKBOX_GROUP) groups.push(n);
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.customID).toBe(idFamilies());
    expect(groups[0]!.options!.map((o) => o.value)).toEqual([...LOG_EVENT_FAMILIES]);
  });

  test("the channel select and the test-fire button exist and parse as setup ids", () => {
    const tree = logsStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const ids: string[] = [];
    walk(tree, (n) => {
      if (typeof n.customID === "string") ids.push(n.customID);
    });
    expect(ids).toContain(idChannel());
    for (const id of ids) {
      expect(parseCustomId(id).surface).toBe("setup");
    }
  });

  test("apply keeps a valid channel id as a string and a family list of strings", () => {
    const values = {
      [idChannel()]: CHANNEL,
      [idFamilies()]: ["backup", "verify"],
    };
    const patch = logsStep.apply!(stepCtx(fakeDeps()), values) as {
      log_channel_id: unknown;
      log_events: readonly string[];
    };
    expect(patch.log_channel_id).toBe(CHANNEL);
    expect(typeof patch.log_channel_id).toBe("string");
    expect(patch.log_events).toEqual(["backup", "verify"]);
  });

  test("a channel id that is not a snowflake becomes null, not a number", () => {
    const values = { [idChannel()]: "not-a-channel-id" };
    const patch = logsStep.apply!(stepCtx(fakeDeps()), values) as { log_channel_id: unknown };
    expect(patch.log_channel_id).toBeNull();
  });

  test("apply drops a family that is not one of the seven", () => {
    const values = { [idFamilies()]: ["backup", "bogus"] };
    const patch = logsStep.apply!(stepCtx(fakeDeps()), values) as { log_events: readonly string[] };
    expect(patch.log_events).toEqual(["backup"]);
  });
});
