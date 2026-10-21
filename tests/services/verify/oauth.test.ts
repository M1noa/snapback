// tests/services/verify/oauth.test.ts. the OAuth flow (D4PLAN 13.3) against a
// recording client: the authorize url carries the client id, the redirect uri
// built from PUBLIC_BASE_URL, and a state that is 32 random bytes and not the
// guild id; a callback with a wrong or expired state is refused and exchanges
// nothing; the state is spent before the exchange, so a replay finds nothing;
// and the granted scopes come from /oauth2/@me rather than from the request.

import { describe, expect, test } from "bun:test";
import type { Database, OauthStateRow } from "../../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../../src/discord/client.ts";
import { createLogger, type LogFields, type LogLevel } from "../../../src/lib/log.ts";
import {
  buildAuthorizeUrl,
  buildRedirectUri,
  exchangeCode,
  type OAuthDeps,
  refreshAccessToken,
  type StateStore,
  userAgent,
} from "../../../src/services/verify/oauth.ts";
import type { StoredToken, TokenStore } from "../../../src/services/verify/token-store.ts";

const GUILD = "123456789012345678";
const USER = "987654321098765432";
const CLIENT_ID = "300000000000000001";
const CLIENT_SECRET = "the-client-secret";
const PUBLIC_BASE_URL = "https://verify.example";
const REDIRECT_URI = "https://verify.example/callback";
const CLIENT_IP = "hash-of-the-client-ip";
const BASE_TIME = 1_700_000_000_000;

interface Recorded {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
  readonly auth: boolean | undefined;
}

interface Answers {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly userId: string;
  readonly username: string;
  readonly email: string | null;
  readonly grantedScopes: readonly string[];
  readonly connections: readonly unknown[];
  readonly guilds: readonly unknown[];
  /** an error to throw for a route, or undefined to let it through. */
  readonly fail: ((route: string) => unknown) | undefined;
}

const DEFAULT_ANSWERS: Answers = {
  accessToken: "the-access-token",
  refreshToken: "the-refresh-token",
  expiresIn: 604_800,
  userId: USER,
  username: "verified",
  email: "verified@example.com",
  grantedScopes: ["identify", "email"],
  connections: [],
  guilds: [],
  fail: undefined,
};

/** a client that records every request and answers from the answers table. */
function fakeClient(answers: Partial<Answers> = {}): { client: DiscordClient; calls: Recorded[] } {
  const table: Answers = { ...DEFAULT_ANSWERS, ...answers };
  const calls: Recorded[] = [];
  const client = {
    async request<T>(options: RequestOptions): Promise<T> {
      calls.push({
        method: options.method,
        route: options.route,
        body: options.body,
        auth: options.auth,
      });
      const failure = table.fail?.(options.route);
      if (failure !== undefined) throw failure;

      if (options.route === "/oauth2/token") {
        return {
          access_token: table.accessToken,
          refresh_token: table.refreshToken,
          expires_in: table.expiresIn,
          scope: table.grantedScopes.join(" "),
        } as T;
      }
      if (options.route === "/users/@me") {
        return { id: table.userId, username: table.username, email: table.email } as T;
      }
      if (options.route === "/oauth2/@me") {
        return { scopes: table.grantedScopes } as T;
      }
      if (options.route === "/users/@me/connections") {
        return table.connections as T;
      }
      if (options.route === "/users/@me/guilds") {
        return table.guilds as T;
      }
      return {} as T;
    },
  } as unknown as DiscordClient;
  return { client, calls };
}

/** a state store that keeps the rows it is given, so a test can look at one. */
class RecordingStateStore implements StateStore {
  readonly rows = new Map<string, OauthStateRow>();
  readonly deleted: string[] = [];
  async put(row: OauthStateRow): Promise<void> {
    this.rows.set(row.state, row);
  }
  async get(state: string): Promise<OauthStateRow | null> {
    return this.rows.get(state) ?? null;
  }
  async delete(state: string): Promise<void> {
    this.deleted.push(state);
    this.rows.delete(state);
  }
}

/** a token store that keeps what it is given, in memory and in the clear. */
class RecordingTokenStore implements TokenStore {
  readonly puts: {
    userId: string;
    guildId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes: readonly string[];
  }[] = [];
  readonly updates: { userId: string; accessToken: string; expiresAt: string }[] = [];
  readonly removes: { userId: string; status: string | undefined }[] = [];
  stored: StoredToken | null = null;
  async put(input: {
    userId: string;
    guildId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes: readonly string[];
  }): Promise<void> {
    this.puts.push(input);
    this.stored = {
      userId: input.userId,
      guildId: input.guildId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      scopes: input.scopes,
    };
  }
  async get(userId: string): Promise<StoredToken | null> {
    return this.stored?.userId === userId ? this.stored : null;
  }
  async update(userId: string, input: { accessToken: string; expiresAt: string }): Promise<void> {
    this.updates.push({ userId, ...input });
    if (this.stored?.userId === userId) {
      this.stored = { ...this.stored, accessToken: input.accessToken, expiresAt: input.expiresAt };
    }
  }
  async remove(userId: string, status?: string): Promise<void> {
    this.removes.push({ userId, status });
    if (this.stored?.userId === userId) this.stored = null;
  }
}

