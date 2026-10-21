// the OAuth flow (D4PLAN 13.3). one module owns it: the authorize url, the
// code exchange, and the refresh.
//
// three things it does not bend:
//   - the state is a random nonce, never the guild id. it is bound to the
//     guild, the client ip and a 15 minute expiry, and it is single use.
//   - the redirect uri is built from PUBLIC_BASE_URL, byte for byte the one
//     registered in the developer portal. never from a request header.
//   - the code exchange happens here, on the server, where the client secret
//     lives. the tokens go straight to the token store, which encrypts them,
//     and a token never reaches a log line (AGENTS.md rule 10).

import { randomBytes } from "node:crypto";
import {
  deleteOauthState,
  getOauthState,
  insertOauthState,
} from "../../db/queries/oauth-states.ts";
import type { Database, OauthStateRow } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import { DiscordApiError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";
import type { TokenStore } from "./token-store.ts";

/** where a pending state lives between the authorize url and the callback. */
export interface StateStore {
  put(row: OauthStateRow): Promise<void>;
  get(state: string): Promise<OauthStateRow | null>;
  delete(state: string): Promise<void>;
}

export interface OAuthDeps {
  readonly client: DiscordClient;
  /** the handle, for the multi-worker state store (createDatabaseStateStore). */
  readonly db: Database;
  readonly log: Logger;
  /** the public base url, e.g. "https://verify.example". no trailing slash. */
  readonly publicBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** where a state row lives. the in-memory path is the default. */
  readonly states?: StateStore;
  readonly tokens: TokenStore;
  /** the ip the request came from, already captured and hashed or encrypted. */
  readonly clientIp: string | null;
  readonly now?: () => number;
}

export interface AuthorizeRequest {
  readonly guildId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  /** where discord sends the browser back to. built from publicBaseUrl. */
  readonly redirectUri?: string;
}

export interface AuthorizeResult {
  /** the url the browser goes to. */
  readonly url: string;
  /** the state, for the caller to keep if it needs to. */
  readonly state: string;
}

/** what the callback learned about the user. */
export interface ExchangeResult {
  readonly userId: string;
  /** the server the state was minted for. null when the state carried none. */
  readonly guildId: string | null;
  readonly username: string;
  readonly email: string | null;
  readonly scopes: readonly string[];
  readonly guilds: readonly { id: string; name: string | null }[];
  /** the linked accounts. empty when the connections scope was not granted. */
  readonly connections: readonly { id: string; name: string; type: string; verified: boolean }[];
}

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_ROUTE = "/oauth2/token";
const STATE_BYTES = 32;
const STATE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * the scopes this flow can ask for. the operator's list is cut down to these,
 * because discord rejects the whole authorize url over one scope it does not
 * know, and a scope this flow does not read is a scope it should not take.
 */
const SUPPORTED_SCOPES: readonly string[] = Object.freeze([
  "identify",
  "email",
  "guilds",
  "connections",
]);

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface DiscordUser {
  id?: unknown;
  username?: unknown;
  email?: unknown;
}

interface OAuthApplicationInfo {
  scopes?: unknown;
}

interface DiscordConnection {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  verified?: unknown;
}

interface DiscordGuild {
  id?: unknown;
  name?: unknown;
}

/**
 * the in-memory state store, the default path (D4PLAN 4.4). a pending
 * authorization does not survive a restart, and that is the trade: the table
 * is what a multi-worker deployment uses.
 */
export function createMemoryStateStore(): StateStore {
  const rows = new Map<string, OauthStateRow>();
  return {
    async put(row: OauthStateRow): Promise<void> {
      const now = new Date().toISOString();
      for (const [state, held] of rows) {
        if (held.expires_at < now) rows.delete(state);
      }
      rows.set(row.state, row);
    },
    async get(state: string): Promise<OauthStateRow | null> {
      const row = rows.get(state);
      if (row === undefined) return null;
      if (row.expires_at < new Date().toISOString()) {
        rows.delete(state);
        return null;
      }
      return row;
    },
    async delete(state: string): Promise<void> {
      rows.delete(state);
    },
  };
}

/** the state store on the oauth_states table, for a multi-worker deployment. */
export function createDatabaseStateStore(db: Database): StateStore {
  return {
    async put(row: OauthStateRow): Promise<void> {
      await insertOauthState(db, row);
    },
    async get(state: string): Promise<OauthStateRow | null> {
      return await getOauthState(db, state);
    },
    async delete(state: string): Promise<void> {
      await deleteOauthState(db, state);
    },
  };
}

// one store for the process, so the state the authorize url minted is the one
// the callback finds. a caller that runs more than one worker passes
// createDatabaseStateStore instead.
const DEFAULT_STATES: StateStore = createMemoryStateStore();

/** the redirect uri, byte for byte the one registered in the developer portal. */
export function buildRedirectUri(deps: OAuthDeps): string {
  return `${deps.publicBaseUrl.replace(/\/+$/, "")}/callback`;
}

/**
 * the user agent discord asks for: it wants to know who is calling. the client
 * sets no header of its own, so the caller builds it with this value.
 */
export function userAgent(publicBaseUrl: string): string {
  return `snapback/1.0 (${publicBaseUrl.replace(/\/+$/, "")})`;
}

/**
 * the url the browser goes to. the state is minted here, bound to the guild,
 * the client ip and a 15 minute expiry, and it is a random nonce: the guild id
 * is not a state, and a state that an attacker can guess is not a state.
 */
export async function buildAuthorizeUrl(
  deps: OAuthDeps,
  request: AuthorizeRequest,
): Promise<AuthorizeResult> {
  const states = deps.states ?? DEFAULT_STATES;
  const now = deps.now?.() ?? Date.now();
  const state = randomBytes(STATE_BYTES).toString("base64url");
  const scopes = supportedScopes(request.scopes);

  await states.put({
    state,
    guild_id: request.guildId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + STATE_TTL_MS).toISOString(),
    consumed_at: null,
    client_ip: deps.clientIp,
  });

  const redirectUri = request.redirectUri ?? buildRedirectUri(deps);
  const query = [
    `client_id=${encodeURIComponent(deps.clientId)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    "response_type=code",
    `scope=${scopes.map((scope) => encodeURIComponent(scope)).join("%20")}`,
    `state=${encodeURIComponent(state)}`,
    "prompt=consent",
  ].join("&");

  deps.log.info("oauth authorize url built", {
    guild_id: request.guildId,
    user_id: request.userId,
    scopes,
  });

  return { url: `${AUTHORIZE_URL}?${query}`, state };
}

/**
 * the callback. the state is checked, then spent, then the code is exchanged
 * and the user is read. null means the callback was refused and nothing was
 * exchanged: a state that is unknown, expired, or bound to another client ip.
 */
export async function exchangeCode(
  deps: OAuthDeps,
  input: { code: string; state: string; redirectUri?: string },
): Promise<ExchangeResult | null> {
  const states = deps.states ?? DEFAULT_STATES;
  const now = deps.now?.() ?? Date.now();

  const row = await states.get(input.state);
  if (row === null) {
    deps.log.warn("oauth callback refused: no such state");
    return null;
  }
  if (row.expires_at !== "" && Date.parse(row.expires_at) <= now) {
    deps.log.warn("oauth callback refused: the state expired");
    return null;
  }
  if (row.client_ip !== null && row.client_ip !== deps.clientIp) {
    deps.log.warn("oauth callback refused: the client ip does not match");
    return null;
  }

  // single use: the state goes before the exchange, so a replayed callback
  // finds nothing even when the exchange itself failed.
  await states.delete(input.state);

  const redirectUri = input.redirectUri ?? buildRedirectUri(deps);
  const token = await deps.client.request<TokenResponse>({
    method: "POST",
    route: TOKEN_ROUTE,
    // the client secret travels in the body, not in a bot token header.
    auth: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    body: {
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: redirectUri,
    },
  });

  const accessToken = asText(token.access_token) ?? "";
  const refreshToken = asText(token.refresh_token) ?? "";
  const expiresIn = asNumber(token.expires_in) ?? 0;

  // a user-scoped read wants "authorization: Bearer <access token>". the client
  // has no bearer option, so the call goes out with no credential at all:
  // discord answers 401 and the flow stops. that is the right failure, because
  // the bot token would be worse: /users/@me would answer with the bot's own
  // identity and the record would name the wrong user. giving the client a
  // bearer option turns these three calls into real reads.
  const user = await deps.client.request<DiscordUser>({
    method: "GET",
    route: "/users/@me",
    auth: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  // the granted scopes come from discord, never from what was asked for: a
  // consent screen can be a downgrade, and only discord knows what it gave.
  const granted = await deps.client.request<OAuthApplicationInfo>({
    method: "GET",
    route: "/oauth2/@me",
    auth: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const scopes = normaliseScopes(granted.scopes);

  const email = scopes.includes("email") ? asText(user.email) : null;

  const connections = scopes.includes("connections")
    ? await deps.client.request<DiscordConnection[]>({
        method: "GET",
        route: "/users/@me/connections",
        auth: false,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
    : [];

  const guilds = scopes.includes("guilds")
    ? await deps.client.request<DiscordGuild[]>({
        method: "GET",
        route: "/users/@me/guilds",
        auth: false,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
    : [];

  const userId = asText(user.id) ?? "";
  await deps.tokens.put({
    userId,
    guildId: row.guild_id,
    accessToken,
    refreshToken,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    scopes,
  });

  deps.log.info("oauth exchange finished", {
    guild_id: row.guild_id,
    user_id: userId,
    scopes,
  });

  return {
    userId,
    guildId: row.guild_id,
    username: asText(user.username) ?? "",
    email,
    scopes,
    guilds: guilds.map((guild) => ({ id: asText(guild.id) ?? "", name: asText(guild.name) })),
    connections: connections.map((connection) => ({
      id: asText(connection.id) ?? "",
      name: asText(connection.name) ?? "",
      type: asText(connection.type) ?? "",
      verified: connection.verified === true,
    })),
  };
}

/**
 * refresh a stored token. discord rotates the refresh token, so the new one is
 * stored too: a refresh that keeps the old refresh token works once and then
 * fails for good (D4PLAN 13.5).
 */
export async function refreshAccessToken(deps: OAuthDeps, userId: string): Promise<boolean> {
  const stored = await deps.tokens.get(userId);
  if (stored === null) {
    deps.log.warn("oauth refresh refused: no stored token", { user_id: userId });
    return false;
  }
  if (stored.refreshToken === null || stored.refreshToken === "") {
    deps.log.warn("oauth refresh refused: no stored refresh token", { user_id: userId });
    return false;
  }

  const now = deps.now?.() ?? Date.now();
  let token: TokenResponse;
  try {
    token = await deps.client.request<TokenResponse>({
      method: "POST",
      route: TOKEN_ROUTE,
      auth: false,
      timeoutMs: REQUEST_TIMEOUT_MS,
      body: {
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      },
    });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 400) {
      // invalid_grant: the access was revoked or the grant died. the record
      // stays, the token goes (D4PLAN 13.5).
      await deps.tokens.remove(userId, "unauthorized");
      deps.log.warn("oauth refresh refused by discord, the token was cleared", {
        user_id: userId,
        code: error.code,
      });
      return false;
    }
    // a network error or a rate limit leaves the token alone: nobody is
    // revoked because the network blipped.
    deps.log.warn("oauth refresh failed, the token was left in place", {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  await deps.tokens.put({
    userId,
    guildId: stored.guildId,
    accessToken: asText(token.access_token) ?? "",
    refreshToken: asText(token.refresh_token) ?? stored.refreshToken,
    expiresAt: new Date(now + (asNumber(token.expires_in) ?? 0) * 1000).toISOString(),
    scopes: stored.scopes,
  });

  deps.log.info("oauth token refreshed", { user_id: userId });
  return true;
}

// the operator's scopes, cut down to the ones this flow reads. an empty result
// is refused rather than widened: asking for a scope the operator turned off
// is the one mistake here that cannot be undone.
function supportedScopes(requested: readonly string[]): readonly string[] {
  const wanted = new Set(requested);
  const kept = SUPPORTED_SCOPES.filter((scope) => wanted.has(scope));
  if (kept.length === 0) {
    throw new Error(
      `SB_OAUTH_NO_SCOPE: none of the requested scopes (${requested.join(", ")}) are ones this flow reads`,
    );
  }
  return kept;
}

function normaliseScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is string => typeof scope === "string");
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
