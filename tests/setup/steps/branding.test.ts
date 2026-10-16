import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS, type GuildSettings } from "../../../src/config/defaults.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import type { Logger } from "../../../src/lib/log.ts";
import {
  SETUP_OBJECT,
  type SetupDeps,
  SetupInputError,
  type StepContext,
  type StepValues,
  setupCustomId,
} from "../../../src/setup/deps.ts";
import { brandingStep } from "../../../src/setup/steps/branding.ts";

const GUILD = "200000000000000002";
const USER = "100000000000000001";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");

const silent: Logger = {
  level: "error",
  debug() {},
  info() {},
  warn() {},
  error() {},
  async flush() {},
};

function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...patch } as GuildSettings;
}

function makeDeps(): SetupDeps {
  return {
    log: silent,
    now: () => NOW,
    state: new MemoryStateStore(),
    logs: async () => ({ posted: true, said: "test event posted", fix: null }),
    postPanel: async () => {},
    store: {
      read: async () => settings(),
      save: async () => ({ settings: settings(), changed: [] }),
    },
    admins: {
      list: async () => [],
      add: async () => {},
      remove: async () => {},
      setFlag: async () => {},
    },
    web: {
      publicBaseUrl: "https://snapback.example",
      port: 8080,
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      listening: async () => true,
    },
    privacy: { ipStorage: "hash", tokenStorage: false },
    app: {
      ownerId: USER,
      gatewayReady: true,
      gatewayPingMs: 10,
      memberIntent: true,
      devGuildId: undefined,
      application: async () => ({
        id: "300000000000000003",
        name: "snapback",
        botUserId: "400000000000000004",
        ownerId: USER,
        flags: 0,
        intents: 0,
      }),
      selfTest: async () => [],
    },
    portal: {
      items: async () => [],
      permissionBits: () => "0",
      invite: () => "https://discord.com/oauth2/authorize?client_id=1",
    },
    images: {
      current: async () => ({ displayName: null, avatarSet: false, bannerSet: false }),
      setAvatar: async () => {},
      setBanner: async () => {},
      setDisplayName: async () => {},
    },
    files: {
      read: async () => ({ bytes: new Uint8Array(), filename: "x.png", contentType: "image/png" }),
    },
    docs: async () => null,
  };
}

function context(deps: SetupDeps, patch: Partial<GuildSettings> = {}): StepContext {
  const base = settings(patch);
  return { guildId: GUILD, userId: USER, settings: base, wizard: base.wizard, deps };
}

function idFor(cursor: string): string {
  return setupCustomId({ guildId: GUILD, object: SETUP_OBJECT.step, action: "branding", cursor });
}

function collectIds(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  const node = value as {
    customID?: unknown;
    components?: unknown;
    accessory?: unknown;
    component?: unknown;
  };
  if (typeof node.customID === "string") out.push(node.customID);
  if (Array.isArray(node.components)) for (const child of node.components) collectIds(child, out);
  if (node.accessory !== undefined) collectIds(node.accessory, out);
  if (node.component !== undefined) collectIds(node.component, out);
  return out;
}

function pageText(tree: ContainerComponent): string {
  return (tree.components[0] as { content: string }).content;
}

describe("branding render", () => {
  test("is a v2 container carrying the status word", async () => {
    const tree = await brandingStep.render(context(makeDeps()));
    expect(tree.type).toBe(17);
    expect(pageText(tree)).toContain("-# waiting");
  });

  test("shows the current state and says nothing uploads until submit", async () => {
    const tree = await brandingStep.render(context(makeDeps()));
    const body = tree.components
      .filter((child) => child.type === 10)
      .map((child) => (child as { content: string }).content)
      .join("\n");
    expect(body).toContain("nothing is uploaded until you submit the form");
    expect(body).toContain("display name: not set");
    expect(body).toContain("avatar: not set");
    expect(body).toContain("banner: not set");
  });

  test("every produced customID parses with surface setup", async () => {
    const ctx = context(makeDeps());
    const tree = await brandingStep.render(ctx);
    const ids = collectIds(tree);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const parsed = parseCustomId(id);
      expect(parsed.surface).toBe("setup");
      expect(parsed.guild).toBe(GUILD);
    }
  });
});