interface Harness {
  readonly deps: OAuthDeps;
  readonly calls: Recorded[];
  readonly states: RecordingStateStore;
  readonly tokens: RecordingTokenStore;
  readonly logs: { msg: string; fields: LogFields }[];
  readonly clock: { now: number };
  setClientIp(ip: string | null): void;
}

function harness(
  options: { answers?: Partial<Answers>; clientIp?: string | null; level?: LogLevel } = {},
): Harness {
  const { client, calls } = fakeClient(options.answers);
  const states = new RecordingStateStore();
  const tokens = new RecordingTokenStore();
  const logs: { msg: string; fields: LogFields }[] = [];
  const clock = { now: BASE_TIME };
  const ip = { value: options.clientIp === undefined ? CLIENT_IP : options.clientIp };
  const log = createLogger({
    level: options.level ?? "warn",
    dir: null,
    channelSink: (record) => {
      logs.push({ msg: record.msg, fields: record.fields });
    },
  });

  const deps: OAuthDeps = {
    client,
    db: {} as Database,
    log,
    publicBaseUrl: PUBLIC_BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    states,
    tokens,
    get clientIp(): string | null {
      return ip.value;
    },
    now: () => clock.now,
  };
  return {
    deps,
    calls,
    states,
    tokens,
    logs,
    clock,
    setClientIp: (value: string | null) => {
      ip.value = value;
    },
  };
}

async function authorize(h: Harness, scopes: readonly string[] = ["identify", "email"]) {
  return await buildAuthorizeUrl(h.deps, { guildId: GUILD, userId: USER, scopes });
}

describe("the authorize url", () => {
  test("carries the client id, the redirect uri and a 32 byte state", async () => {
    const h = harness();
    const result = await authorize(h);

    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("scope")).toBe("identify email");

    // 32 random bytes, base64url, and never the guild id.
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.state, "base64url").length).toBe(32);
    expect(result.state).not.toBe(GUILD);
    expect(url.searchParams.get("state")).not.toBe(GUILD);
  });

  test("two runs mint two different states", async () => {
    const h = harness();
    const first = await authorize(h);
    const second = await authorize(h);
    expect(first.state).not.toBe(second.state);
  });

  test("the redirect uri is built from the public base url, byte for byte", async () => {
    const h = harness();
    expect(buildRedirectUri(h.deps)).toBe(REDIRECT_URI);
    const result = await authorize(h);

    const exchange = await exchangeCode(h.deps, { code: "the-code", state: result.state });
    expect(exchange).not.toBeNull();

    // the same string in the authorize url and in the exchange, which is what
    // discord compares against the registered redirect uri.
    const tokenCall = h.calls.find((call) => call.route === "/oauth2/token");
    const body = tokenCall?.body as { redirect_uri: string };
    expect(body.redirect_uri).toBe(REDIRECT_URI);
  });

  test("the user agent names the app and the instance", () => {
    expect(userAgent(PUBLIC_BASE_URL)).toBe("snapback/1.0 (https://verify.example)");
  });

  test("the state is stored with the guild, the client ip and a 15 minute expiry", async () => {
    const h = harness();
    const result = await authorize(h);
    const row = h.states.rows.get(result.state);

    expect(row?.guild_id).toBe(GUILD);
    expect(row?.client_ip).toBe(CLIENT_IP);
    expect(row?.consumed_at).toBeNull();
    expect(Date.parse(row?.expires_at ?? "") - Date.parse(row?.created_at ?? "")).toBe(
      15 * 60 * 1000,
    );
  });
});

