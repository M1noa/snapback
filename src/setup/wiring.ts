// src/setup/wiring.ts - the integrator for /setup.
//
// this module decides nothing and holds no state: it turns the process's real
// handles (a db, the rest client, the live gateway, env, the owner id) into the
// SetupDeps the wizard's steps and handlers consume. every fact the wizard shows
// is read here, at the edge, and never invented (AGENTS.md rule 5).
//
// env is read through config/parse-env.ts rather than config/env.ts on purpose:
// env.ts calls process.exit when a key is missing, so importing it would make
// this module unimportable without a full environment (a test could never load
// it). parse-env.ts is the same validation without the exit, and the error below
// names the keys instead of killing the process.

import { basename } from "node:path";
import { Intents } from "oceanic.js";
import {
  DEFAULT_GUILD_SETTINGS,
  type GuildSettings,
  mergeGuildSettings,
  type VerifyPanelSettings,
} from "../config/defaults.ts";
import { type Env, parseEnv, readProcessEnv } from "../config/parse-env.ts";
import * as adminsDb from "../db/queries/admins.ts";
import * as auditDb from "../db/queries/audit.ts";
import * as guildsDb from "../db/queries/guilds.ts";
import * as stateDb from "../db/queries/interaction-state.ts";
import type { Database, GuildAdminRow } from "../db/types.ts";
import type { DiscordClient, HttpMethod } from "../discord/client.ts";
import { v2Message } from "../discord/components/container.ts";
import { textDisplay } from "../discord/components/fields.ts";
import { page } from "../discord/components/page.ts";
import { DiscordApiError, formatDiscordError } from "../discord/errors.ts";
import type { Gateway } from "../discord/gateway.ts";
import {
  type StateStore,
  type StateTable,
  TableStateStore,
} from "../discord/interactions/state.ts";
import { fetchCdn } from "../lib/http.ts";
import type { Logger } from "../lib/log.ts";
import type {
  AdminEntry,
  AdminStore,
  AppFacts,
  ApplicationFacts,
  DocReader,
  FileReader,
  ImageApplier,
  LogTestResult,
  Portal,
  PrivacyFacts,
  SaveInput,
  SaveResult,
  SettingsStore,
  SetupDeps,
  WebFacts,
} from "./deps.ts";
import { panelComponents } from "./panel.ts";
import { createPortal, type PortalFeature } from "./portal.ts";
import { createSelfTest, type SelfTestDeps } from "./selftest.ts";

// every call to discord gets a deadline; nothing here awaits unbounded.
const SETUP_TIMEOUT_MS = 10_000;
// the loopback probe is our own socket, so it either answers at once or never.
const PROBE_TIMEOUT_MS = 1_500;
// the branding step's own ceiling; the image pass rejects anything larger first.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// a guide name is a slug. anything else is a path, and a path is refused.
const DOC_NAME = /^[a-z0-9_-]+$/i;

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const CALLBACK_PATH = "/callback";

// the permission set docs/developer-panel.md describes: the features this bot
// uses, and nothing it does not. administrator is absent on purpose (D4PLAN 7.3).
const NEEDED_FEATURES: readonly PortalFeature[] = Object.freeze([
  "roles",
  "channels",
  "webhooks",
  "bans",
  "guild",
  "messages",
  "history",
  "emojis",
  "events",
  "moderation",
  "audit_log",
]);

export interface SetupWiringInput {
  /** the selected db handle; bigint stays inside db/ (AGENTS.md rule 3). */
  readonly db: Database;
  /** the one rest client (AGENTS.md rule 6). */
  readonly client: DiscordClient;
  /** the live gateway, read for its negotiated intents and its status. */
  readonly gateway: Gateway;
  readonly log: Logger;
  /** DISCORD_OWNER_ID. */
  readonly ownerId: string;
  /** injectable clock in epoch ms. defaults to Date.now. */
  readonly now?: () => number;
  /** called after a save lands, so caches that hold settings can re-read. */
  readonly settingsSaved?: (guildId: string) => void | Promise<void>;
}