describe("branding modal", () => {
  test("carries the three fields with the right cursors", () => {
    const ctx = context(makeDeps());
    const modal = brandingStep.modal?.(ctx);
    expect(modal?.title).toBe("branding");
    const ids = (modal?.components ?? []).flatMap((component) => collectIds(component));
    expect(ids).toContain(idFor("avatar"));
    expect(ids).toContain(idFor("banner"));
    expect(ids).toContain(idFor("name"));
    for (const id of ids) {
      const parsed = parseCustomId(id);
      expect(parsed.surface).toBe("setup");
      expect(parsed.object).toBe(SETUP_OBJECT.step);
      expect(parsed.action).toBe("branding");
    }
  });

  test("prefills the display name from settings", () => {
    const ctx = context(makeDeps(), {
      branding: { display_name: "helper", avatar_set: false, banner_set: false },
    });
    const modal = brandingStep.modal?.(ctx);
    const json = JSON.stringify(modal);
    expect(json).toContain("helper");
  });
});

describe("branding apply", () => {
  test("wraps a bad image into SetupInputError", async () => {
    const deps = makeDeps();
    deps.files.read = async () => ({
      bytes: new TextEncoder().encode("not an image"),
      filename: "avatar.png",
      contentType: "image/png",
    });
    const values: StepValues = { [idFor("avatar")]: "500000000000000005" };

    await expect(brandingStep.apply?.(context(deps), values)).rejects.toThrow(SetupInputError);
    try {
      await brandingStep.apply?.(context(deps), values);
    } catch (error) {
      const input = error as SetupInputError;
      expect(input.field).toBe("avatar");
      expect(input.message).toContain("not an image");
    }
  });

  test("returns the flags when nothing is uploaded", async () => {
    const patch = await brandingStep.apply?.(context(makeDeps()), {});
    expect(patch).toEqual({
      branding: { display_name: null, avatar_set: false, banner_set: false },
    });
  });

  test("sets the avatar and banner flags when both files are valid", async () => {
    const calls: string[] = [];
    const deps = makeDeps();
    deps.files.read = async () => ({
      // a square 1x1 rgb png, built here.
      bytes: squarePng(),
      filename: "a.png",
      contentType: "image/png",
    });
    deps.images.setAvatar = async () => {
      calls.push("avatar");
    };
    deps.images.setBanner = async () => {
      calls.push("banner");
    };

    const values: StepValues = {
      [idFor("avatar")]: "500000000000000005",
      [idFor("banner")]: "600000000000000006",
    };
    const patch = await brandingStep.apply?.(context(deps), values);
    expect(patch).toEqual({
      branding: { display_name: null, avatar_set: true, banner_set: true },
    });
    expect(calls).toEqual(["avatar", "banner"]);
  });

  test("writes the display name when it changed", async () => {
    const names: string[] = [];
    const deps = makeDeps();
    deps.images.setDisplayName = async (name) => {
      names.push(name);
    };
    const patch = await brandingStep.apply?.(context(deps), { [idFor("name")]: "  my bot " });
    expect(names).toEqual(["my bot"]);
    expect(patch?.branding?.display_name).toBe("my bot");
  });
});

// a 1x1 rgb png, real bytes through the same chunk math the module uses.
function squarePng(): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr[3] = 1; // width 1
  ihdr[7] = 1; // height 1
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type rgb
  const raw = new Uint8Array([0, 10, 20, 30]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Bun.deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

const CRC = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const length = data.length;
  out[0] = (length >>> 24) & 0xff;
  out[1] = (length >>> 16) & 0xff;
  out[2] = (length >>> 8) & 0xff;
  out[3] = length & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC[(crc ^ out[i]!) & 0xff]! ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const at = 8 + data.length;
  out[at] = (crc >>> 24) & 0xff;
  out[at + 1] = (crc >>> 16) & 0xff;
  out[at + 2] = (crc >>> 8) & 0xff;
  out[at + 3] = crc & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
