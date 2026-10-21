// the setup wizard, end to end, over a real temp-file duckdb: the real step
// modules, the real handlers, and the db-backed stores src/setup/wiring.ts wires
// in production. this is the check that a full pass saves, a re-run shows
// prefilled values, audit rows exist, a partial setup resumes after a restart,
// and a second identical pass changes no value.
//
// the stores below are the same shapes wiring.ts produces: a db-backed
// SettingsStore that merges/clamps through config/defaults.ts and appends one
// audit row per save that moved something, a TableStateStore over a real
// StateTable, and a db-backed AdminStore. they are built directly here so the
// test never depends on a network client. every query module is the real one;
// only the outer assembly is local.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { ContainerComponent } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  type GuildSettings,
  LOG_EVENT_FAMILIES,
  mergeGuildSettings,
} from "../../src/config/defaults.ts";
import * as adminsDb from "../../src/db/queries/admins.ts";
import * as auditDb from "../../src/db/queries/audit.ts";
import * as guildsDb from "../../src/db/queries/guilds.ts";
import * as interactionDb from "../../src/db/queries/interaction-state.ts";
import type { AuditLogRow, Database, GuildAdminRow, SqlParam } from "../../src/db/types.ts";
import {
  type HandlerSurface,
  type ModalRequest,
  parseCustomId,
  type ReplyRequest,
  Router,
  type SubmittedValue,
} from "../../src/discord/interactions/router.ts";
import {
  type StateStore,
  type StateTable,
  TableStateStore,
} from "../../src/discord/interactions/state.ts";
import { createLogger } from "../../src/lib/log.ts";
import {
  type AdminEntry,
  type AdminStore,
  type SaveInput,
  SETUP_ACTION,
  SETUP_OBJECT,
  type SettingsStore,
  type SetupDeps,
  setupCustomId,
} from "../../src/setup/deps.ts";
import { openSetup, registerSetupHandlers } from "../../src/setup/handlers.ts";
import { panelAckId, panelFieldId } from "../../src/setup/panel.ts";
import { isComplete, WIZARD_STEP_KEYS } from "../../src/setup/state.ts";

const GUILD = "123456789012345678";
const OPENER = "987654321098765432";
const OWNER = "111111111111111111";
const BOT = "333333333333333333";
const CHANNEL = "222222222222222222";

// a fixed clock, so an iso timestamp is identical on every save. the idempotency
// check depends on it: a moving clock would make every step look changed.
const FIXED_NOW = 1_700_000_000_000;
const SCHEMA = new URL("../../src/db/schema.sql", import.meta.url);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---- the database ---------------------------------------------------------

// copied from tests/db/queries.test.ts: the adapter every db test binds.
function adapter(connection: DuckDBConnection): Database {
  return {
    kind: "duckdb",
    async query<T>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const reader = await connection.runAndReadAll(sql, params as never);
      return reader.getRowObjectsJS() as unknown as T[];
    },
    async run(sql: string, params?: SqlParam[]): Promise<void> {
      await connection.run(sql, params as never);
    },
    async exec(script: string): Promise<void> {
      await connection.run(script);
    },
    async close(): Promise<void> {
      connection.closeSync();
    },
  };
}

interface Handle {
  readonly db: Database;
  close(): void;
}

