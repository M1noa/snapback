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
import { trackingStep } from "../../../src/setup/steps/tracking.ts";

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

function id(cursor?: string): string {
  return setupCustomId({ guildId: GUILD, object: SETUP_OBJECT.step, action: "tracking", cursor });
}

interface Node {
  type?: number;
  customID?: string;
  content?: string;
  components?: Node[];
  accessory?: Node;
  component?: Node;
  default?: boolean;
  value?: string;
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

function patchOf(
  values: Record<string, string | readonly string[]>,
  s: GuildSettings = DEFAULT_GUILD_SETTINGS,
): Partial<GuildSettings> {
  return trackingStep.apply!(stepCtx(fakeDeps(), s), values) as Partial<GuildSettings>;
}

// a bare checkbox by its custom id, so a test can read its stored default.
function box(tree: unknown, wanted: string): Node | undefined {
  let found: Node | undefined;
  walk(tree, (n) => {
    if (n.type === ComponentTypes.CHECKBOX && n.customID === wanted) found = n;
  });
  return found;
}

function withTracking(overrides: Partial<GuildSettings["tracking"]>): GuildSettings {
  return {
    ...DEFAULT_GUILD_SETTINGS,
    tracking: { ...DEFAULT_GUILD_SETTINGS.tracking, ...overrides },
  } as GuildSettings;
}

describe("trackingStep", () => {
  test("renders a components-v2 container carrying the status word", () => {
    const tree = trackingStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.info.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("says history and behaviour are separate, and no message text is kept", () => {
    const body = text(trackingStep.render(stepCtx(fakeDeps())) as ContainerComponent).toLowerCase();
    expect(body).toContain("history");
    expect(body).toContain("behaviour");
    expect(body).toContain("message text and attachment bytes are never recorded");
    expect(body).toContain("separate from your backup retention");
  });

  test("states the retention range and that blank keeps everything", () => {
    const body = text(trackingStep.render(stepCtx(fakeDeps())) as ContainerComponent);
    expect(body).toContain(String(LIMITS.tracking_keep_days.min));
    expect(body).toContain(String(LIMITS.tracking_keep_days.max));
    expect(body).toContain("leave it blank to keep everything");
    expect(body).toContain("kept until you delete it");
  });

  test("says how long the timeline is kept, in days or forever", () => {
    const forever = text(trackingStep.render(stepCtx(fakeDeps())) as ContainerComponent);
    expect(forever).toContain("keep for: kept until you delete it");
    const oneDay = text(
      trackingStep.render(
        stepCtx(fakeDeps(), withTracking({ keep_days: 1 })),
      ) as ContainerComponent,
    );
    expect(oneDay).toContain("keep for: 1 day");
    const many = text(
      trackingStep.render(
        stepCtx(fakeDeps(), withTracking({ keep_days: 30 })),
      ) as ContainerComponent,
    );
    expect(many).toContain("keep for: 30 days");
  });

  test("both switches exist, carry the stored defaults, and every id parses as setup", () => {
    const tree = trackingStep.render(
      stepCtx(fakeDeps(), withTracking({ history: false, palantir: true })),
    ) as ContainerComponent;
    expect(box(tree, id("history"))?.default).toBe(false);
    expect(box(tree, id("palantir"))?.default).toBe(true);

    const ids: string[] = [];
    walk(tree, (n) => {
      if (typeof n.customID === "string") ids.push(n.customID);
    });
    expect(ids).toContain(id());
    expect(ids).toContain(id("history"));
    expect(ids).toContain(id("palantir"));
    for (const produced of ids) {
      expect(parseCustomId(produced).surface).toBe("setup");
    }
  });

  test("the modal holds one field, blank when everything is kept", () => {
    const built = trackingStep.modal!(stepCtx(fakeDeps()));
    expect(built).not.toBeNull();
    expect(built!.components).toHaveLength(1);
    const inputs: TextInput[] = [];
    walk(built, (n) => {
      if (n.type === ComponentTypes.TEXT_INPUT) inputs.push(n as unknown as TextInput);
    });
    expect(inputs.map((i) => i.customID)).toEqual([id("keep")]);
    expect(inputs[0]!.value).toBe("");
  });

  test("the modal prefills the stored window", () => {
    const built = trackingStep.modal!(stepCtx(fakeDeps(), withTracking({ keep_days: 30 })));
    const inputs: TextInput[] = [];
    walk(built, (n) => {
      if (n.type === ComponentTypes.TEXT_INPUT) inputs.push(n as unknown as TextInput);
    });
    expect(inputs[0]!.value).toBe("30");
  });

  test("apply returns the whole tracking object", () => {
    const patch = patchOf({
      [id("history")]: "false",
      [id("palantir")]: "true",
      [id("keep")]: "30",
    });
    expect(patch).toEqual({ tracking: { history: false, palantir: true, keep_days: 30 } });
  });

  test("an absent key keeps the stored value", () => {
    const s = withTracking({ history: true, palantir: true, keep_days: 90 });
    expect(patchOf({}, s)).toEqual({ tracking: { history: true, palantir: true, keep_days: 90 } });
  });

  test("a blank window means keep everything", () => {
    expect(
      patchOf({ [id("keep")]: "  " }, withTracking({ keep_days: 30 })).tracking?.keep_days,
    ).toBe(null);
  });

  test("apply clamps a window over the range", () => {
    expect(patchOf({ [id("keep")]: "99999" }).tracking?.keep_days).toBe(
      LIMITS.tracking_keep_days.max,
    );
    expect(patchOf({ [id("keep")]: "-5" }).tracking?.keep_days).toBe(LIMITS.tracking_keep_days.min);
  });

  test("apply throws SetupInputError for a non-numeric window", () => {
    const values = { [id("keep")]: "soon" };
    expect(() => trackingStep.apply!(stepCtx(fakeDeps()), values)).toThrow(SetupInputError);
    try {
      trackingStep.apply!(stepCtx(fakeDeps()), values);
    } catch (error) {
      expect((error as SetupInputError).field).toBe("tracking.keep_days");
      expect((error as Error).message).toContain(String(LIMITS.tracking_keep_days.min));
      expect((error as Error).message).toContain(String(LIMITS.tracking_keep_days.max));
      expect((error as Error).message).toContain("blank");
    }
  });
});
