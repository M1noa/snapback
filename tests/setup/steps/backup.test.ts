import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent, type TextInput } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_WIZARD,
  type GuildSettings,
  LIMITS,
} from "../../../src/config/defaults.ts";
import { STATUS } from "../../../src/discord/components/colors.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  SETUP_OBJECT,
  type SetupDeps,
  SetupInputError,
  type StepContext,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { backupStep } from "../../../src/setup/steps/backup.ts";

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

function id(cursor?: string): string {
  return setupCustomId({ guildId: GUILD, object: SETUP_OBJECT.step, action: "backup", cursor });
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

describe("backupStep", () => {
  test("renders a components-v2 container carrying the status word", () => {
    const tree = backupStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.info.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("says the settings are per-guild, the interval is hours, and the count is a ceiling", () => {
    const body = text(backupStep.render(stepCtx(fakeDeps())) as ContainerComponent).toLowerCase();
    expect(body).toContain("per-guild");
    expect(body).toContain("hours");
    expect(body).toContain("ceiling");
    expect(body).toContain("max_messages_total");
  });

  test("the two toggles exist and every produced id parses as setup", () => {
    const tree = backupStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const ids: string[] = [];
    walk(tree, (n) => {
      if (typeof n.customID === "string") ids.push(n.customID);
    });
    expect(ids).toContain(id("auto"));
    expect(ids).toContain(id("notify"));
    expect(ids).toContain(id());
    for (const produced of ids) {
      expect(parseCustomId(produced).surface).toBe("setup");
    }
  });

  test("the modal holds the two numeric fields, prefilled from settings", () => {
    const s = { ...DEFAULT_GUILD_SETTINGS, auto_backup_interval_hours: 6 } as GuildSettings;
    const built = backupStep.modal!(stepCtx(fakeDeps(), s));
    expect(built).not.toBeNull();
    expect(built!.components).toHaveLength(2);
    const inputs: TextInput[] = [];
    walk(built, (n) => {
      if (n.type === ComponentTypes.TEXT_INPUT) inputs.push(n as unknown as TextInput);
    });
    expect(inputs.map((i) => i.customID)).toEqual([id("interval"), id("count")]);
    expect(inputs[0]!.value).toBe("6");
  });

  test("apply clamps a number over the range", () => {
    const values = { [id("interval")]: "9999", [id("count")]: "-5" };
    const patch = backupStep.apply!(stepCtx(fakeDeps()), values) as {
      auto_backup_interval_hours: number;
      auto_backup_message_count: number;
    };
    expect(patch.auto_backup_interval_hours).toBe(LIMITS.auto_backup_interval_hours.max);
    expect(patch.auto_backup_message_count).toBe(LIMITS.auto_backup_message_count.min);
  });

  test("apply throws SetupInputError for a non-numeric number", () => {
    const values = { [id("interval")]: "soon" };
    expect(() => backupStep.apply!(stepCtx(fakeDeps()), values)).toThrow(SetupInputError);
    try {
      backupStep.apply!(stepCtx(fakeDeps()), values);
    } catch (error) {
      expect((error as SetupInputError).field).toBe("auto_backup_interval_hours");
      expect((error as Error).message).toContain("1");
      expect((error as Error).message).toContain("168");
    }
  });

  test("apply maps the two toggles from the checkbox ids", () => {
    const patch = backupStep.apply!(stepCtx(fakeDeps()), {
      [id("auto")]: "true",
      [id("notify")]: "true",
      [id("interval")]: "6",
      [id("count")]: "500",
    }) as {
      auto_backup_enabled: boolean;
      notify_on_join: boolean;
      auto_backup_interval_hours: number;
      auto_backup_message_count: number;
    };
    expect(patch).toEqual({
      auto_backup_enabled: true,
      notify_on_join: true,
      auto_backup_interval_hours: 6,
      auto_backup_message_count: 500,
    });
  });

  test("an absent toggle key keeps the stored value", () => {
    const s = { ...DEFAULT_GUILD_SETTINGS, auto_backup_enabled: true } as GuildSettings;
    const patch = backupStep.apply!(stepCtx(fakeDeps(), s), {}) as { auto_backup_enabled: boolean };
    expect(patch.auto_backup_enabled).toBe(true);
  });
});
