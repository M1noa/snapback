import { describe, expect, test } from "bun:test";
import type { ContainerComponent } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_VERIFY_PANEL,
  type GuildSettings,
} from "../../src/config/defaults.ts";
import { countComponents, PAGE_LIMIT } from "../../src/discord/components/page.ts";
import { customID } from "../../src/discord/components/row.ts";
import {
  type HandlerSurface,
  type ModalRequest,
  parseCustomId,
  type ReplyRequest,
  Router,
  type SubmittedValue,
} from "../../src/discord/interactions/router.ts";
import { MemoryStateStore } from "../../src/discord/interactions/state.ts";
import { createLogger } from "../../src/lib/log.ts";
import {
  type SaveInput,
  SETUP_ACTION,
  SETUP_OBJECT,
  SETUP_SURFACE,
  type SettingsStore,
  type SetupDeps,
  setupCustomId,
} from "../../src/setup/deps.ts";
import { guideFilterId, guideIndex, guideObject, guidePage } from "../../src/setup/guide.ts";
import {
  openSetup,
  registerSetupHandlers,
  SETUP_SPECS,
  statusPage,
} from "../../src/setup/handlers.ts";
import {
  panelChannelId,
  panelDiscardId,
  panelFieldId,
  panelPreviewPage,
  panelSendId,
  panelSwatchId,
} from "../../src/setup/panel.ts";
import { WIZARD_STEP_KEYS } from "../../src/setup/state.ts";

const GUILD = "123456789012345678";
const OPENER = "987654321098765432";
const OTHER = "555555555555555555";
const ADMIN = "444444444444444444";
const OWNER = "111111111111111111";
const CHANNEL = "222222222222222222";

// ---- fakes ----------------------------------------------------------------

interface Recorder extends SettingsStore {
  readonly saves: SaveInput[];
  current: GuildSettings;
}

// a store that actually keeps what it saves, so a second press sees the first
// one's result. the real one clamps and audits; this one merges.
function fakeStore(settings: GuildSettings = DEFAULT_GUILD_SETTINGS): Recorder {
  const recorder: Recorder = {
    saves: [],
    current: settings,
    async read(): Promise<GuildSettings> {
      return recorder.current;
    },
    async save(input: SaveInput) {
      recorder.saves.push(input);
      recorder.current = { ...recorder.current, ...input.patch };
      return { settings: recorder.current, changed: [] };
    },
  };
  return recorder;
}

class FakeSurface implements HandlerSurface {
  readonly replies: ReplyRequest[] = [];
  readonly modals: ModalRequest[] = [];
  readonly values: Readonly<Record<string, SubmittedValue>>;
  readonly source: "component" | "modal";

  constructor(
    values: Readonly<Record<string, SubmittedValue>> = {},
    source: "component" | "modal" = "component",
  ) {
    this.values = values;
    this.source = source;
  }

  async reply(request: ReplyRequest): Promise<void> {
    this.replies.push(request);
  }

  async openModal(modal: ModalRequest): Promise<void> {
    this.modals.push(modal);
  }

  get message(): ContainerComponent {
    const last = this.replies.at(-1);
    if (last === undefined) throw new Error("nothing was answered");
    return last.message;
  }

  get private(): boolean {
    return this.replies.at(-1)?.ephemeral === true;
  }
}

interface Harness {
  readonly deps: SetupDeps;
  readonly router: Router;
  readonly store: Recorder;
  readonly admins: readonly string[];
  readonly posted: readonly string[];
}

