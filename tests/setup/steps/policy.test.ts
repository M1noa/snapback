// tests/setup/steps/policy.test.ts - the verification policy step. two selects,
// one page, both rules off by default, and an unknown value leaves the setting
// where it was rather than guessing.

import { describe, expect, test } from "bun:test";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_WIZARD,
  type GuildSettings,
} from "../../../src/config/defaults.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import type { Logger } from "../../../src/lib/log.ts";
import {
  SETUP_OBJECT,
  type SetupDeps,
  type StepContext,
  type StepValues,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { policyStep } from "../../../src/setup/steps/policy.ts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const GUILD = "123456789012345678";

const log: Logger = {
  level: "error",
  verbose() {},
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

function renderOf(ctx: StepContext): ContainerComponent {
  return policyStep.render(ctx) as ContainerComponent;
}

function applyOf(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
  const out = policyStep.apply?.(ctx, values);
  if (out === undefined || out instanceof Promise) throw new Error("apply must be synchronous");
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

const id = (field: "vpn" | "alt"): string =>
  setupCustomId({ guildId: GUILD, object: SETUP_OBJECT.policy, action: "policy", cursor: field });

describe("the policy step", () => {
  test("its key is the wizard step key", () => {
    expect(policyStep.key).toBe("policy");
  });

  test("it renders inside the cap and within two control rows", () => {
    const html = renderOf(context(settings()));
    expect(countComponents(html)).toBeLessThanOrEqual(PAGE_LIMIT);
    expect(inspect(html).rows).toBe(2);
  });

  test("every customID it renders parses on the setup surface", () => {
    const seen = inspect(renderOf(context(settings())));
    expect(seen.ids).toEqual([id("vpn"), id("alt")]);
    for (const rendered of seen.ids) expect(parseCustomId(rendered).surface).toBe("setup");
  });

  test("the page names both rules and their current values", () => {
    const seen = inspect(
      renderOf(context(settings({ verify_vpn_policy: "block", verify_alt_policy: "flag" }))),
    );
    const body = seen.texts.join("\n");
    expect(body).toContain("network `block`");
    expect(body).toContain("alt check `flag`");
  });

  test("a chosen value is the one saved", () => {
    const patch = applyOf(context(settings()), { [id("vpn")]: "block", [id("alt")]: "flag" });
    expect(patch.verify_vpn_policy).toBe("block");
    expect(patch.verify_alt_policy).toBe("flag");
  });

  test("a value that is not one of the choices leaves the setting alone", () => {
    const patch = applyOf(context(settings({ verify_vpn_policy: "block" })), {
      [id("vpn")]: "banish",
      [id("alt")]: "flag",
    });
    expect(patch.verify_vpn_policy).toBe("block");
    expect(patch.verify_alt_policy).toBe("flag");
  });

  test("a page submitted with no select touched saves nothing new", () => {
    const patch = applyOf(context(settings({ verify_alt_policy: "flag" })), {});
    expect(patch.verify_vpn_policy).toBe("off");
    expect(patch.verify_alt_policy).toBe("flag");
  });
});
