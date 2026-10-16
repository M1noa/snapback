import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_VERIFY_PANEL,
  DEFAULT_WIZARD,
  type GuildSettings,
} from "../../../src/config/defaults.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import type { Logger } from "../../../src/lib/log.ts";
import {
  type SetupDeps,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
} from "../../../src/setup/deps.ts";
import { panelChannelId, panelFieldId } from "../../../src/setup/panel.ts";
import { verifyStep } from "../../../src/setup/steps/verify.ts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const ISO_NOW = "2026-10-16T12:00:00.000Z";
const GUILD = "123456789012345678";

const log: Logger = {
  level: "error",
  debug() {},
  info() {},
  warn() {},
  error() {},
  async flush() {},
};

function unused(): never {
  throw new Error("unused setup dependency");
}

function fakeDeps(publicBaseUrl = "https://verify.example.com"): SetupDeps {
  return {
    log,
    now: () => NOW,
    state: new MemoryStateStore(),
    logs: unused,
    postPanel: unused,
    store: { read: unused, save: unused },
    admins: { list: unused, add: unused, remove: unused, setFlag: unused },
    web: {
      publicBaseUrl,
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      listening: unused,
    },
    privacy: { ipStorage: "hash", tokenStorage: true },
    app: {
      ownerId: GUILD,
      gatewayReady: true,
      gatewayPingMs: null,
      memberIntent: true,
      devGuildId: undefined,
      application: unused,
      selfTest: unused,
    },
    portal: { items: unused, permissionBits: unused, invite: unused },
    images: { current: unused, setAvatar: unused, setBanner: unused, setDisplayName: unused },
    files: { read: unused },
    docs: unused,
  };
}

function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...patch };
}

function context(settings_: GuildSettings, deps: SetupDeps = fakeDeps()): StepContext {
  return {
    guildId: GUILD,
    userId: "999999999999999999",
    settings: settings_,
    wizard: DEFAULT_WIZARD,
    deps,
  };
}

function renderOf(step: StepModule, ctx: StepContext): ContainerComponent {
  const out = step.render(ctx);
  if (out instanceof Promise) throw new Error("render must be synchronous in these tests");
  return out;
}

function applyOf(step: StepModule, ctx: StepContext, values: StepValues): Partial<GuildSettings> {
  const out = step.apply?.(ctx, values);
  if (out === undefined || out instanceof Promise) {
    throw new Error("apply must be synchronous in these tests");
  }
  return out;
}

function collect(value: unknown, out: { ids: string[]; texts: string[]; rows: number }): void {
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (typeof node.customID === "string") out.ids.push(node.customID);
  if (typeof node.content === "string") out.texts.push(node.content);
  if (node.type === ComponentTypes.ACTION_ROW) out.rows += 1;
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) collect(item, out);
    else if (typeof child === "object") collect(child, out);
  }
}

function inspect(value: unknown): { ids: string[]; texts: string[]; rows: number } {
  const out = { ids: [] as string[], texts: [] as string[], rows: 0 };
  collect(value, out);
  return out;
}

describe("the verify step", () => {
  test("its key is the wizard step key", () => {
    expect(verifyStep.key).toBe("verify");
  });

  test("renders inside the cap and within two control rows", () => {
    const seen = inspect(
      renderOf(verifyStep, context(settings({ verify_panel: { ...DEFAULT_VERIFY_PANEL } }))),
    );
    expect(countComponents(renderOf(verifyStep, context(settings())))).toBeLessThanOrEqual(
      PAGE_LIMIT,
    );
    expect(seen.rows).toBeLessThanOrEqual(2);
  });

  test("every customID it renders parses on the setup surface", () => {
    const seen = inspect(renderOf(verifyStep, context(settings())));
    expect(seen.ids.length).toBeGreaterThan(0);
    for (const id of seen.ids) expect(parseCustomId(id).surface).toBe("setup");
  });

  test("its modal's field customIDs parse on the setup surface", () => {
    const out = verifyStep.modal?.(context(settings()));
    expect(out).not.toBeNull();
    const seen = inspect(out);
    expect(seen.ids.length).toBeGreaterThan(0);
    for (const id of seen.ids) expect(parseCustomId(id).surface).toBe("setup");
  });

  test("the page tells the operator the redirect target goes into the Developer Panel", () => {
    const seen = inspect(renderOf(verifyStep, context(settings())));
    expect(seen.texts.some((text) => text.includes("https://verify.example.com/callback"))).toBe(
      true,
    );
    expect(seen.texts.some((text) => text.includes("Developer Panel"))).toBe(true);
  });

  test("apply builds the panel from the submission", () => {
    const ctx = context(settings({ verify_panel: { ...DEFAULT_VERIFY_PANEL } }));
    const values: StepValues = { [panelFieldId(GUILD, "title")]: "gate check" };
    const patch = applyOf(verifyStep, ctx, values);
    expect(patch.verify_panel?.title).toBe("gate check");
    expect(patch.verify_panel?.redirect_target).toBe("https://verify.example.com/callback");
  });

  test("apply refuses a restricted scope without an acknowledgement, naming it", () => {
    const ctx = context(settings());
    const values: StepValues = {
      [panelFieldId(GUILD, "scopes")]: ["identify", "relationships.read"],
    };
    expect(() => applyOf(verifyStep, ctx, values)).toThrow(SetupInputError);
    expect(() => applyOf(verifyStep, ctx, values)).toThrow("relationships.read");
  });

  test("apply allows a restricted scope once it is acknowledged", () => {
    const ctx = context(settings({ acknowledged_restricted_scopes: ISO_NOW }));
    const values: StepValues = { [panelFieldId(GUILD, "scopes")]: ["relationships.read"] };
    const patch = applyOf(verifyStep, ctx, values);
    expect(patch.verify_panel?.scopes).toEqual(["relationships.read"]);
  });

  test("apply ticks the acknowledgement from the submission", () => {
    const ctx = context(settings());
    const values: StepValues = {
      [panelFieldId(GUILD, "scopes")]: ["relationships.read"],
      [panelFieldId(GUILD, "ack")]: "1",
    };
    const patch = applyOf(verifyStep, ctx, values);
    expect(patch.acknowledged_restricted_scopes).toBe(ISO_NOW);
    expect(patch.verify_panel?.scopes).toEqual(["relationships.read"]);
  });

  test("apply leaves the acknowledgement alone when it is untouched", () => {
    const ctx = context(settings({ acknowledged_restricted_scopes: "2020-01-01T00:00:00.000Z" }));
    const patch = applyOf(verifyStep, ctx, { [panelFieldId(GUILD, "title")]: "x" });
    expect(patch.acknowledged_restricted_scopes).toBe("2020-01-01T00:00:00.000Z");
  });

  test("the channel select carries the send action with the channel cursor", () => {
    const seen = inspect(renderOf(verifyStep, context(settings())));
    expect(seen.ids).toContain(panelChannelId(GUILD));
  });
});