function harness(settings: GuildSettings = DEFAULT_GUILD_SETTINGS, users: string[] = []): Harness {
  const store = fakeStore(settings);
  const admins: string[] = users;
  const posted: string[] = [];
  const deps: SetupDeps = {
    log: createLogger({ level: "error", dir: null }),
    now: () => 0,
    store,
    admins: {
      list: async () => [],
      add: async (_guildId, userId) => {
        admins.push(`add:${userId}`);
      },
      remove: async (_guildId, userId) => {
        admins.push(`remove:${userId}`);
      },
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
      ownerId: OWNER,
      gatewayReady: true,
      gatewayPingMs: 20,
      memberIntent: true,
      devGuildId: undefined,
      application: async () => ({
        id: "222222222222222222",
        name: "snapback",
        botUserId: "333333333333333333",
        ownerId: OWNER,
        flags: 0,
        intents: 0,
      }),
      selfTest: async () => [
        { step: "token", passed: true, said: "the token authenticated", fix: null },
      ],
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
    docs: async () => "# a shipped doc\n\nbody line",
    state: new MemoryStateStore(),
    logs: async () => ({ posted: true, said: "test event posted", fix: null }),
    postPanel: async (_panel, channelId) => {
      posted.push(channelId);
    },
  };
  const router = registerSetupHandlers(new Router({ authorize: () => ({ kind: "allow" }) }), deps);
  return { deps, router, store, admins, posted };
}

async function press(
  h: Harness,
  rawId: string,
  surface = new FakeSurface(),
  userId = OPENER,
): Promise<FakeSurface> {
  const outcome = await h.router.route(
    rawId,
    { userId, guildId: GUILD, isOwner: userId === OWNER },
    surface,
  );
  expect(outcome.kind).toBe("handled");
  return surface;
}

// ---- the tree walker ------------------------------------------------------

interface Node {
  customID?: string;
  content?: string;
  components?: Node[];
  accessory?: Node;
  component?: Node;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || typeof node !== "object") return;
  // a modal's body is handed over as an array, so the walker has to enter one
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  visit(n);
  if (Array.isArray(n.components)) for (const child of n.components) walk(child, visit);
  if (n.accessory) walk(n.accessory, visit);
  if (n.component) walk(n.component, visit);
}

function producedIds(tree: unknown): string[] {
  const out: string[] = [];
  walk(tree, (n) => {
    if (typeof n.customID === "string" && n.customID.startsWith("sb:")) out.push(n.customID);
  });
  return out;
}

function text(tree: unknown): string {
  const out: string[] = [];
  walk(tree, (n) => {
    if (typeof n.content === "string") out.push(n.content);
  });
  return out.join("\n");
}

type SurfaceObject = (typeof SETUP_OBJECT)[keyof typeof SETUP_OBJECT];

function idOf(object: SurfaceObject, action: string, cursor = ""): string {
  return setupCustomId({ guildId: GUILD, object, action, cursor });
}

// a guide page's object slot is the doc name, which is not in SETUP_OBJECT: the
// guide builds its own ids through customID() for exactly that reason.
function guideId(action: string, cursor = ""): string {
  return customID({ surface: SETUP_SURFACE, guild: GUILD, object: GUIDE_DOC, action, cursor });
}

function withOpener(wizard: GuildSettings["wizard"], userId: string | null): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, wizard: { ...wizard, opened_by: userId } };
}

// a wizard whose panel exists but has no channel yet, which is where the send
// button has to say what to do rather than post nothing.
function withPanel(channelId: string | null): GuildSettings {
  return {
    ...DEFAULT_GUILD_SETTINGS,
    verify_panel: { ...DEFAULT_VERIFY_PANEL, channel_id: channelId },
    wizard: { ...DEFAULT_GUILD_SETTINGS.wizard, opened_by: OPENER },
  };
}

// ---- registration ---------------------------------------------------------

describe("registerSetupHandlers", () => {
  test("registration and the spec list agree in both directions", () => {
    const { router } = harness();
    const fromSpecs = [
      ...new Set(SETUP_SPECS.map((spec) => `${spec.surface}:${spec.action}`)),
    ].sort();

    expect(SETUP_SPECS.every((spec) => spec.surface === SETUP_SURFACE)).toBe(true);
    expect(router.registeredKeys()).toEqual(fromSpecs);
    expect(router.missing(SETUP_SPECS)).toEqual([]);
    expect(() => router.assertComplete(SETUP_SPECS)).not.toThrow();
  });

  test("every wizard step key has a handler, so a new step cannot ship unregistered", () => {
    const { router } = harness();
    for (const key of WIZARD_STEP_KEYS) expect(router.has(SETUP_SURFACE, key)).toBe(true);
  });
});

// ---- every page, every produced id ---------------------------------------

interface Entry {
  readonly label: string;
  readonly id: string;
  readonly values?: Readonly<Record<string, SubmittedValue>>;
  readonly source?: "component" | "modal";
}

const GUIDE_DOC = guideObject("setup");

