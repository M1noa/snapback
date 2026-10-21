import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent, type TextInput } from "oceanic.js";
import {
  BACKUP_INCLUDE_KEYS,
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_WIZARD,
  type GuildSettings,
  LIMITS,
  MESSAGE_TYPE_NAMES,
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
  options?: { label?: string; value?: string; default?: boolean }[];
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

// apply is declared as a patch or a promise of one because a sibling step is
// async; this one is synchronous, so a test reads it straight.
function patchOf(
  values: Record<string, string | readonly string[]>,
  s: GuildSettings = DEFAULT_GUILD_SETTINGS,
): Partial<GuildSettings> {
  return backupStep.apply!(stepCtx(fakeDeps(), s), values) as Partial<GuildSettings>;
}

// a checkbox group by its custom id, so a test can read the options it offers.
function group(tree: unknown, wanted: string): { label: string; value: string; on: boolean }[] {
  let found: { label: string; value: string; on: boolean }[] = [];
  walk(tree, (n) => {
    if (n.type !== ComponentTypes.CHECKBOX_GROUP || n.customID !== wanted) return;
    found = (n.options ?? []).map((option) => ({
      label: option.label ?? "",
      value: option.value ?? "",
      on: option.default === true,
    }));
  });
  return found;
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
    expect(body).toContain("ceiling per channel");
    expect(body).toContain("ceiling per capture");
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

  test("the modal holds the four numeric fields, prefilled from settings", () => {
    const s = { ...DEFAULT_GUILD_SETTINGS, auto_backup_interval_hours: 6 } as GuildSettings;
    const built = backupStep.modal!(stepCtx(fakeDeps(), s));
    expect(built).not.toBeNull();
    expect(built!.components).toHaveLength(4);
    const inputs: TextInput[] = [];
    walk(built, (n) => {
      if (n.type === ComponentTypes.TEXT_INPUT) inputs.push(n as unknown as TextInput);
    });
    expect(inputs.map((i) => i.customID)).toEqual([
      id("interval"),
      id("count"),
      id("max-channel"),
      id("max-total"),
    ]);
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
    const patch = patchOf({
      [id("auto")]: "true",
      [id("notify")]: "true",
      [id("interval")]: "6",
      [id("count")]: "500",
    });
    expect(patch).toEqual({
      auto_backup_enabled: true,
      notify_on_join: true,
      auto_backup_interval_hours: 6,
      auto_backup_message_count: 500,
      backup_max_messages_per_channel: DEFAULT_GUILD_SETTINGS.backup_max_messages_per_channel,
      backup_max_messages_total: DEFAULT_GUILD_SETTINGS.backup_max_messages_total,
      backup_include: DEFAULT_GUILD_SETTINGS.backup_include,
      backup_message_types: DEFAULT_GUILD_SETTINGS.backup_message_types,
    });
  });

  test("an absent toggle key keeps the stored value", () => {
    const s = { ...DEFAULT_GUILD_SETTINGS, auto_backup_enabled: true } as GuildSettings;
    expect(patchOf({}, s).auto_backup_enabled).toBe(true);
  });

  test("the include group offers a box for every category, all on by default", () => {
    const tree = backupStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const boxes = group(tree, id("include"));
    expect(boxes.map((b) => b.value)).toEqual([...BACKUP_INCLUDE_KEYS]);
    expect(boxes.every((b) => b.on)).toBe(true);
    expect(boxes.every((b) => b.label !== "")).toBe(true);
  });

  test("the include group checks what the stored settings turned on", () => {
    const s = {
      ...DEFAULT_GUILD_SETTINGS,
      backup_include: { ...DEFAULT_GUILD_SETTINGS.backup_include, messages: false },
    } as GuildSettings;
    const boxes = group(backupStep.render(stepCtx(fakeDeps(), s)), id("include"));
    expect(boxes.filter((b) => b.on).map((b) => b.value)).not.toContain("messages");
    expect(boxes.filter((b) => b.on)).toHaveLength(BACKUP_INCLUDE_KEYS.length - 1);
  });

  test("apply turns off only the categories the group left unchecked", () => {
    const patch = patchOf({ [id("include")]: ["roles", "channels", "messages"] });
    expect(patch.backup_include).toEqual({
      roles: true,
      channels: true,
      messages: true,
      members: false,
      bans: false,
      emojis: false,
      stickers: false,
      onboarding: false,
    });
  });

  test("an absent include key keeps the stored set rather than clearing it", () => {
    const s = {
      ...DEFAULT_GUILD_SETTINGS,
      backup_include: { ...DEFAULT_GUILD_SETTINGS.backup_include, bans: false },
    } as GuildSettings;
    expect(patchOf({}, s).backup_include).toEqual(s.backup_include);
  });

  test("a category the group does not offer keeps its stored value", () => {
    // a key added by a newer build is not in this group; the group must not be
    // read as "everything unsent was turned off".
    const s = {
      ...DEFAULT_GUILD_SETTINGS,
      backup_include: { ...DEFAULT_GUILD_SETTINGS.backup_include, messages: false },
    } as GuildSettings;
    const patch = patchOf({ [id("include")]: ["roles"] }, s);
    expect(patch.backup_include?.roles).toBe(true);
    expect(patch.backup_include?.messages).toBe(false);
  });

  test("the type group offers the named types with the defaults checked", () => {
    const boxes = group(backupStep.render(stepCtx(fakeDeps())), id("types"));
    expect(boxes.map((b) => b.value)).toEqual(Object.keys(MESSAGE_TYPE_NAMES));
    expect(boxes.filter((b) => b.on).map((b) => b.value)).toEqual(["0", "19", "20"]);
    expect(boxes.every((b) => b.label !== "")).toBe(true);
  });

  test("apply stores the chosen types as sorted, deduped numbers", () => {
    const patch = patchOf({ [id("types")]: ["20", "0", "20", "19"] });
    expect(patch.backup_message_types).toEqual([0, 19, 20]);
  });

  test("apply drops a type outside discord's range instead of clamping it", () => {
    const patch = patchOf({ [id("types")]: ["7", "999", "-1", "soon"] });
    expect(patch.backup_message_types).toEqual([7]);
  });

  test("an absent type key keeps the stored list", () => {
    const s = {
      ...DEFAULT_GUILD_SETTINGS,
      backup_message_types: [0] as readonly number[],
    } as GuildSettings;
    expect(patchOf({}, s).backup_message_types).toEqual([0]);
  });

  test("a stored type with no label still shows in the summary", () => {
    const s = {
      ...DEFAULT_GUILD_SETTINGS,
      backup_message_types: [0, 12] as readonly number[],
    } as GuildSettings;
    expect(text(backupStep.render(stepCtx(fakeDeps(), s)))).toContain("type 12");
  });
});