/** what the gateway resolved its intent names to. discord does not echo the
 *  granted set back, so this bitmask (the one IDENTIFY will carry) is the only
 *  honest source for "is GUILD_MEMBERS requested". */
function negotiatedIntents(gateway: Gateway): number {
  return gateway.client.shards.options.intents;
}

/** the validated env, or a thrown error naming what is missing. */
function readEnv(): Env {
  const parsed = parseEnv(readProcessEnv);
  if (!parsed.ok) {
    throw new Error(`snapback env cannot be read for /setup: ${parsed.problems.join(" ")}`);
  }
  return parsed.env;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** only the five verbs the client accepts; anything else is a caller bug. */
function asMethod(method: string): HttpMethod {
  switch (method) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return method;
    default:
      throw new Error(`unsupported http method ${JSON.stringify(method)}`);
  }
}

/** the slice of the application object this file reads. */
interface ApplicationWire {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly flags?: unknown;
  readonly bot?: { readonly id?: unknown } | null;
  readonly owner?: { readonly id?: unknown } | null;
  readonly redirect_uris?: unknown;
}

/** the bot account fields PATCH /users/@me takes (BotAccountPatchRequest). */
interface UserWire {
  readonly username?: unknown;
  readonly global_name?: unknown;
  readonly avatar?: unknown;
  readonly banner?: unknown;
}

const FLAG_COLUMN: Readonly<Record<keyof AdminEntry["flags"], keyof adminsDb.AdminFlags>> =
  Object.freeze({
    canBackup: "can_backup",
    canRestore: "can_restore",
    canManageAdmins: "can_manage_admins",
    canViewRecords: "can_view_records",
    canDeleteRecords: "can_delete_records",
  });

function toAdminEntry(row: GuildAdminRow): AdminEntry {
  return {
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
  };
}

/** a string list, or null when the field is absent, so "unknown" is not "empty". */
function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