function entries(): Entry[] {
  const nav = (action: string, cursor = "") => idOf(SETUP_OBJECT.nav, action, cursor);
  const jump = nav(SETUP_ACTION.jump);
  const add = idOf(SETUP_OBJECT.admin, SETUP_ACTION.add);
  const filter = guideFilterId(GUILD, GUIDE_DOC); // the guide's own builder, not ours

  const logToggle = idOf(SETUP_OBJECT.log, SETUP_ACTION.toggle, "channel");
  const privacyModal = idOf(SETUP_OBJECT.modal, "privacy");
  const channel = panelChannelId(GUILD);

  return [
    { label: "status", id: nav(SETUP_ACTION.status) },
    { label: "jump", id: jump, values: { [jump]: "verify" } },
    { label: "next", id: nav(SETUP_ACTION.next, "welcome") },
    { label: "prev", id: nav(SETUP_ACTION.prev, "admins") },
    { label: "skip", id: nav(SETUP_ACTION.skip, "branding") },
    { label: "probe", id: nav(SETUP_ACTION.probe) },
    ...WIZARD_STEP_KEYS.map((key) => ({
      label: `step ${key}`,
      id: idOf(SETUP_OBJECT.step, key),
    })),
    {
      label: "privacy modal",
      id: privacyModal,
      source: "modal",
      values: { [privacyModal]: "a disclosure we wrote" },
    },
    { label: "log channel", id: logToggle, values: { [logToggle]: CHANNEL } },
    { label: "log test fire", id: idOf(SETUP_OBJECT.log, SETUP_ACTION.testfire) },
    { label: "app test", id: idOf(SETUP_OBJECT.app, SETUP_ACTION.test) },
    { label: "admin add", id: add, values: { [add]: ADMIN } },
    { label: "admin remove", id: idOf(SETUP_OBJECT.admin, SETUP_ACTION.remove, ADMIN) },
    { label: "panel swatch", id: panelSwatchId(GUILD, "#5865f2") },
    { label: "panel channel", id: channel, values: { [channel]: CHANNEL } },
    {
      label: "panel field",
      id: panelFieldId(GUILD, "title"),
      values: { [panelFieldId(GUILD, "title")]: "verify to enter" },
    },
    { label: "panel send", id: panelSendId(GUILD) },
    { label: "panel discard", id: panelDiscardId(GUILD) },
    { label: "guide filter", id: guideId("filter"), values: { [filter]: "scopes" } },
    { label: "guide page", id: guideId("page-next", "2") },
    { label: "guide prev", id: guideId("page-prev", "1") },
  ];
}

describe("the surface's own pages", () => {
  test("no page on this surface produces an id the router cannot route", async () => {
    let seen = 0;
    let entriesWithIds = 0;
    for (const entry of entries()) {
      const h = harness();
      const surface = await press(
        h,
        entry.id,
        new FakeSurface(entry.values ?? {}, entry.source ?? "component"),
      );

      // a step whose control opens a modal answers with the modal and no message
      const messages = surface.replies.map((reply) => reply.message);
      const ids = [
        ...messages.flatMap(producedIds),
        ...surface.modals.flatMap((modal) => producedIds(modal.components)),
      ];
      if (ids.length > 0) entriesWithIds += 1;

      for (const raw of ids) {
        seen += 1;
        const parsed = parseCustomId(raw);
        expect(parsed.surface).toBe(SETUP_SURFACE);
        if (!h.router.has(parsed.surface, parsed.action)) {
          throw new Error(`${entry.label} produced ${raw}, which has no handler`);
        }
      }
      for (const message of messages) {
        expect(countComponents(message)).toBeLessThanOrEqual(PAGE_LIMIT);
      }
    }
    // the loop is not vacuous: these pages between them produce a lot of controls.
    // a report or failure page carries none on purpose, so the count is global.
    expect(seen).toBeGreaterThan(40);
    expect(entriesWithIds).toBeGreaterThan(20);
  });

  test("the hub, the finish page, the panel preview and a guide page are all reachable", async () => {
    const h = harness();
    expect(countComponents(statusPage(GUILD, DEFAULT_GUILD_SETTINGS))).toBeLessThanOrEqual(
      PAGE_LIMIT,
    );

    const preview = panelPreviewPage(DEFAULT_VERIFY_PANEL, {
      guildId: GUILD,
      publicBaseUrl: "https://verify.example",
    });
    expect(producedIds(preview).length).toBeGreaterThan(0);
    const docs = { docs: h.deps.docs, guildId: GUILD };
    expect(producedIds(await guidePage(docs, GUIDE_DOC, 1)).length).toBeGreaterThan(0);
    expect(producedIds(guideIndex(GUILD, GUIDE_DOC)).length).toBeGreaterThan(0);
  });
});

// ---- the dispatch rule ----------------------------------------------------