describe("the callback", () => {
  test("refuses a state it does not know and exchanges nothing", async () => {
    const h = harness();
    const result = await exchangeCode(h.deps, { code: "the-code", state: "not-a-real-state" });

    expect(result).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  test("refuses an expired state and exchanges nothing", async () => {
    const h = harness();
    const { state } = await authorize(h);
    h.clock.now = BASE_TIME + 16 * 60 * 1000;

    const result = await exchangeCode(h.deps, { code: "the-code", state });
    expect(result).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  test("refuses a state bound to another client ip", async () => {
    const h = harness();
    const { state } = await authorize(h);
    h.setClientIp(null);

    const result = await exchangeCode(h.deps, { code: "the-code", state });
    expect(result).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  test("spends the state before the exchange, so a replay finds nothing", async () => {
    const h = harness();
    const { state } = await authorize(h);

    const first = await exchangeCode(h.deps, { code: "the-code", state });
    expect(first).not.toBeNull();
    expect(h.states.deleted).toContain(state);
    const callsAfterFirst = h.calls.length;

    const second = await exchangeCode(h.deps, { code: "the-code", state });
    expect(second).toBeNull();
    expect(h.calls).toHaveLength(callsAfterFirst);
  });

  test("hands the guild the state was minted for back to the caller", async () => {
    const h = harness();
    const { state } = await authorize(h);

    const result = await exchangeCode(h.deps, { code: "the-code", state });
    expect(result?.guildId).toBe(GUILD);
  });

  test("takes the granted scopes from /oauth2/@me, not from the request", async () => {
    const h = harness({ answers: { grantedScopes: ["identify"] } });
    const { state } = await authorize(h, ["identify", "email", "guilds"]);

    const result = await exchangeCode(h.deps, { code: "the-code", state });
    expect(result?.scopes).toEqual(["identify"]);
    // the guilds scope was not granted, so the guild list was never read.
    expect(h.calls.some((call) => call.route === "/users/@me/guilds")).toBe(false);
  });

  test("reads the email only when the scope allows it", async () => {
    const granted = harness({ answers: { grantedScopes: ["identify", "email"] } });
    const withEmail = await exchangeCode(granted.deps, {
      code: "the-code",
      state: (await authorize(granted)).state,
    });
    expect(withEmail?.email).toBe("verified@example.com");

    const refused = harness({ answers: { grantedScopes: ["identify"] } });
    const withoutEmail = await exchangeCode(refused.deps, {
      code: "the-code",
      state: (await authorize(refused)).state,
    });
    expect(withoutEmail?.email).toBeNull();
  });

  test("reads the connections and the guilds when the scopes are granted", async () => {
    const h = harness({
      answers: {
        grantedScopes: ["identify", "connections", "guilds"],
        connections: [{ id: "steam-1", name: "steam", type: "steam", verified: true }],
        guilds: [{ id: "111111111111111111", name: "a guild" }],
      },
    });
    const { state } = await authorize(h, ["identify", "connections", "guilds"]);

    const result = await exchangeCode(h.deps, { code: "the-code", state });
    expect(result?.connections).toEqual([
      { id: "steam-1", name: "steam", type: "steam", verified: true },
    ]);
    expect(result?.guilds).toEqual([{ id: "111111111111111111", name: "a guild" }]);
  });

  test("stores the token through the token store", async () => {
    const h = harness();
    const { state } = await authorize(h);

    await exchangeCode(h.deps, { code: "the-code", state });
    expect(h.tokens.puts).toHaveLength(1);
    expect(h.tokens.puts[0]?.userId).toBe(USER);
    expect(h.tokens.puts[0]?.guildId).toBe(GUILD);
    expect(h.tokens.puts[0]?.accessToken).toBe("the-access-token");
    expect(h.tokens.puts[0]?.refreshToken).toBe("the-refresh-token");
    expect(h.tokens.puts[0]?.scopes).toEqual(["identify", "email"]);
  });

  test("keeps the token, the email and the ip out of the log", async () => {
    const h = harness({ level: "debug" });
    const { state } = await authorize(h);
    await exchangeCode(h.deps, { code: "the-code", state });

    const written = h.logs
      .map((entry) => `${entry.msg} ${JSON.stringify(entry.fields)}`)
      .join("\n");
    expect(written).not.toContain("the-access-token");
    expect(written).not.toContain("the-refresh-token");
    expect(written).not.toContain("verified@example.com");
    expect(written).not.toContain(CLIENT_IP);
  });
});

describe("the refresh", () => {
  test("stores the new token and reports that it worked", async () => {
    const h = harness({
      answers: { accessToken: "the-new-access-token", refreshToken: "the-new-refresh-token" },
    });
    h.tokens.stored = {
      userId: USER,
      guildId: GUILD,
      accessToken: "the-old-access-token",
      refreshToken: "the-old-refresh-token",
      expiresAt: "2024-01-01T00:00:00.000Z",
      scopes: ["identify"],
    };

    const refreshed = await refreshAccessToken(h.deps, USER);
    expect(refreshed).toBe(true);
    expect(h.tokens.puts.at(-1)?.accessToken).toBe("the-new-access-token");
    // discord rotates the refresh token, so the new one has to be stored.
    expect(h.tokens.puts.at(-1)?.refreshToken).toBe("the-new-refresh-token");
  });

  test("reports that it failed when there is no stored token", async () => {
    const h = harness();
    expect(await refreshAccessToken(h.deps, USER)).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});
