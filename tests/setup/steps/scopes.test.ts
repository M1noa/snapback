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
import { panelAckId, panelFieldId } from "../../../src/setup/panel.ts";
import { scopesStep } from "../../../src/setup/steps/scopes.ts";

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

function fakeDeps(): SetupDeps {
  return {
    log,
    now: () => NOW,
    state: new MemoryStateStore(),
    logs: unused,
    postPanel: unused,
    store: { read: unused, save: unused },
    admins: { list: unused, add: unused, remove: unused, setFlag: unused },
    web: {
      publicBaseUrl: "https://verify.example.com",
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      captcha: "none",
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

function context(settings_: GuildSettings): StepContext {
  return {
    guildId: GUILD,
    userId: "999999999999999999",
    settings: settings_,
    wizard: DEFAULT_WIZARD,
    deps: fakeDeps(),
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

function collect(value: unknown, out: { ids: string[]; rows: number }): void {
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (typeof node.customID === "string") out.ids.push(node.customID);
  if (node.type === ComponentTypes.ACTION_ROW) out.rows += 1;
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) collect(item, out);
    else if (typeof child === "object") collect(child, out);
  }
}

function inspect(value: unknown): { ids: string[]; rows: number } {
  const out = { ids: [] as string[], rows: 0 };
  collect(value, out);
  return out;
}

const withPanel = (patch: Partial<GuildSettings> = {}): GuildSettings =>
  settings({ verify_panel: { ...DEFAULT_VERIFY_PANEL }, ...patch });

describe("the scopes step", () => {
  test("its key is the wizard step key", () => {
    expect(scopesStep.key).toBe("scopes");
  });

  test("renders inside the cap and within two control rows", () => {
    const seen = inspect(renderOf(scopesStep, context(withPanel())));
    expect(countComponents(renderOf(scopesStep, context(withPanel())))).toBeLessThanOrEqual(
      PAGE_LIMIT,
    );
    expect(seen.rows).toBeLessThanOrEqual(2);
  });

  test("every customID it produces parses on the setup surface", () => {
    const renderIds = inspect(renderOf(scopesStep, context(withPanel()))).ids;
    const modalIds = inspect(scopesStep.modal?.(context(withPanel()))).ids;
    expect(renderIds.length + modalIds.length).toBeGreaterThan(0);
    for (const id of [...renderIds, ...modalIds]) {
      expect(parseCustomId(id).surface).toBe("setup");
    }
  });

  test("its modal preselects the three defaults", () => {
    const out = scopesStep.modal?.(context(withPanel())) as {
      components: Array<{ component: { options?: Array<{ value: string; default?: boolean }> } }>;
    };
    const group = out.components.find((item) => item.component.options !== undefined);
    const preselected = (group?.component.options ?? [])
      .filter((option) => option.default === true)
      .map((option) => option.value);
    expect(preselected).toEqual(["identify", "email", "guilds.join"]);
  });

  test("apply saves the selected scopes into the panel", () => {
    const ctx = context(withPanel());
    const values: StepValues = { [panelFieldId(GUILD, "scopes")]: ["identify", "bogus", "guilds"] };
    const patch = applyOf(scopesStep, ctx, values);
    expect(patch.verify_panel?.scopes).toEqual(["identify", "guilds"]);
  });

  test("apply refuses a restricted scope without the acknowledgement, naming it", () => {
    const ctx = context(withPanel());
    const values: StepValues = {
      [panelFieldId(GUILD, "scopes")]: ["identify", "relationships.read"],
      [panelAckId(GUILD)]: undefined,
    };
    expect(() => applyOf(scopesStep, ctx, values)).toThrow(SetupInputError);
    expect(() => applyOf(scopesStep, ctx, values)).toThrow("relationships.read");
  });

  test("apply records the acknowledgement timestamp when it is ticked", () => {
    const ctx = context(withPanel());
    const values: StepValues = {
      [panelFieldId(GUILD, "scopes")]: ["relationships.read"],
      [panelAckId(GUILD)]: "1",
    };
    const patch = applyOf(scopesStep, ctx, values);
    expect(patch.acknowledged_restricted_scopes).toBe(ISO_NOW);
    expect(patch.verify_panel?.scopes).toEqual(["relationships.read"]);
  });

  test("apply clears the acknowledgement when the operator withdraws it", () => {
    const ctx = context(withPanel({ acknowledged_restricted_scopes: "2020-01-01T00:00:00.000Z" }));
    const values: StepValues = { [panelFieldId(GUILD, "scopes")]: ["identify", "email"] };
    const patch = applyOf(scopesStep, ctx, values);
    expect(patch.acknowledged_restricted_scopes).toBeNull();
  });

  test("apply returns no panel patch when no panel exists", () => {
    const ctx = context(settings());
    const values: StepValues = { [panelFieldId(GUILD, "scopes")]: ["identify"] };
    const patch = applyOf(scopesStep, ctx, values);
    expect("verify_panel" in patch).toBe(false);
    expect(patch.acknowledged_restricted_scopes).toBeNull();
  });
});
