import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import { DEFAULT_GUILD_SETTINGS, type GuildSettings } from "../../../src/config/defaults.ts";
import { parseCustomId } from "../../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../../src/discord/interactions/state.ts";
import type { Logger } from "../../../src/lib/log.ts";
import {
  type AdminEntry,
  SETUP_ACTION,
  SETUP_OBJECT,
  type SetupDeps,
  type StepContext,
} from "../../../src/setup/deps.ts";
import { adminsStep } from "../../../src/setup/steps/admins.ts";

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

const ADMIN: AdminEntry = {
  userId: "700000000000000007",
  addedBy: "100000000000000001",
  addedAt: "2026-10-16T12:00:00.000Z",
  flags: {
    canBackup: true,
    canRestore: true,
    canManageAdmins: false,
    canViewRecords: true,
    canDeleteRecords: false,
  },
};

function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...patch } as GuildSettings;
}

function makeDeps(admins: readonly AdminEntry[]): SetupDeps {
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
      list: async () => admins,
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

function context(deps: SetupDeps): StepContext {
  const base = settings();
  return { guildId: GUILD, userId: USER, settings: base, wizard: base.wizard, deps };
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

function bodyText(tree: ContainerComponent): string {
  return tree.components
    .filter((child) => child.type === 10)
    .map((child) => (child as { content: string }).content)
    .join("\n");
}

describe("admins render", () => {
  test("is a v2 container carrying the status word", async () => {
    const tree = await adminsStep.render(context(makeDeps([])));
    expect(tree.type).toBe(17);
    expect((tree.components[0] as { content: string }).content).toContain("-# waiting");
  });

  test("an empty list renders the empty-state sentence", async () => {
    const tree = await adminsStep.render(context(makeDeps([])));
    expect(bodyText(tree)).toContain("no admins yet - add one below.");
  });

  test("names a current admin with a mention and a flag word list", async () => {
    const tree = await adminsStep.render(context(makeDeps([ADMIN])));
    const body = bodyText(tree);
    expect(body).toContain(`<@${ADMIN.userId}>`);
    expect(body).toContain("backup, restore, records");
  });

  test("says new admins get every flag and points at /admin", async () => {
    const tree = await adminsStep.render(context(makeDeps([ADMIN])));
    const body = bodyText(tree);
    expect(body).toContain("/admin");
    expect(body).toContain("every flag");
  });

  test("every produced customID parses with surface setup", async () => {
    const tree = await adminsStep.render(context(makeDeps([ADMIN])));
    const ids = collectIds(tree);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const parsed = parseCustomId(id);
      expect(parsed.surface).toBe("setup");
      expect(parsed.guild).toBe(GUILD);
      expect(parsed.object).toBe(SETUP_OBJECT.admin);
    }
  });

  test("the add-me button carries the invoking user as its cursor", async () => {
    const tree = await adminsStep.render(context(makeDeps([ADMIN])));
    const ids = collectIds(tree);
    const addMe = ids.map((id) => parseCustomId(id)).find((parsed) => parsed.cursor === USER);
    expect(addMe?.action).toBe(SETUP_ACTION.add);
  });

  test("each admin gets a remove button carrying its own id", async () => {
    const tree = await adminsStep.render(context(makeDeps([ADMIN])));
    const ids = collectIds(tree);
    const remove = ids
      .map((id) => parseCustomId(id))
      .find((parsed) => parsed.action === SETUP_ACTION.remove);
    expect(remove?.cursor).toBe(ADMIN.userId);
  });
});
