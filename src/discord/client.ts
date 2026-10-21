// discord/client.ts (AGENTS.md rule 6, D4PLAN 4 and 18.1).
//
// the one place in this codebase that talks REST to discord.com. oceanic.js owns
// the gateway; this owns the http. that split is deliberate: oceanic's own REST
// would hand back its own error objects, and rule 5 needs discord's raw code,
// message and field errors, verbatim.
//
// request bodies are snake_case, because they are raw discord payloads. nothing
// here converts casing: a camelCase key reaching discord is a bug in the caller
// and the mocks in tests/discord/client.test.ts exist to catch exactly that.
//
// every request has a timeout. no unbounded awaits.

import type { Logger } from "../lib/log.ts";
import { redactValue } from "../lib/redact.ts";
import { DiscordApiError } from "./errors.ts";
import { RateLimiter } from "./ratelimit.ts";

const DEFAULT_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 15_000;
/** discord's own cap on X-Audit-Log-Reason. longer is a 400, not a truncation. */
const AUDIT_REASON_MAX = 512;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  readonly method: HttpMethod;
  /** a path under the api base, query string included. never an absolute url. */
  readonly route: string;
  /** serialized as json. snake_case keys, per discord. */
  readonly body?: unknown;
  /** becomes X-Audit-Log-Reason, url encoded. */
  readonly reason?: string;
  /** false for the few routes that take no auth. defaults to true. */
  readonly auth?: boolean;
  readonly timeoutMs?: number;
  /** the limiter groups by this when it differs from the wire route. */
  readonly bucketRoute?: string;
}

export type DiscordClientErrorCode =
  | "SB_CLIENT_BAD_ROUTE"
  | "SB_CLIENT_BAD_REASON"
  /** the request never completed: a refused connection, a timeout, a dropped
   *  stream. that is ours, not discord's, so it gets our fixed wording. */
  | "SB_CLIENT_TRANSPORT";

export class DiscordClientError extends Error {
  readonly code: DiscordClientErrorCode;
  constructor(code: DiscordClientErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DiscordClientError";
    this.code = code;
  }
}

export interface DiscordClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly limiter?: RateLimiter;
  /** injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** redaction is applied to every field before anything is logged. */
  readonly log?: Logger;
  readonly timeoutMs?: number;
}

export class DiscordClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #limiter: RateLimiter;
  readonly #fetch: typeof fetch;
  readonly #log: Logger | undefined;
  readonly #timeoutMs: number;

  constructor(options: DiscordClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#limiter = options.limiter ?? new RateLimiter();
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#log = options.log;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get limiter(): RateLimiter {
    return this.#limiter;
  }

  /** one call, limited and parsed. throws DiscordApiError on any non-2xx. */
  async request<T>(options: RequestOptions): Promise<T> {
    const route = assertRelativeRoute(options.route);
    const bucketRoute = options.bucketRoute ?? route;

    const response = await this.#limiter.run(bucketRoute, () => this.#send(route, options));
    return await this.#parse<T>(response, options);
  }

  async #send(route: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.auth !== false) headers.authorization = `Bot ${this.#token}`;
    if (options.reason !== undefined) {
      if (options.reason.length > AUDIT_REASON_MAX) {
        throw new DiscordClientError(
          "SB_CLIENT_BAD_REASON",
          `audit log reason is ${options.reason.length} chars, discord's limit is ${AUDIT_REASON_MAX}`,
        );
      }
      headers["x-audit-log-reason"] = encodeURIComponent(options.reason);
    }

    let body: string | FormData | undefined;
    if (options.body instanceof FormData) {
      // multipart carries its own boundary, so the content-type is left to fetch.
      // restoring a message with an attachment is the only caller (rule 6).
      body = options.body;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    try {
      return await this.#fetch(`${this.#baseUrl}${route}`, {
        method: options.method,
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
      });
    } catch (error) {
      // the request never landed. a transport failure is not a discord refusal,
      // so it is one of ours with one fixed message, and the reason keeps the
      // original error for the log.
      const reason = error instanceof Error ? error.message : String(error);
      throw new DiscordClientError(
        "SB_CLIENT_TRANSPORT",
        `the request to discord did not complete: ${reason}. check the network and try again.`,
      );
    }
  }

  async #parse<T>(response: Response, options: RequestOptions): Promise<T> {
    const text = await response.text();

    if (!response.ok) {
      const error = new DiscordApiError({
        status: response.status,
        route: options.route,
        method: options.method,
        body: text,
        retryAfterMs: retryAfterFromHeader(response.headers),
      });
      this.#logFailure(error);
      throw error;
    }

    if (text === "") return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return text as unknown as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      // a 200 with a body we cannot parse is worth knowing about, but it is not
      // an api error; hand the text back and let the caller decide.
      this.#log?.warn("discord returned 200 with an unparseable json body", {
        route: options.route,
        method: options.method,
        body: text.slice(0, 200),
      });
      return text as unknown as T;
    }
  }

  // the route and method go in every log line, so an unknown code is traceable
  // (AGENTS.md errors). values pass through redaction first.
  #logFailure(error: DiscordApiError): void {
    if (this.#log === undefined) return;
    const fields = redactValue(error.toWire()) as Record<string, unknown>;
    if (error.nonJson) {
      this.#log.warn("discord returned a non-json error body", fields);
      return;
    }
    this.#log.error("discord rejected the request", fields);
  }
}

function retryAfterFromHeader(headers: Headers): number | null {
  const value = Number(headers.get("retry-after"));
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

// a caller must not smuggle an absolute url past the base, and the path must be
// absolute within it. this is what keeps "everything through the client" true.
function assertRelativeRoute(route: string): string {
  if (/^https?:\/\//i.test(route) || route.startsWith("//")) {
    throw new DiscordClientError(
      "SB_CLIENT_BAD_ROUTE",
      `route must be a path under the api base, got ${JSON.stringify(route)}`,
    );
  }
  if (!route.startsWith("/")) {
    throw new DiscordClientError(
      "SB_CLIENT_BAD_ROUTE",
      `route must start with "/", got ${JSON.stringify(route)}`,
    );
  }
  if (hasControlOrSpace(route)) {
    throw new DiscordClientError(
      "SB_CLIENT_BAD_ROUTE",
      "route contains whitespace or a control character",
    );
  }
  return route;
}

// a raw space or control byte in a path is always a bug: a query value must be
// percent-encoded. checked by codepoint rather than a regex escape, because the
// linter rejects literal control characters in a pattern.
function hasControlOrSpace(route: string): boolean {
  for (const char of route) {
    if ((char.codePointAt(0) ?? 0) <= 0x20) return true;
  }
  return false;
}
