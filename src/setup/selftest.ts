// the /setup app self-test (D4PLAN 7.6).
//
// ten scripted lines, in the plan's order, each a pass or a fail with a fix. every
// probe is bounded so a hung call becomes a failed line instead of an unbounded
// await, and every line catches its own throw so run() always resolves with ten
// lines and never rejects.
//
// nothing here logs, and nothing here touches a token, an email, an ip, or a code.

import { DiscordApiError, formatDiscordError } from "../discord/errors.ts";
import { diagnoseCloseCode } from "../discord/gateway.ts";
import type { SelfTestLine } from "./deps.ts";

export interface SelfTestDeps {
  /** matches DiscordClient.request() exactly, so the real client drops in. */
  readonly client: {
    request<T>(options: {
      method: string;
      route: string;
      body?: unknown;
      timeoutMs?: number;
    }): Promise<T>;
  };
  readonly ownerId: string;
  readonly devGuildId: string | undefined;
  readonly gateway: () => { ready: boolean; pingMs: number | null };
  readonly web: { port: number; publicBaseUrl: string; listening(): Promise<boolean> };
  /** a third-party fetch of our own url, so the public path is proven from outside. */
  readonly publicFetch: (url: string) => Promise<{ status: number; body: string }>;
  readonly oauth: {
    authorizeStatus(scopes: readonly string[]): Promise<{ status: number; error: string | null }>;
  };
  readonly now: () => number;
}

const STEP_TIMEOUT_MS = 10_000;

// the step names, matching the D4PLAN 7.6 table. they are the line labels the
// wizard renders, so a caller can find a line by name.
const STEP = {
  token: "token valid",
  owner: "owner id correct",
  gateway: "gateway connected",
  members: "GUILD_MEMBERS granted",
  webPort: "web port reachable",
  publicUrl: "public url resolves",
  redirect: "redirect registered",
  oauth: "oauth round trip",
  history: "history readable",
  content: "message content present",
} as const;

// the panel's default scopes (D4PLAN 7.2). the oauth round trip requests these
// so the redirect check exercises the same scopes the panel will.
const PANEL_SCOPES: readonly string[] = Object.freeze(["identify", "email", "guilds.join"]);

const DEV_GUILD_FIX =
  "set DISCORD_DEV_GUILD_ID in .env to a test server the bot is already in, then restart snapback.";

