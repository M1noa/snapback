// the Developer Panel checklist and the install link (D4PLAN 7.3).
//
// every item the api can settle is settled from a fact rather than from trust.
// the two it cannot settle say so, in the body, with the exact string to paste.
// permission bits are computed from the enabled features and administrator is
// never included (D4PLAN 7.3 point 5 discourages it).

import type { ApplicationFacts, Portal, PortalItem } from "./deps.ts";
import type { SelfTestDeps } from "./selftest.ts";

/** the feature set the invite asks permissions for (D4PLAN 7.3 point 5). */
export type PortalFeature =
  | "roles"
  | "channels"
  | "webhooks"
  | "bans"
  | "guild"
  | "messages"
  | "history"
  | "emojis"
  | "events"
  | "moderation"
  | "audit_log";

export interface PortalDeps {
  /** carried so the portal shares the one client the rest of /setup app uses; the
   *  panel reads its facts through application() and this only for the endpoint. */
  readonly client: SelfTestDeps["client"];
  application(): Promise<ApplicationFacts>;
  readonly publicBaseUrl: string;
  readonly memberIntent: boolean;
  readonly features: () => readonly PortalFeature[];
}

// discord's permission bitfield, one bit per feature (D4PLAN 7.3 point 5).
// administrator (1n << 3n) is deliberately absent: it is not required and 7.3
// discourages it. bit 33 and bit 40 need BigInt, because `<<` is 32-bit here.
const PERMISSION_BITS: Readonly<Record<PortalFeature, bigint>> = {
  roles: 1n << 28n, // MANAGE_ROLES
  channels: 1n << 4n, // MANAGE_CHANNELS
  webhooks: 1n << 29n, // MANAGE_WEBHOOKS
  bans: 1n << 2n, // BAN_MEMBERS
  guild: 1n << 5n, // MANAGE_GUILD
  messages: 1n << 13n, // MANAGE_MESSAGES
  history: 1n << 16n, // READ_MESSAGE_HISTORY
  emojis: 1n << 30n, // MANAGE_GUILD_EXPRESSIONS (emoji and stickers)
  events: 1n << 33n, // MANAGE_EVENTS
  moderation: 1n << 40n, // MODERATE_MEMBERS (timeout)
  audit_log: 1n << 7n, // VIEW_AUDIT_LOG
};

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

// the panel's default scopes (D4PLAN 7.2): identify, email, guilds.join.
const DEFAULT_PANEL_SCOPES: readonly string[] = Object.freeze(["identify", "email", "guilds.join"]);

// every scope the panel can request, plus the two the invite always carries.
// an unknown scope is refused, so a typo never ships a half-built invite.
const KNOWN_SCOPES: ReadonlySet<string> = new Set([
  "bot",
  "applications.commands",
  "identify",
  "email",
  "connections",
  "guilds",
  "guilds.join",
  "guilds.members.read",
  "role_connections.write",
  "webhook.incoming",
  "relationships.read",
  "gdm.join",
]);

const PORTAL_TIMEOUT_MS = 10_000;

/** the install url. pure, so its shape is testable without a portal. */
export function inviteUrl(input: {
  applicationId: string;
  permissions: string;
  scopes: readonly string[];
}): string {
  for (const scope of input.scopes) {
    if (!KNOWN_SCOPES.has(scope)) {
      throw new Error(
        `unknown oauth2 scope ${JSON.stringify(scope)}; add it to docs/scopes.md before requesting it`,
      );
    }
  }
  const scope = ["bot", ...input.scopes].join("+");
  // built by hand rather than through URLSearchParams, which would encode the
  // "+" separators and produce a scope list discord reads as one scope.
  return `${AUTHORIZE_URL}?client_id=${input.applicationId}&permissions=${input.permissions}&scope=${scope}`;
}

