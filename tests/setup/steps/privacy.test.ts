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
  SetupInputError,
  type StepContext,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { PRIVACY_DISCLOSURE_DEFAULT, privacyStep } from "../../../src/setup/steps/privacy.ts";

const GUILD = "123456789012345678";
const MODAL_ID = setupCustomId({ guildId: GUILD, object: SETUP_OBJECT.modal, action: "privacy" });

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
    portal: { items: async () => [], permissionBits: () => "0", invite: () => "https://x" },
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

function stepCtx(deps: SetupDeps, patch: Partial<GuildSettings> = {}): StepContext {
  return {
    guildId: GUILD,
    userId: "987654321098765432",
    settings: { ...DEFAULT_GUILD_SETTINGS, ...patch },
    wizard: DEFAULT_WIZARD,
    deps,
  };
}

interface Node {
  type?: number;
  customID?: string;
  content?: string;
  value?: string;
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

// the value carried by the modal's text input, reached through its label.
function modalValue(ctx: StepContext): string | undefined {
  const built = privacyStep.modal!(ctx);
  const labelNode = built!.components[0] as Node;
  expect(labelNode.type).toBe(ComponentTypes.LABEL);
  return labelNode.component?.value;
}

describe("privacyStep", () => {
  test("is the privacy key", () => {
    expect(privacyStep.key).toBe("privacy");
  });

  test("renders a components-v2 container carrying the status word", () => {
    const tree = privacyStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(text(tree)).toContain(STATUS.success.word);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("shows the ip mode and its stored form", () => {
    const hash = text(privacyStep.render(stepCtx(fakeDeps())));
    expect(hash).toContain("sha-512");
    expect(hash).toContain("not reversible");

    const encrypted = text(
      privacyStep.render(
        stepCtx(fakeDeps({ privacy: { ipStorage: "encrypted", tokenStorage: true } })),
      ),
    );
    expect(encrypted).toContain("aes-256-gcm");
    expect(encrypted).toContain("reversible");
  });

  test("plaintext warns, and says the bot warns at boot", () => {
    const deps = fakeDeps({ privacy: { ipStorage: "plaintext", tokenStorage: true } });
    const tree = privacyStep.render(stepCtx(deps)) as ContainerComponent;
    expect(tree.accentColor).toBe(0xfee75c);
    const body = text(tree);
    expect(body).toContain("warning at boot");
  });

  test("says the mode lives in .env and prints the exact line", () => {
    const body = text(privacyStep.render(stepCtx(fakeDeps())));
    expect(body).toContain("IP_STORAGE=hash");
    expect(body).toContain("restart");
  });

  test("points retention at the table and /admin retention, inventing nothing", () => {
    const body = text(privacyStep.render(stepCtx(fakeDeps())));
    expect(body).toContain("retention_policies");
    expect(body).toContain("/admin retention");
  });

  test("shows the shipped default disclosure so they know what they replace", () => {
    const body = text(privacyStep.render(stepCtx(fakeDeps())));
    expect(body).toContain(PRIVACY_DISCLOSURE_DEFAULT);
  });

  test("the edit button carries the modal privacy custom id", () => {
    const tree = privacyStep.render(stepCtx(fakeDeps())) as ContainerComponent;
    const buttons: Node[] = [];
    walk(tree, (n) => {
      if (n.type === ComponentTypes.BUTTON) buttons.push(n);
    });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.customID).toBe(MODAL_ID);
    const parsed = parseCustomId(buttons[0]!.customID as string);
    expect(parsed.surface).toBe("setup");
    expect(parsed.object).toBe("modal");
    expect(parsed.action).toBe("privacy");
  });

  test("the modal prefills the stored text", () => {
    expect(modalValue(stepCtx(fakeDeps(), { privacy_disclosure_text: "my own text" }))).toBe(
      "my own text",
    );
  });

  test("the modal falls back to the shipped default when nothing is stored", () => {
    expect(modalValue(stepCtx(fakeDeps(), { privacy_disclosure_text: null }))).toBe(
      PRIVACY_DISCLOSURE_DEFAULT,
    );
  });

  test("apply trims", () => {
    const out = privacyStep.apply!(stepCtx(fakeDeps()), { [MODAL_ID]: "  hello  " });
    expect(out).toEqual({ privacy_disclosure_text: "hello" });
  });

  test("apply maps an empty or blank input to null", () => {
    expect(privacyStep.apply!(stepCtx(fakeDeps()), { [MODAL_ID]: "" })).toEqual({
      privacy_disclosure_text: null,
    });
    expect(privacyStep.apply!(stepCtx(fakeDeps()), { [MODAL_ID]: "   " })).toEqual({
      privacy_disclosure_text: null,
    });
  });

  test("apply throws SetupInputError past 2000 characters", () => {
    expect(() => privacyStep.apply!(stepCtx(fakeDeps()), { [MODAL_ID]: "a".repeat(2001) })).toThrow(
      SetupInputError,
    );
    try {
      privacyStep.apply!(stepCtx(fakeDeps()), { [MODAL_ID]: "a".repeat(2001) });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SetupInputError);
      expect((error as SetupInputError).field).toBe("privacy_disclosure_text");
    }
  });

  test("apply accepts exactly 2000 characters", () => {
    // the step's apply is synchronous; the contract's union just hides that.
    const out = privacyStep.apply!(stepCtx(fakeDeps()), {
      [MODAL_ID]: "a".repeat(2000),
    }) as { privacy_disclosure_text: string | null };
    expect(out.privacy_disclosure_text).toHaveLength(2000);
  });
});