describe("one handler per step, two shapes of interaction", () => {
  test("a control with no cursor and no values opens the step's modal", async () => {
    const h = harness();
    const surface = await press(h, idOf(SETUP_OBJECT.step, "privacy"));

    expect(surface.modals).toHaveLength(1);
    expect(surface.modals[0]?.customID).toBe(idOf(SETUP_OBJECT.modal, "privacy"));
    expect(h.store.saves).toHaveLength(0);
  });

  test("the modal it opens then saves, under the same customID", async () => {
    const h = harness();
    const modal = idOf(SETUP_OBJECT.modal, "privacy");
    const surface = await press(
      h,
      modal,
      new FakeSurface({ [modal]: "a disclosure we wrote" }, "modal"),
    );

    expect(h.store.saves).toHaveLength(1);
    expect(h.store.saves[0]?.action).toBe("setup.privacy");
    expect(h.store.saves[0]?.actorUserId).toBe(OPENER);
    expect(h.store.saves[0]?.patch.privacy_disclosure_text).toBe("a disclosure we wrote");
    expect(h.store.saves[0]?.patch.wizard?.steps.privacy?.done).toBe(true);
    // and the answer is the step again, now done
    expect(text(surface.message)).toContain("privacy");
  });

  test("a control carrying a cursor submits without opening anything", async () => {
    const h = harness();
    const surface = await press(h, panelSwatchId(GUILD, "#5865f2"));

    expect(surface.modals).toHaveLength(0);
    expect(h.store.saves).toHaveLength(1);
    expect(h.store.saves[0]?.action).toBe("setup.verify");
    // the save lands on the real preview, not the step's own summary (10.3)
    expect(text(surface.message)).toContain("verification panel preview");
  });

  test("the panel modal saves its fields and shows them in the preview", async () => {
    const h = harness();
    const modal = idOf(SETUP_OBJECT.modal, "verify");
    const title = panelFieldId(GUILD, "title");
    const surface = await press(h, modal, new FakeSurface({ [title]: "verify to enter" }, "modal"));

    expect(h.store.saves).toHaveLength(1);
    expect(h.store.saves[0]?.patch.verify_panel?.title).toBe("verify to enter");
    expect(text(surface.message)).toContain("verify to enter");
  });
});

// ---- rule 8 ---------------------------------------------------------------

describe("authorisation", () => {
  test("a step press from someone who did not open the wizard is refused, and writes nothing", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OTHER));
    const surface = await press(h, idOf(SETUP_OBJECT.step, "logs"), new FakeSurface(), ADMIN);

    expect(surface.private).toBe(true);
    expect(text(surface.message)).toContain(`<@${OTHER}>`);
    expect(h.store.saves).toHaveLength(0);
  });

  test("the opener is let through", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const surface = await press(h, idOf(SETUP_OBJECT.step, "logs"), new FakeSurface(), OPENER);
    expect(surface.private).toBe(false);
    expect(text(surface.message)).toContain("logging");
  });

  test("a required step cannot be skipped", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const surface = await press(h, idOf(SETUP_OBJECT.nav, SETUP_ACTION.skip, "welcome"));

    expect(surface.private).toBe(true);
    expect(text(surface.message)).toContain("cannot be skipped");
    expect(h.store.saves).toHaveLength(0);
  });

  test("skipping an optional step records it and moves on", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    await press(h, idOf(SETUP_OBJECT.nav, SETUP_ACTION.skip, "branding"));

    expect(h.store.saves[0]?.action).toBe("setup.branding.skipped");
    expect(h.store.saves[0]?.patch.wizard?.steps.branding?.skipped).toBe(true);
  });
});

// ---- destructive confirmations -------------------------------------------