/** a step that did not answer inside its budget. caught per line, never thrown out. */
class StepTimeout extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not answer within ${ms}ms`);
    this.name = "StepTimeout";
  }
}

/** the message of any throw, discord's own words when it is a DiscordApiError. */
function saidOf(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createSelfTest(deps: SelfTestDeps): { run(): Promise<readonly SelfTestLine[]> } {
  // race a probe against a deadline. the deadline is read from the injected clock
  // so a test can drive it; the wake-up is a timer, which is not a rate-limit sleep.
  async function bound<T>(label: string, work: () => Promise<T>): Promise<T> {
    const deadline = deps.now() + STEP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StepTimeout(label, STEP_TIMEOUT_MS)),
        Math.max(0, deadline - deps.now()),
      );
    });
    try {
      return await Promise.race([work(), guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function pass(step: string, said: string): SelfTestLine {
    return { step, passed: true, said, fix: null };
  }

  function fail(step: string, said: string, fix: string): SelfTestLine {
    return { step, passed: false, said, fix };
  }

  function failWith(step: string, error: unknown, fix: string): SelfTestLine {
    return fail(step, saidOf(error), fix);
  }

  async function tokenLine(): Promise<SelfTestLine> {
    const fix =
      "regenerate the token in the Developer Panel -> Bot -> Reset Token, then update DISCORD_TOKEN in .env.";
    try {
      const me = await bound(STEP.token, () =>
        deps.client.request<{ id?: unknown; username?: unknown }>({
          method: "GET",
          route: "/users/@me",
          timeoutMs: STEP_TIMEOUT_MS,
        }),
      );
      if (typeof me?.id === "string" && me.id !== "") {
        const name = typeof me.username === "string" ? me.username : me.id;
        return pass(STEP.token, `GET /users/@me returned the bot user ${name}`);
      }
      return fail(STEP.token, "GET /users/@me returned no bot user", fix);
    } catch (error) {
      return failWith(STEP.token, error, fix);
    }
  }

  async function ownerLine(): Promise<SelfTestLine> {
    const fix =
      "set DISCORD_OWNER_ID in .env to your own user id (enable Developer Mode, right-click your name, copy id).";
    try {
      const owner = await bound(STEP.owner, () =>
        deps.client.request<{ id?: unknown }>({
          method: "GET",
          route: `/users/${deps.ownerId}`,
          timeoutMs: STEP_TIMEOUT_MS,
        }),
      );
      if (owner?.id === deps.ownerId) {
        return pass(STEP.owner, `DISCORD_OWNER_ID resolves to a user (${deps.ownerId})`);
      }
      return fail(STEP.owner, `DISCORD_OWNER_ID ${deps.ownerId} did not resolve to itself`, fix);
    } catch (error) {
      return failWith(STEP.owner, error, fix);
    }
  }

  async function gatewayLine(): Promise<SelfTestLine> {
    const plainFix =
      "check the gateway logs; run /snapback diagnostics for the close code and its diagnosis.";
    try {
      const status = await bound(STEP.gateway, async () => deps.gateway());
      if (status.ready) {
        const ping = status.pingMs === null ? "no latency yet" : `${status.pingMs}ms`;
        return pass(STEP.gateway, `the shard reached ready (${ping})`);
      }
      return fail(STEP.gateway, "the shard did not reach ready", plainFix);
    } catch (error) {
      // when the gateway hands us a close code, use the module's own diagnosis.
      const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
      if (typeof code === "number") {
        const diagnosis = diagnoseCloseCode(code, saidOf(error));
        return fail(STEP.gateway, `${code} ${diagnosis.reason}`, diagnosis.diagnosis ?? plainFix);
      }
      return failWith(STEP.gateway, error, plainFix);
    }
  }

  async function membersLine(): Promise<SelfTestLine> {
    if (deps.devGuildId === undefined) {
      return fail(STEP.members, "DISCORD_DEV_GUILD_ID is not set", DEV_GUILD_FIX);
    }
    const fix =
      "enable the Server Members Intent: Developer Panel -> Bot -> Privileged Gateway Intents -> Server Members Intent, then restart.";
    try {
      await bound(STEP.members, () =>
        deps.client.request({
          method: "GET",
          route: `/guilds/${deps.devGuildId}/members?limit=1000`,
          timeoutMs: STEP_TIMEOUT_MS,
        }),
      );
      return pass(STEP.members, `the 1000-limit member fetch on ${deps.devGuildId} returned`);
    } catch (error) {
      const tailored =
        error instanceof DiscordApiError && error.code === 50001
          ? fix
          : `check the bot is in the guild ${deps.devGuildId} and that DISCORD_DEV_GUILD_ID points at it.`;
      return failWith(STEP.members, error, tailored);
    }
  }

  async function webPortLine(): Promise<SelfTestLine> {
    const fix = `start the web server (it runs with the bot) or change PORT; nothing accepted a connection on ${deps.web.port}.`;
    try {
      const listening = await bound(STEP.webPort, () => deps.web.listening());
      if (listening) return pass(STEP.webPort, `something is listening on port ${deps.web.port}`);
      return fail(STEP.webPort, `nothing is listening on ${deps.web.port}`, fix);
    } catch (error) {
      return failWith(STEP.webPort, error, fix);
    }
  }

  async function publicUrlLine(): Promise<SelfTestLine> {
    const url = `${deps.web.publicBaseUrl}/health`;
    const fix =
      "PUBLIC_BASE_URL did not respond over HTTPS from the public internet; check the tunnel or reverse proxy points at this port.";
    try {
      const result = await bound(STEP.publicUrl, () => deps.publicFetch(url));
      if (result.status === 200) return pass(STEP.publicUrl, `${url} answered 200 from outside`);
      return fail(STEP.publicUrl, `${url} answered ${result.status}`, fix);
    } catch (error) {
      return failWith(STEP.publicUrl, error, fix);
    }
  }

  // lines 7 and 8 share one oauth round trip, so the probe runs once.
  async function oauthLines(): Promise<readonly [SelfTestLine, SelfTestLine]> {
    const redirectFix = `add ${deps.web.publicBaseUrl}/callback to Redirect URIs in the Developer Panel -> OAuth2 -> Redirects.`;
    const exchangeFix =
      "code exchange failed: check the client secret in the Developer Panel -> OAuth2 and that the redirect is registered.";

    let result: { status: number; error: string | null } | null = null;
    let thrown: unknown;
    try {
      result = await bound(STEP.oauth, () => deps.oauth.authorizeStatus(PANEL_SCOPES));
    } catch (error) {
      thrown = error;
    }

    const redirect = ((): SelfTestLine => {
      if (thrown !== undefined) return failWith(STEP.redirect, thrown, redirectFix);
      if (result === null)
        return fail(STEP.redirect, "the oauth authorize request did not run", redirectFix);
      if (result.status !== 200) {
        return fail(
          STEP.redirect,
          `the oauth authorize url answered ${result.status}`,
          redirectFix,
        );
      }
      if (result.error === "invalid_redirect_uri") {
        return fail(STEP.redirect, "invalid_redirect_uri", redirectFix);
      }
      return pass(STEP.redirect, `${deps.web.publicBaseUrl}/callback is a registered redirect`);
    })();

    const roundTrip = ((): SelfTestLine => {
      if (thrown !== undefined) return failWith(STEP.oauth, thrown, exchangeFix);
      if (result === null) return fail(STEP.oauth, "the oauth round trip did not run", exchangeFix);
      if (result.status !== 200) {
        return fail(STEP.oauth, `the oauth round trip answered ${result.status}`, exchangeFix);
      }
      if (result.error !== null) {
        const fix = result.error.includes("invalid_client")
          ? "code exchange failed: invalid_client. check the client secret in the Developer Panel -> OAuth2."
          : exchangeFix;
        return fail(STEP.oauth, result.error, fix);
      }
      return pass(STEP.oauth, "the authorize, code exchange and revoke round trip succeeded");
    })();

    return [redirect, roundTrip];
  }

  // lines 9 and 10 share one history fetch on one text channel in the dev guild.
  async function historyLines(): Promise<readonly [SelfTestLine, SelfTestLine]> {
    if (deps.devGuildId === undefined) {
      return [
        fail(STEP.history, "DISCORD_DEV_GUILD_ID is not set", DEV_GUILD_FIX),
        fail(STEP.content, "DISCORD_DEV_GUILD_ID is not set", DEV_GUILD_FIX),
      ];
    }
    const historyFix =
      "read message history failed: grant VIEW_CHANNEL and READ_MESSAGE_HISTORY to the bot in that channel.";
    const contentFix =
      "message content came back empty; check channel permissions, not the Message Content intent.";

    let channelId: string;
    let messages: ReadonlyArray<{ content?: unknown }>;
    try {
      channelId = await bound(STEP.history, () => firstTextChannel(deps.devGuildId as string));
      messages = await bound(STEP.history, () =>
        deps.client.request<ReadonlyArray<{ content?: unknown }>>({
          method: "GET",
          route: `/channels/${channelId}/messages?limit=1`,
          timeoutMs: STEP_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      const tailored =
        error instanceof DiscordApiError && error.code === 50001
          ? historyFix
          : `check the bot is in the guild ${deps.devGuildId} and that DISCORD_DEV_GUILD_ID points at it.`;
      return [failWith(STEP.history, error, tailored), failWith(STEP.content, error, contentFix)];
    }

    const history = pass(STEP.history, `GET /channels/${channelId}/messages?limit=1 returned`);
    const first = messages[0];
    const content = typeof first?.content === "string" ? first.content : "";
    const present =
      content !== ""
        ? pass(STEP.content, `the latest message has ${content.length} chars of content`)
        : fail(STEP.content, "the latest message came back with empty content", contentFix);
    return [history, present];
  }

  async function firstTextChannel(guildId: string): Promise<string> {
    const channels = await bound(STEP.history, () =>
      deps.client.request<ReadonlyArray<{ id?: unknown; type?: unknown }>>({
        method: "GET",
        route: `/guilds/${guildId}/channels`,
        timeoutMs: STEP_TIMEOUT_MS,
      }),
    );
    const text = channels.find((channel) => channel.type === 0 && typeof channel.id === "string");
    if (text === undefined || typeof text.id !== "string") {
      throw new Error("the dev guild has no text channel to read");
    }
    return text.id;
  }

  async function run(): Promise<readonly SelfTestLine[]> {
    // awaited one at a time, in the plan's order, so the probes run in the order
    // the operator reads them.
    const lines: SelfTestLine[] = [];
    lines.push(await tokenLine());
    lines.push(await ownerLine());
    lines.push(await gatewayLine());
    lines.push(await membersLine());
    lines.push(await webPortLine());
    lines.push(await publicUrlLine());
    const [redirect, roundTrip] = await oauthLines();
    lines.push(redirect, roundTrip);
    const [history, content] = await historyLines();
    lines.push(history, content);
    return lines;
  }

  return { run };
}