export function createPortal(deps: PortalDeps): Portal {
  // the install url is sync but the application id arrives async, so the id is
  // cached the first time items() reads it.
  let appId: string | null = null;

  function permissionBits(): string {
    let bits = 0n;
    for (const feature of deps.features()) bits |= PERMISSION_BITS[feature];
    return bits.toString();
  }

  async function readEndpointUrl(): Promise<string | null | undefined> {
    // undefined means the api could not be read, which is not the same as "unset".
    try {
      const app = await deps.client.request<{ interactions_endpoint_url?: unknown }>({
        method: "GET",
        route: "/applications/@me",
        timeoutMs: PORTAL_TIMEOUT_MS,
      });
      const value = app?.interactions_endpoint_url;
      return typeof value === "string" && value !== "" ? value : null;
    } catch {
      return undefined;
    }
  }

  async function items(): Promise<readonly PortalItem[]> {
    const app = await deps.application();
    appId = app.id;
    const endpoint = await readEndpointUrl();
    const bits = permissionBits();
    const installUrl =
      app.id === null
        ? null
        : inviteUrl({ applicationId: app.id, permissions: bits, scopes: DEFAULT_PANEL_SCOPES });

    return [
      applicationItem(app),
      {
        index: 2,
        title: "redirect uris registered",
        body: `Paste this exact string into Developer Panel -> OAuth2 -> Redirects: ${deps.publicBaseUrl}/callback`,
        done: null,
        fix: null,
      },
      intentsItem(deps.memberIntent, app),
      {
        index: 4,
        title: "install link",
        body:
          installUrl === null
            ? "the application id is not known yet; settle the application item first, then reopen this page."
            : `Open this url to install the bot with the selected scopes:\n${installUrl}`,
        done: installUrl !== null,
        fix:
          installUrl === null
            ? "create the application in the Developer Panel, then rerun /setup app."
            : null,
      },
      {
        index: 5,
        title: "bot permissions",
        body: `the invite requests the permission bitfield ${bits} (decimal). Administrator is not included.`,
        done: true,
        fix: null,
      },
      interactionsItem(endpoint),
      {
        index: 7,
        title: "public key",
        body: "skip this. the public key verifies interaction signatures at an HTTP endpoint, and this bot connects over the gateway instead.",
        done: null,
        fix: null,
      },
    ];
  }

  function applicationItem(app: ApplicationFacts): PortalItem {
    const created = app.id !== null;
    const botPresent = app.botUserId !== null;
    const name = app.name ?? "(unnamed)";
    const body = created
      ? `GET /applications/@me returned ${name} (${app.id}); the bot user is ${botPresent ? `present (${app.botUserId})` : "missing"}.`
      : "GET /applications/@me returned no application. create one in the Developer Panel -> Applications -> New Application.";
    return {
      index: 1,
      title: "application created, bot user present",
      body,
      done: created && botPresent,
      fix:
        created && botPresent
          ? null
          : "create the application and add a bot user, then rerun /setup app test.",
    };
  }

  function intentsItem(memberIntent: boolean, app: ApplicationFacts): PortalItem {
    return {
      index: 3,
      title: "privileged intents",
      body: memberIntent
        ? `the gateway negotiated GUILD_MEMBERS, so the Server Members Intent is on (application flags ${app.flags}).`
        : `the gateway did not negotiate GUILD_MEMBERS (application flags ${app.flags}). turn the Server Members Intent on.`,
      done: memberIntent,
      fix: memberIntent
        ? null
        : "Developer Panel -> Bot -> Privileged Gateway Intents -> Server Members Intent, then restart the bot.",
    };
  }

  function interactionsItem(endpoint: string | null | undefined): PortalItem {
    if (endpoint === undefined) {
      return {
        index: 6,
        title: "interactions endpoint",
        body: "could not read the application to check for a stale endpoint url. this bot is gateway-only, so none is needed.",
        done: null,
        fix: "check Developer Panel -> General Information and clear any Interactions Endpoint URL.",
      };
    }
    return {
      index: 6,
      title: "interactions endpoint",
      body:
        endpoint === null
          ? "not used: this bot is gateway-only, so no Interactions Endpoint URL belongs here. leave it blank."
          : `an Interactions Endpoint URL is set (${endpoint}). this bot is gateway-only, and a stale endpoint makes every slash command fail with a silent 401.`,
      done: endpoint === null,
      fix:
        endpoint === null
          ? null
          : "clear the Interactions Endpoint URL in Developer Panel -> General Information; gateway clients must not set one.",
    };
  }

  return {
    items,
    permissionBits,
    invite(scopes: readonly string[] = DEFAULT_PANEL_SCOPES): string {
      if (appId === null) {
        throw new Error(
          "cannot build the install url: the application id is unknown, read items() first so GET /applications/@me has answered.",
        );
      }
      return inviteUrl({ applicationId: appId, permissions: permissionBits(), scopes });
    },
  };
}