// open the one duckdb file in dir. duckdb allows a single writer, so reopening
// the same file means closing first: that close-and-reopen is the restart.
async function openHandle(dir: string): Promise<Handle> {
  const instance = await DuckDBInstance.create(join(dir, "snapback.duckdb"));
  const conn = await instance.connect();
  await conn.run(await Bun.file(SCHEMA).text()); // idempotent, so a reopen is safe
  return {
    db: adapter(conn),
    close(): void {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

interface Temp {
  readonly dir: string;
  readonly handle: Handle;
  close(): void;
}

async function openTemp(): Promise<Temp> {
  const dir = mkdtempSync(join(tmpdir(), "snapback-e2e-"));
  const handle = await openHandle(dir);
  return {
    dir,
    handle,
    close(): void {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- the stores src/setup/wiring.ts produces (db-backed) ------------------

// the one write path: merge, clamp, persist, and append one audit row when a
// field actually moved. clamping comes from mergeGuildSettings, which reads every
// field back through its own reader (config/defaults.ts).
function dbSettingsStore(db: Database, clock: () => number): SettingsStore {
  return {
    async read(guildId: string): Promise<GuildSettings> {
      return (await guildsDb.getGuildSettings(db, guildId)) ?? { ...DEFAULT_GUILD_SETTINGS };
    },
    async save(input: SaveInput) {
      const existing = await guildsDb.getGuild(db, input.guildId);
      const current: GuildSettings = existing?.settings_json ?? { ...DEFAULT_GUILD_SETTINGS };
      const next = mergeGuildSettings(current, input.patch);
      const changed = (Object.keys(input.patch) as (keyof GuildSettings)[]).filter(
        (key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]),
      );

      if (existing === null) {
        await guildsDb.insertGuild(db, {
          guild_id: input.guildId,
          name: null,
          icon_url: null,
          owner_user_id: null,
          added_at: iso(clock()),
          removed_at: null,
          settings_json: next,
        });
      } else {
        await guildsDb.setGuildSettings(db, input.guildId, next);
      }

      // one row per save that moved something, none for a save that moved nothing,
      // so a re-run of identical values cannot claim a change that did not happen.
      if (changed.length > 0) {
        await auditDb.insertAudit(db, {
          id: Bun.randomUUIDv7(),
          guild_id: input.guildId,
          actor_user_id: input.actorUserId,
          action: input.action,
          target: input.target ?? null,
          detail_json: input.detail ?? { changed: [...changed] },
          created_at: iso(clock()),
        });
      }

      return { settings: next, changed };
    },
  };
}

function dbStateTable(db: Database): StateTable {
  return {
    insert: (row) => interactionDb.insertInteractionState(db, row),
    select: (stateId) => interactionDb.getInteractionState(db, stateId),
    remove: (stateId) => interactionDb.deleteInteractionState(db, stateId),
    async removeExpired(nowIso: string): Promise<number> {
      const rows = await db.query<{ n: bigint }>(
        "SELECT COUNT(*) AS n FROM interaction_state WHERE expires_at < ?",
        [nowIso],
      );
      await interactionDb.deleteExpiredInteractionState(db, nowIso);
      return Number(rows[0]?.n ?? 0);
    },
  };
}

function dbStateStore(db: Database, clock: () => number): StateStore {
  return new TableStateStore(dbStateTable(db), { now: clock });
}

const ADMIN_COLUMN: Record<keyof AdminEntry["flags"], keyof adminsDb.AdminFlags> = {
  canBackup: "can_backup",
  canRestore: "can_restore",
  canManageAdmins: "can_manage_admins",
  canViewRecords: "can_view_records",
  canDeleteRecords: "can_delete_records",
};

function dbAdminStore(db: Database, clock: () => number): AdminStore {
  return {
    async list(guildId: string): Promise<readonly AdminEntry[]> {
      const rows: GuildAdminRow[] = await adminsDb.listAdminsForGuild(db, guildId);
      return rows.map((row) => ({
        userId: row.user_id,
        addedBy: row.added_by,
        addedAt: row.added_at,
        flags: {
          canBackup: row.can_backup,
          canRestore: row.can_restore,
          canManageAdmins: row.can_manage_admins,
          canViewRecords: row.can_view_records,
          canDeleteRecords: row.can_delete_records,
        },
      }));
    },
    async add(guildId: string, userId: string, actorUserId: string): Promise<void> {
      await adminsDb.upsertAdmin(db, {
        guild_id: guildId,
        user_id: userId,
        added_by: actorUserId,
        added_at: iso(clock()),
        can_backup: true,
        can_restore: true,
        can_manage_admins: true,
        can_view_records: true,
        can_delete_records: true,
      });
    },
    async remove(guildId: string, userId: string): Promise<void> {
      await adminsDb.removeAdmin(db, guildId, userId);
    },
    async setFlag(
      guildId: string,
      userId: string,
      flag: keyof AdminEntry["flags"],
      value: boolean,
    ): Promise<void> {
      const row = await adminsDb.getAdmin(db, guildId, userId);
      if (row === null) return;
      const flags: adminsDb.AdminFlags = {
        can_backup: row.can_backup,
        can_restore: row.can_restore,
        can_manage_admins: row.can_manage_admins,
        can_view_records: row.can_view_records,
        can_delete_records: row.can_delete_records,
      };
      flags[ADMIN_COLUMN[flag]] = value;
      await adminsDb.setAdminFlags(db, guildId, userId, flags);
    },
  };
}

// ---- the deps -------------------------------------------------------------

// every stub that stands in for a network hop refuses to run, so a code path that
// reaches discord fails this test loudly rather than passing on a silent no-op.
// the web and app facts are the seam the wizard reads from; navigating past app
// and web renders those pages, so they answer from canned values, never a socket.
interface Network {
  readonly calls: string[];
  refuse(name: string): never;
}

function makeDeps(db: Database, net: Network): SetupDeps {
  const clock = (): number => FIXED_NOW;
  return {
    log: createLogger({ level: "error", dir: null }),
    now: clock,
    store: dbSettingsStore(db, clock),
    admins: dbAdminStore(db, clock),
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
        id: "123456789012345678",
        name: "snapback",
        botUserId: BOT,
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
    // the true network/io edges: an accidental call is a failure, not a no-op.
    images: {
      current: async () => net.refuse("images.current"),
      setAvatar: async () => net.refuse("images.setAvatar"),
      setBanner: async () => net.refuse("images.setBanner"),
      setDisplayName: async () => net.refuse("images.setDisplayName"),
    },
    files: { read: async () => net.refuse("files.read") },
    // a local reader, not a network hop: the finish page reads it, and "not
    // shipped in this build" is a real answer, so it is a benign fake.
    docs: async () => null,
    state: dbStateStore(db, clock),
    logs: async () => net.refuse("logs"),
    postPanel: async () => net.refuse("postPanel"),
  };
}

// ---- interaction surface and router --------------------------------------

// a surface that records what a handler answered. handlers.test.ts owns the
// richer one; this is the minimal copy needed here because that file exports
// nothing and this test must stand alone.
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
}

interface Harness {
  readonly deps: SetupDeps;
  readonly router: Router;
  readonly net: Network;
}

function harness(db: Database): Harness {
  const calls: string[] = [];
  const net: Network = {
    calls,
    refuse(name: string): never {
      calls.push(name);
      throw new Error(`network stub ${name} was reached; this test is offline`);
    },
  };
  const deps = makeDeps(db, net);
  const router = registerSetupHandlers(new Router({ authorize: () => ({ kind: "allow" }) }), deps);
  return { deps, router, net };
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
  if (outcome.kind !== "handled") {
    const detail = "message" in outcome ? outcome.message : JSON.stringify(outcome);
    throw new Error(`route ${rawId} -> ${outcome.kind}: ${String(detail)}`);
  }
  return surface;
}

// ---- custom id helpers ----------------------------------------------------

function sid(
  object: (typeof SETUP_OBJECT)[keyof typeof SETUP_OBJECT],
  action: string,
  cursor = "",
): string {
  return setupCustomId({ guildId: GUILD, object, action, cursor });
}
const stepId = (key: string): string => sid(SETUP_OBJECT.step, key);
const modalId = (key: string): string => sid(SETUP_OBJECT.modal, key);
const navId = (action: string, cursor = ""): string => sid(SETUP_OBJECT.nav, action, cursor);
// the logging step's channel select and family checkboxes report under "toggle".
const logId = (cursor: string): string => sid(SETUP_OBJECT.log, SETUP_ACTION.toggle, cursor);

// ---- the tree walker ------------------------------------------------------

interface WalkNode {
  customID?: string;
  content?: string;
  value?: string;
  default?: boolean;
  options?: readonly { value?: string; default?: boolean }[];
  components?: WalkNode[];
  accessory?: WalkNode;
  component?: WalkNode;
}

function walk(node: unknown, visit: (n: WalkNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as WalkNode;
  visit(n);
  if (Array.isArray(n.components)) for (const child of n.components) walk(child, visit);
  if (n.accessory) walk(n.accessory, visit);
  if (n.component) walk(n.component, visit);
}

function findById(tree: unknown, id: string): WalkNode {
  let found: WalkNode | undefined;
  walk(tree, (n) => {
    if (found === undefined && n.customID === id) found = n;
  });
  if (found === undefined) throw new Error(`no component with customID ${id}`);
  return found;
}

function texts(tree: unknown): string {
  const out: string[] = [];
  walk(tree, (n) => {
    if (typeof n.content === "string") out.push(n.content);
  });
  return out.join("\n");
}

// ---- what a full pass enters ----------------------------------------------
//
// the verify step writes the panel's title, description, and colour and leaves
// the scopes untouched. the scopes step then chooses the final scope set. the
// split matters: it is what makes a second identical pass a true no-op, because
// neither step overwrites the other's value with a stale one.

const WANT_SCOPES = ["identify", "email", "connections", "guilds.join"];

const LOG_VALUES: Readonly<Record<string, SubmittedValue>> = {
  [logId("channel")]: CHANNEL,
  [logId("families")]: ["backup", "restore", "verify"],
};
const BACKUP_VALUES: Readonly<Record<string, SubmittedValue>> = {
  [sid(SETUP_OBJECT.step, "backup", "auto")]: "true",
  [sid(SETUP_OBJECT.step, "backup", "notify")]: "true",
  [sid(SETUP_OBJECT.step, "backup", "interval")]: "12",
  [sid(SETUP_OBJECT.step, "backup", "count")]: "2500",
};
const RESTORE_VALUES: Readonly<Record<string, SubmittedValue>> = {
  [sid(SETUP_OBJECT.step, "restore", "auto")]: "true",
  [sid(SETUP_OBJECT.step, "restore", "clear")]: "true",
  [sid(SETUP_OBJECT.step, "restore", "suffix")]: "true",
};
const VERIFY_VALUES: Readonly<Record<string, SubmittedValue>> = {
  [panelFieldId(GUILD, "title")]: "verify to enter",
  [panelFieldId(GUILD, "description")]: "prove you are human",
  [panelFieldId(GUILD, "colour")]: "#57f287",
};
const SCOPES_VALUES: Readonly<Record<string, SubmittedValue>> = {
  [panelFieldId(GUILD, "scopes")]: [...WANT_SCOPES],
};

// ---- the pass -------------------------------------------------------------

// every step is driven through its real interaction: nav "next" finishes the
// steps with nothing to submit, the modal ids submit the steps with a modal, and
// the step control submits the steps whose fields ride the page.
async function fullPass(h: Harness): Promise<void> {
  await openSetup({ deps: h.deps, guildId: GUILD, userId: OPENER });
  await press(h, navId(SETUP_ACTION.next, "welcome")); // welcome done, renders app
  await press(h, navId(SETUP_ACTION.next, "app")); // app done, renders web
  await press(h, modalId("web"), new FakeSurface({}, "modal")); // page name left at the default
  await press(h, modalId("branding"), new FakeSurface({}, "modal")); // branding left unset
  await press(h, navId(SETUP_ACTION.next, "admins")); // admins done, renders logs
  await press(h, stepId("logs"), new FakeSurface(LOG_VALUES));
  await press(h, stepId("backup"), new FakeSurface(BACKUP_VALUES));
  await press(h, stepId("restore"), new FakeSurface(RESTORE_VALUES));
  await press(h, modalId("verify"), new FakeSurface(VERIFY_VALUES, "modal"));
  await press(h, modalId("scopes"), new FakeSurface(SCOPES_VALUES, "modal"));
  await press(h, stepId("finish"), new FakeSurface()); // completes the wizard
}

const PASS_SAVES = 12; // setup.open + ten step saves + finish

async function auditRows(db: Database): Promise<AuditLogRow[]> {
  return auditDb.listAuditByGuild(db, GUILD, { limit: 100 });
}

function changedFields(row: AuditLogRow | undefined): string[] {
  const detail = row?.detail_json;
  const value = detail === null || detail === undefined ? undefined : detail.changed;
  return Array.isArray(value) ? value.map(String) : [];
}

const VALUE_FIELDS = [
  "ephemeral_default",
  "log_channel_id",
  "log_events",
  "auto_backup_enabled",
  "auto_backup_interval_hours",
  "auto_backup_message_count",
  "auto_restore_enabled",
  "restore_clear_before",
  "restore_message_timestamp_suffix",
  "notify_on_join",
  "verify_panel",
  "acknowledged_restricted_scopes",
  "branding",
  "web_display_name",
] as const;

// ---- the checks -----------------------------------------------------------

describe("the setup wizard, end to end", () => {
  test("a full pass saves every value that was entered", async () => {
    const temp = await openTemp();
    try {
      const h = harness(temp.handle.db);
      await fullPass(h);

      const saved = await guildsDb.getGuildSettings(temp.handle.db, GUILD);
      expect(saved).not.toBeNull();
      if (saved === null) return; // narrow for the compiler; the expect above failed

      // the log channel and the event families, from the logging step
      expect(saved.log_channel_id).toBe(CHANNEL);
      expect(saved.log_events).toEqual(["backup", "restore", "verify"]);
      for (const family of saved.log_events) {
        expect((LOG_EVENT_FAMILIES as readonly string[]).includes(family)).toBe(true);
      }

      // the backup and restore settings, from their pages and modals
      expect(saved.auto_backup_enabled).toBe(true);
      expect(saved.notify_on_join).toBe(true);
      expect(saved.auto_backup_interval_hours).toBe(12);
      expect(saved.auto_backup_message_count).toBe(2500);
      expect(saved.auto_restore_enabled).toBe(true);
      expect(saved.restore_clear_before).toBe(true);
      expect(saved.restore_message_timestamp_suffix).toBe(true);

      // the verify panel: the verify step built it, the scopes step set its scopes
      expect(saved.verify_panel).not.toBeNull();
      expect(saved.verify_panel?.title).toBe("verify to enter");
      expect(saved.verify_panel?.description).toBe("prove you are human");
      expect(saved.verify_panel?.colour).toBe("#57f287");
      expect(saved.verify_panel?.scopes).toEqual(WANT_SCOPES);

      // the app step writes no setting of its own (it is an info page); what it
      // records is that it was handled. this is the app page's persisted effect.
      expect(saved.wizard.steps.app?.done).toBe(true);
      expect(saved.wizard.steps.logs?.done).toBe(true);
      expect(saved.wizard.steps.finish?.done).toBe(true);
      expect(saved.wizard.done_at).not.toBeNull();
      expect(isComplete(saved)).toBe(true);

      // every step is either done or skipped
      for (const key of WIZARD_STEP_KEYS) {
        const state = saved.wizard.steps[key];
        expect(state?.done === true || state?.skipped === true).toBe(true);
      }

      expect(h.net.calls).toEqual([]); // offline: no network stub was reached
    } finally {
      temp.close();
    }
  });

  test("a re-run renders each step prefilled from what was saved", async () => {
    const temp = await openTemp();
    try {
      const h = harness(temp.handle.db);
      await fullPass(h);
      const before = (await auditRows(temp.handle.db)).length;

      // logs: the family checkboxes default to the stored selection, and the page
      // names the stored channel. nav "prev" never writes, so this is a pure render.
      const logs = await press(h, navId(SETUP_ACTION.prev, "backup"));
      expect(texts(logs.message)).toContain(`<#${CHANNEL}>`);
      const families = findById(logs.message, logId("families"));
      const wantFamilies = ["backup", "restore", "verify"];
      for (const option of families.options ?? []) {
        expect(option.default).toBe(wantFamilies.includes(option.value ?? ""));
      }

      // backup: the modal carries the stored numbers, the page the stored toggles
      const backup = await press(h, stepId("backup"));
      const backupModal = backup.modals[0]?.components;
      expect(findById(backupModal, sid(SETUP_OBJECT.step, "backup", "interval")).value).toBe("12");
      expect(findById(backupModal, sid(SETUP_OBJECT.step, "backup", "count")).value).toBe("2500");

      const backupPage = await press(h, navId(SETUP_ACTION.prev, "restore"));
      expect(findById(backupPage.message, sid(SETUP_OBJECT.step, "backup", "auto")).default).toBe(
        true,
      );
      expect(findById(backupPage.message, sid(SETUP_OBJECT.step, "backup", "notify")).default).toBe(
        true,
      );

      // restore: three toggles, all on
      const restorePage = await press(h, navId(SETUP_ACTION.prev, "verify"));
      expect(findById(restorePage.message, sid(SETUP_OBJECT.step, "restore", "auto")).default).toBe(
        true,
      );
      expect(
        findById(restorePage.message, sid(SETUP_OBJECT.step, "restore", "clear")).default,
      ).toBe(true);
      expect(
        findById(restorePage.message, sid(SETUP_OBJECT.step, "restore", "suffix")).default,
      ).toBe(true);

      // verify: the panel's title and colour are the modal's defaults
      const verify = await press(h, stepId("verify"));
      const verifyModal = verify.modals[0]?.components;
      expect(findById(verifyModal, panelFieldId(GUILD, "title")).value).toBe("verify to enter");
      expect(findById(verifyModal, panelFieldId(GUILD, "colour")).value).toBe("#57f287");

      // scopes: the checkbox group defaults to the stored scopes, ack still unset
      const scopes = await press(h, stepId("scopes"));
      const scopesModal = scopes.modals[0]?.components;
      const scopeGroup = findById(scopesModal, panelFieldId(GUILD, "scopes"));
      const selected = (scopeGroup.options ?? [])
        .filter((option) => option.default === true)
        .map((option) => option.value);
      expect(selected).toEqual(WANT_SCOPES);
      expect(findById(scopesModal, panelAckId(GUILD)).default).toBe(false);

      // reading the wizard back writes nothing
      expect((await auditRows(temp.handle.db)).length).toBe(before);
      expect(h.net.calls).toEqual([]);
    } finally {
      temp.close();
    }
  });

  test("every save writes one audit row, with the actor and the field that moved", async () => {
    const temp = await openTemp();
    try {
      const h = harness(temp.handle.db);
      await fullPass(h);

      const rows = await auditRows(temp.handle.db);
      expect(rows).toHaveLength(PASS_SAVES);

      // the actor and the guild on every row; the surface is the action's prefix
      for (const row of rows) {
        expect(row.actor_user_id).toBe(OPENER);
        expect(row.guild_id).toBe(GUILD);
        expect(row.action.startsWith("setup.")).toBe(true);
      }

      // exactly one row per save, keyed by the action the handler passed
      const byAction = new Map(rows.map((row) => [row.action, row]));
      expect([...byAction.keys()].sort()).toEqual(
        [
          "setup.open",
          "setup.welcome.done",
          "setup.app.done",
          "setup.web",
          "setup.branding",
          "setup.admins.done",
          "setup.logs",
          "setup.backup",
          "setup.restore",
          "setup.verify",
          "setup.scopes",
          "setup.finish",
        ].sort(),
      );

      // the field that changed: each value save names what it moved
      expect(changedFields(byAction.get("setup.logs"))).toContain("log_channel_id");
      expect(changedFields(byAction.get("setup.logs"))).toContain("log_events");
      expect(changedFields(byAction.get("setup.backup"))).toContain("auto_backup_interval_hours");
      expect(changedFields(byAction.get("setup.backup"))).toContain("auto_backup_message_count");
      expect(changedFields(byAction.get("setup.restore"))).toContain("restore_clear_before");
      expect(changedFields(byAction.get("setup.verify"))).toContain("verify_panel");
      expect(changedFields(byAction.get("setup.scopes"))).toContain("verify_panel");

      // the cursor-only saves moved nothing but the wizard. the web step now
      // submits its own modal: the page name was left at the default.
      expect(changedFields(byAction.get("setup.web"))).toEqual(["wizard"]);
      expect(changedFields(byAction.get("setup.branding"))).toEqual(["wizard"]);

      expect(h.net.calls).toEqual([]);
    } finally {
      temp.close();
    }
  });

  test("a partial setup resumes at the step it stopped on after a restart", async () => {
    const temp = await openTemp();
    try {
      const h1 = harness(temp.handle.db);
      await openSetup({ deps: h1.deps, guildId: GUILD, userId: OPENER });

      // save one real value out of order, then walk partway and stop before logs
      await press(h1, modalId("verify"), new FakeSurface(VERIFY_VALUES, "modal"));
      await press(h1, navId(SETUP_ACTION.next, "welcome"));
      await press(h1, navId(SETUP_ACTION.next, "app"));
      await press(h1, modalId("web"), new FakeSurface({}, "modal"));
      await press(h1, modalId("branding"), new FakeSurface({}, "modal"));
      await press(h1, navId(SETUP_ACTION.next, "admins")); // current is now "logs"

      const stoppedAt = (await guildsDb.getGuildSettings(temp.handle.db, GUILD))?.wizard.current;
      expect(stoppedAt).toBe("logs");

      // the restart: close the handle, reopen the same file, build fresh deps.
      // nothing lives in memory that the second process could not read back.
      temp.handle.close();
      const second = await openHandle(temp.dir);
      try {
        const h2 = harness(second.db);
        expect(h2.deps).not.toBe(h1.deps); // a genuinely new wiring

        const resumed = await openSetup({ deps: h2.deps, guildId: GUILD, userId: OPENER });
        // it opens on the step it stopped on (the logs page title is "logging")
        expect(texts(resumed)).toContain("logging");
        const navCursors: string[] = [];
        walk(resumed, (n) => {
          if (typeof n.customID === "string" && n.customID.startsWith("sb:")) {
            navCursors.push(parseCustomId(n.customID).cursor);
          }
        });
        expect(navCursors).toContain("logs");

        // the earlier answers survived the restart
        const saved = await guildsDb.getGuildSettings(second.db, GUILD);
        expect(saved?.verify_panel?.title).toBe("verify to enter");
        expect(saved?.wizard.current).toBe("logs");
        for (const key of ["welcome", "app", "web", "branding", "admins"]) {
          expect(saved?.wizard.steps[key]?.done).toBe(true);
        }
        expect(saved?.wizard.steps.logs?.done).not.toBe(true);
        expect(h2.net.calls).toEqual([]);
      } finally {
        second.close();
      }
    } finally {
      temp.close();
    }
  });

  test("a second pass with identical values changes no value field", async () => {
    const temp = await openTemp();
    try {
      const h = harness(temp.handle.db);
      await fullPass(h);
      const firstRows = await auditRows(temp.handle.db);
      const firstIds = new Set(firstRows.map((row) => row.id));
      expect(firstRows).toHaveLength(PASS_SAVES);
      const snapshot = await guildsDb.getGuildSettings(temp.handle.db, GUILD);
      expect(snapshot).not.toBeNull();
      if (snapshot === null) return;

      await fullPass(h);

      // the value fields are byte-identical: nothing flip-flopped
      const after = await guildsDb.getGuildSettings(temp.handle.db, GUILD);
      expect(after).not.toBeNull();
      if (after === null) return;
      for (const field of VALUE_FIELDS) {
        expect(JSON.stringify(after[field])).toBe(JSON.stringify(snapshot[field]));
      }

      // the second pass wrote 10 rows, not 12. two saves moved nothing so wrote
      // no audit row: setup.open (the opener is already this user) and
      // setup.finish (the wizard is already complete, so completing it again is a
      // no-op). every other save advanced the wizard cursor and nothing else.
      const added = (await auditRows(temp.handle.db)).filter((row) => !firstIds.has(row.id));
      expect(added).toHaveLength(10);
      const addedActions = new Set(added.map((row) => row.action));
      expect(addedActions.has("setup.open")).toBe(false);
      expect(addedActions.has("setup.finish")).toBe(false);
      for (const row of added) {
        // the cursor moved, so the row exists; no value field changed, so no row
        // claims a change that did not happen.
        expect(changedFields(row)).toEqual(["wizard"]);
        for (const field of VALUE_FIELDS) expect(changedFields(row)).not.toContain(field);
      }

      expect(h.net.calls).toEqual([]);
    } finally {
      temp.close();
    }
  });
});