describe("admin removal", () => {
  function confirmIdOf(surface: FakeSurface): string {
    const nonce = producedIds(surface.message)
      .filter((raw) => parseCustomId(raw).action === SETUP_ACTION.remove)
      .map((raw) => parseCustomId(raw).cursor)
      .filter((cursor) => cursor !== "" && cursor !== ADMIN);
    expect(nonce).toHaveLength(1);
    return idOf(SETUP_OBJECT.admin, SETUP_ACTION.remove, nonce[0]);
  }

  test("the first press confirms instead of removing", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const surface = await press(h, idOf(SETUP_OBJECT.admin, SETUP_ACTION.remove, ADMIN));

    expect(h.admins).toEqual([]);
    expect(text(surface.message)).toContain("remove an admin");
    // the confirmation expires, and it says so as a discord relative timestamp
    expect(text(surface.message)).toContain("<t:");
  });

  test("the confirmation removes once, and the nonce cannot be replayed", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const confirm = await press(h, idOf(SETUP_OBJECT.admin, SETUP_ACTION.remove, ADMIN));
    const nonce = confirmIdOf(confirm);

    await press(h, nonce);
    expect(h.admins).toEqual([`remove:${ADMIN}`]);

    // one press, one removal: the row was consumed before the write
    const again = await press(h, nonce);
    expect(h.admins).toEqual([`remove:${ADMIN}`]);
    expect(again.private).toBe(true);
  });

  test("a nonce minted for someone else is not used", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const confirm = await press(h, idOf(SETUP_OBJECT.admin, SETUP_ACTION.remove, ADMIN));
    const nonce = confirmIdOf(confirm);

    // the wizard changes hands, so the press passes the opener check and reaches
    // the nonce's own guard, which is the one being tested here.
    h.store.current = withOpener(h.store.current.wizard, OTHER);
    const surface = await press(h, nonce, new FakeSurface(), OTHER);

    expect(h.admins).toEqual([]);
    expect(surface.private).toBe(true);
    expect(text(surface.message)).toContain("not yours");
  });

  test("the instance owner cannot be removed from here", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const surface = await press(h, idOf(SETUP_OBJECT.admin, SETUP_ACTION.remove, OWNER));

    expect(h.admins).toEqual([]);
    expect(text(surface.message)).toContain("instance owner");
    // no nonce was minted, so there is nothing to press twice
    expect(producedIds(surface.message).filter((raw) => parseCustomId(raw).cursor !== "")).toEqual(
      [],
    );
  });

  test("adding an admin writes through the store, not the settings", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const add = idOf(SETUP_OBJECT.admin, SETUP_ACTION.add);
    await press(h, add, new FakeSurface({ [add]: ADMIN }));

    expect(h.admins).toEqual([`add:${ADMIN}`]);
    expect(h.store.saves).toHaveLength(0);
  });
});

// ---- the panel post -------------------------------------------------------

describe("posting the verification panel", () => {
  test("with no channel chosen, send says what to do instead of failing silently", async () => {
    const h = harness(withPanel(null));
    const surface = await press(h, panelSendId(GUILD));

    expect(h.posted).toEqual([]);
    expect(surface.private).toBe(true);
    expect(text(surface.message)).toContain("no channel");
  });

  test("discord's own words are shown verbatim when the post fails", async () => {
    const store = fakeStore(withPanel(CHANNEL));
    const h = harness();
    const deps: SetupDeps = {
      ...h.deps,
      store,
      postPanel: async () => {
        throw new Error("missing access");
      },
    };
    const router = registerSetupHandlers(
      new Router({ authorize: () => ({ kind: "allow" }) }),
      deps,
    );
    const surface = new FakeSurface();
    const outcome = await router.route(
      panelSendId(GUILD),
      { userId: OPENER, guildId: GUILD, isOwner: false },
      surface,
    );

    expect(outcome.kind).toBe("handled");
    expect(surface.private).toBe(true);
    expect(text(surface.message)).toContain("missing access");
  });

  test("a good post names the channel it landed in", async () => {
    const h = harness(withPanel(CHANNEL));
    const surface = await press(h, panelSendId(GUILD));

    expect(h.posted).toEqual([CHANNEL]);
    expect(text(surface.message)).toContain(`<#${CHANNEL}>`);
  });
});

// ---- the entry point ------------------------------------------------------

describe("openSetup", () => {
  test("running the command takes the wizard over", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OTHER));
    await openSetup({ deps: h.deps, guildId: GUILD, userId: OPENER });

    expect(h.store.saves[0]?.action).toBe("setup.open");
    expect(h.store.saves[0]?.patch.wizard?.opened_by).toBe(OPENER);
  });

  test("it opens the step that was asked for, and the first open one otherwise", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    const asked = await openSetup({
      deps: h.deps,
      guildId: GUILD,
      userId: OPENER,
      stepKey: "logs",
    });
    expect(text(asked)).toContain("logging");
    expect(producedIds(asked).some((raw) => parseCustomId(raw).cursor === "logs")).toBe(true);

    const unknown = await openSetup({
      deps: h.deps,
      guildId: GUILD,
      userId: OPENER,
      stepKey: "nonsense",
    });
    expect(text(unknown)).toContain("welcome");
  });

  test("an already owned wizard is not rewritten", async () => {
    const h = harness(withOpener(DEFAULT_GUILD_SETTINGS.wizard, OPENER));
    await openSetup({ deps: h.deps, guildId: GUILD, userId: OPENER });
    expect(h.store.saves).toHaveLength(0);
  });
});