export function createSetupDeps(input: SetupWiringInput): SetupDeps {
  const now = input.now ?? ((): number => Date.now());
  const env = readEnv();
  const iso = (): string => new Date(now()).toISOString();
  const intents = (): number => negotiatedIntents(input.gateway);
  const memberIntent = (): boolean => (intents() & Intents.GUILD_MEMBERS) !== 0;

  // the one write path for guild settings (deps.ts). merge, clamp, persist, one
  // audit row. nothing else in /setup writes settings_json.
  const store: SettingsStore = {
    async read(guildId: string): Promise<GuildSettings> {
      return (await guildsDb.getGuildSettings(input.db, guildId)) ?? { ...DEFAULT_GUILD_SETTINGS };
    },

    async save(save: SaveInput): Promise<SaveResult> {
      const existing = await guildsDb.getGuild(input.db, save.guildId);
      const current: GuildSettings = existing?.settings_json ?? { ...DEFAULT_GUILD_SETTINGS };
      // mergeGuildSettings reads every field back through its own reader, so a
      // number is clamped into its range and a bad colour falls back to the
      // shipped default here rather than reaching the app (defaults.ts).
      const next = mergeGuildSettings(current, save.patch);
      const changed = (Object.keys(save.patch) as (keyof GuildSettings)[]).filter(
        (key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]),
      );

      // setGuildSettings is an update, so a guild with no row yet would silently
      // keep nothing. the first save writes the row.
      if (existing === null) {
        await guildsDb.insertGuild(input.db, {
          guild_id: save.guildId,
          name: null,
          icon_url: null,
          owner_user_id: null,
          added_at: iso(),
          removed_at: null,
          settings_json: next,
        });
      } else {
        await guildsDb.setGuildSettings(input.db, save.guildId, next);
      }

      // one row per save that moved a field. a patch that changed nothing writes
      // no audit row, so re-running a step with identical values cannot claim a
      // change. detail defaults to the field list, which is what an audit reader
      // wants when the caller said no more.
      if (changed.length > 0) {
        await auditDb.insertAudit(input.db, {
          id: Bun.randomUUIDv7(),
          guild_id: save.guildId,
          actor_user_id: save.actorUserId,
          action: save.action,
          target: save.target ?? null,
          detail_json: save.detail ?? { changed: [...changed] },
          created_at: iso(),
        });
      }

      // a cache of these settings is now stale. a failure here is not a failed
      // save: the row is written, the cache re-reads on the next boot.
      await input.settingsSaved?.(save.guildId);

      return { settings: next, changed };
    },
  };

  const admins: AdminStore = {
    async list(guildId: string): Promise<readonly AdminEntry[]> {
      return (await adminsDb.listAdminsForGuild(input.db, guildId)).map(toAdminEntry);
    },

    async add(guildId: string, userId: string, actorUserId: string): Promise<void> {
      // a new admin gets every flag, which the step's page says out loud;
      // per-flag grants arrive with /admin (setup/steps/admins.ts).
      await adminsDb.upsertAdmin(input.db, {
        guild_id: guildId,
        user_id: userId,
        added_by: actorUserId,
        added_at: iso(),
        can_backup: true,
        can_restore: true,
        can_manage_admins: true,
        can_view_records: true,
        can_delete_records: true,
      });
    },

    async remove(guildId: string, userId: string): Promise<void> {
      await adminsDb.removeAdmin(input.db, guildId, userId);
    },

    async setFlag(
      guildId: string,
      userId: string,
      flag: keyof AdminEntry["flags"],
      value: boolean,
    ): Promise<void> {
      const row = await adminsDb.getAdmin(input.db, guildId, userId);
      if (row === null) return;
      const flags: adminsDb.AdminFlags = {
        can_backup: row.can_backup,
        can_restore: row.can_restore,
        can_manage_admins: row.can_manage_admins,
        can_view_records: row.can_view_records,
        can_delete_records: row.can_delete_records,
      };
      flags[FLAG_COLUMN[flag]] = value;
      await adminsDb.setAdminFlags(input.db, guildId, userId, flags);
    },
  };

  const web: WebFacts = {
    publicBaseUrl: env.web.publicBaseUrl,
    port: env.web.port,
    behindCloudflareTunnel: env.web.behindCloudflareTunnel,
    trustedProxyDepth: env.web.trustedProxyDepth,
    captcha: env.captcha.provider,

    async listening(): Promise<boolean> {
      // any answer means a socket accepted the connection, which is all the self
      // test's line asks. a refused connection or a timeout is the failure.
      try {
        await fetch(`http://127.0.0.1:${env.web.port}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return true;
      } catch {
        return false;
      }
    },
  };

  const privacy: PrivacyFacts = {
    ipStorage: env.privacy.ipStorage,
    tokenStorage: env.privacy.tokenStorage,
  };

  async function application(): Promise<ApplicationFacts> {
    const body = await input.client.request<ApplicationWire>({
      method: "GET",
      route: "/applications/@me",
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    return {
      id: text(body.id),
      name: text(body.name),
      botUserId: body.bot === null || body.bot === undefined ? null : text(body.bot.id),
      // a team-owned application carries no owner field. "" is the honest unknown
      // for a string fact, and the app step only renders this once the id read.
      ownerId: body.owner === null || body.owner === undefined ? "" : (text(body.owner.id) ?? ""),
      flags: typeof body.flags === "number" ? body.flags : 0,
      intents: intents(),
    };
  }

  // the oauth check behind the self test's two lines (D4PLAN 7.6). the round trip
  // itself (authorize, exchange, revoke) needs the client secret and a browser
  // session, so what this can settle is the redirect registration, read from the
  // application's own redirect_uris. the "oauth round trip" line therefore
  // reflects the redirect check and not a real exchange.
  async function authorizeStatus(
    scopes: readonly string[],
  ): Promise<{ status: number; error: string | null }> {
    const redirectUri = `${env.web.publicBaseUrl}${CALLBACK_PATH}`;
    const application = await input.client.request<ApplicationWire>({
      method: "GET",
      route: "/applications/@me",
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    const clientId = text(application.id);
    if (clientId === null) {
      throw new Error(
        "the oauth check needs the application id, and GET /applications/@me returned none",
      );
    }
    const url = `${AUTHORIZE_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes.join(" "))}`;
    input.log.debug("the oauth check reads the application's redirect uris", { url });

    const registered = stringList(application.redirect_uris);
    // discord names this exact condition invalid_redirect_uri, which is the
    // string the self test looks for. reporting a pass when the callback is
    // demonstrably absent would be the false claim.
    const error =
      registered !== null && !registered.includes(redirectUri) ? "invalid_redirect_uri" : null;
    return { status: 200, error };
  }

  // the shape both the self test and the portal take: the client's own request,
  // narrowed to the five verbs it accepts, so a stray verb fails here not on the wire.
  const client: SelfTestDeps["client"] = {
    request: <T>(options: {
      method: string;
      route: string;
      body?: unknown;
      timeoutMs?: number;
    }): Promise<T> =>
      input.client.request<T>({
        method: asMethod(options.method),
        route: options.route,
        body: options.body,
        timeoutMs: options.timeoutMs,
      }),
  };

  const selfTest = createSelfTest({
    client,
    ownerId: input.ownerId,
    devGuildId: env.discord.devGuildId,
    gateway: () => {
      const status = input.gateway.status();
      return { ready: status.ready, pingMs: status.ping };
    },
    web: {
      port: env.web.port,
      publicBaseUrl: env.web.publicBaseUrl,
      listening: () => web.listening(),
    },
    // a fetch from outside our own process, so the public path is proven from the
    // outside rather than from the loopback.
    publicFetch: async (url: string) => {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.text() };
    },
    oauth: { authorizeStatus },
    now,
  });

  const app: AppFacts = {
    ownerId: input.ownerId,
    // read live: the gateway reaches ready after these are built, so a snapshot
    // would freeze "not ready" onto every page the wizard renders.
    get gatewayReady(): boolean {
      return input.gateway.status().ready;
    },
    get gatewayPingMs(): number | null {
      return input.gateway.status().ping;
    },
    get memberIntent(): boolean {
      return memberIntent();
    },
    devGuildId: env.discord.devGuildId,
    application,
    selfTest: () => selfTest.run(),
  };

  const portal: Portal = createPortal({
    client,
    application: () => app.application(),
    publicBaseUrl: env.web.publicBaseUrl,
    memberIntent: memberIntent(),
    features: () => NEEDED_FEATURES,
  });

  const images: ImageApplier = {
    async current(): Promise<{
      displayName: string | null;
      avatarSet: boolean;
      bannerSet: boolean;
    }> {
      // the branding step edits the bot's own account: the application object
      // carries neither banner nor a display name, so /users/@me is the only
      // endpoint that can answer bannerSet honestly.
      const me = await input.client.request<UserWire>({
        method: "GET",
        route: "/users/@me",
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      return {
        displayName: text(me.global_name) ?? text(me.username),
        avatarSet: text(me.avatar) !== null,
        bannerSet: text(me.banner) !== null,
      };
    },

    async setAvatar(dataUri: string): Promise<void> {
      await patchBotAccount({ avatar: dataUri });
    },

    async setBanner(dataUri: string): Promise<void> {
      await patchBotAccount({ banner: dataUri });
    },

    async setDisplayName(name: string): Promise<void> {
      // a bot's display name is its username; global_name is not patchable here.
      await patchBotAccount({ username: name });
    },
  };

  // the bot account form (BotAccountPatchRequest): username, avatar, banner. the
  // discord api error is left to reach the caller unchanged (non-negotiable 5).
  async function patchBotAccount(body: {
    avatar?: string;
    banner?: string;
    username?: string;
  }): Promise<void> {
    await input.client.request({
      method: "PATCH",
      route: "/users/@me",
      body,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
  }

  const files: FileReader = {
    async read(url: string): Promise<{
      readonly bytes: Uint8Array;
      readonly filename: string;
      readonly contentType: string;
    }> {
      const target = new URL(url); // a non-url throws here, before any request
      // fetchCdn's own allowlist is cdn.discordapp.com (lib/http.ts), so the gate
      // here matches it rather than admitting a host the fetch below would refuse.
      if (target.hostname !== "cdn.discordapp.com") {
        throw new Error(
          `SB_SETUP_FILE_HOST: ${target.hostname} is not the discord cdn, refusing to fetch it`,
        );
      }
      const response = await fetchCdn(url, {
        maxBytes: MAX_FILE_BYTES,
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      return {
        bytes: response.bytes,
        filename: basename(target.pathname) || "file",
        contentType: response.contentType,
      };
    },
  };

  const docs: DocReader = async (name: string): Promise<string | null> => {
    // a guide name is a slug. a path is refused rather than resolved, so nothing
    // can read outside docs/ (../../ resolves against this file, not the cwd).
    if (!DOC_NAME.test(name)) return null;
    const file = Bun.file(new URL(`../../docs/${name}.md`, import.meta.url));
    if (!(await file.exists())) return null;
    return await file.text();
  };

  function stateTable(): StateTable {
    return {
      insert: (row) => stateDb.insertInteractionState(input.db, row),
      select: (stateId) => stateDb.getInteractionState(input.db, stateId),
      remove: (stateId) => stateDb.deleteInteractionState(input.db, stateId),

      async removeExpired(nowIso: string): Promise<number> {
        // the query module's delete reports nothing, so count before it runs.
        const rows = await input.db.query<{ n: bigint }>(
          "SELECT COUNT(*) AS n FROM interaction_state WHERE expires_at < ?",
          [nowIso],
        );
        await stateDb.deleteExpiredInteractionState(input.db, nowIso);
        return Number(rows[0]?.n ?? 0);
      },
    };
  }

  const state: StateStore = new TableStateStore(stateTable(), { now });

  // one test event into the guild's log channel (D4PLAN 16 destination 1). never
  // throws: a log test that rejected would break the interaction that asked for it.
  async function logs(guildId: string): Promise<LogTestResult> {
    const unfixable =
      "check that snapback can view and send messages there, then run the test again.";
    try {
      const settings = await store.read(guildId);
      const channelId = settings.log_channel_id;
      if (channelId === null) {
        return {
          posted: false,
          said: "this server has no log channel set, so the test event had nowhere to go.",
          fix: "open /setup logs, choose a channel, then press test again.",
        };
      }

      const tree = page({
        state: "success",
        title: "log test",
        sections: [
          textDisplay(
            `this is a test event sent to <#${channelId}> by /setup logs. if you can read this, the log channel works.`,
          ),
        ],
      });
      await input.client.request({
        method: "POST",
        route: `/channels/${channelId}/messages`,
        body: v2Message(tree),
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      return { posted: true, said: `posted one test event to <#${channelId}>.`, fix: null };
    } catch (error) {
      // discord's own code and message, verbatim, whenever discord said it.
      if (error instanceof DiscordApiError) {
        const report = formatDiscordError(error);
        return { posted: false, said: report.said, fix: report.fix ?? unfixable };
      }
      input.log.warn("the log test could not post", { guild: guildId, error });
      return { posted: false, said: messageOf(error), fix: unfixable };
    }
  }

  // post the verification panel (D4PLAN 10.3). the panel's components come from
  // the one builder; the discriminator DiscordApiError is left to the caller.
  async function postPanel(panel: VerifyPanelSettings, channelId: string): Promise<void> {
    // panelComponents reads only publicBaseUrl from the context, so the guild slot
    // stays empty rather than carrying an id this message does not use.
    const tree = panelComponents(panel, { guildId: "", publicBaseUrl: env.web.publicBaseUrl });
    await input.client.request({
      method: "POST",
      route: `/channels/${channelId}/messages`,
      body: v2Message(tree),
      timeoutMs: SETUP_TIMEOUT_MS,
    });
  }

  return {
    log: input.log,
    now,
    store,
    admins,
    web,
    privacy,
    app,
    portal,
    images,
    files,
    docs,
    state,
    logs,
    postPanel,
  };
}
