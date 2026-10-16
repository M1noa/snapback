// discord/errors.ts (AGENTS.md errors, D4PLAN 18.1).
//
// the rule this file exists to enforce: we never invent an error message. the
// wire body is parsed, and discord's own code and message are carried through
// verbatim. the table below adds a "what to do" sentence for codes we have seen;
// it never rewrites what discord said, and a code with no entry is reported raw.
//
// camelCase is the typescript-side name (AGENTS.md code). retry_after on the
// wire is retryAfterMs here, because the wire form is seconds and a float.

export interface DiscordFieldError {
  /** dotted path into the request body, e.g. "embeds.0.title". "_" for a body-level error. */
  readonly path: string;
  readonly code: string | null;
  readonly message: string;
}

export interface DiscordApiErrorInit {
  readonly status: number;
  readonly route: string;
  readonly method: string;
  /** the raw response body text, unmodified. */
  readonly body: string;
  /** from the retry-after header, already in milliseconds. */
  readonly retryAfterMs?: number | null;
}

// the subset of a discord error body we read. everything else stays in `body`.
interface DiscordErrorBody {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
  retry_after?: unknown;
}

function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length} bytes)`;
}

// "50035: Invalid Form Body" is the shape that actually needs debugging, so the
// nested {field: {_errors: [...]}} tree is flattened into dotted paths.
function flattenFieldErrors(errors: unknown, prefix = ""): DiscordFieldError[] {
  if (typeof errors !== "object" || errors === null) return [];
  const node = errors as Record<string, unknown>;
  const out: DiscordFieldError[] = [];

  const direct = node._errors;
  if (Array.isArray(direct)) {
    for (const entry of direct) {
      const record = (entry ?? {}) as Record<string, unknown>;
      out.push({
        path: prefix === "" ? "_" : prefix,
        code: typeof record.code === "string" ? record.code : null,
        message: typeof record.message === "string" ? record.message : String(record.message ?? ""),
      });
    }
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === "_errors") continue;
    out.push(...flattenFieldErrors(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return out;
}

/**
 * anything discord returns non-2xx. status, code, message, errors, retry_after,
 * route, method and the raw body are all preserved; the body is never discarded,
 * because an unknown code is only traceable with it.
 */
export class DiscordApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly errors: readonly DiscordFieldError[];
  readonly retryAfterMs: number | null;
  readonly route: string;
  readonly method: string;
  readonly body: string;
  /** true when the body was not json, which itself means the request never reached discord. */
  readonly nonJson: boolean;

  constructor(init: DiscordApiErrorInit) {
    const parsed = parseBody(init.body);
    // .message is discord's own words, verbatim (rule 5). when there are none we
    // say only what we know, and we do not dress it up as a discord message.
    super(parsed.message ?? `${init.status} with no message from discord`);
    this.name = "DiscordApiError";
    this.status = init.status;
    this.code = parsed.code;
    this.errors = parsed.errors;
    this.retryAfterMs = init.retryAfterMs ?? parsed.retryAfterMs;
    this.route = init.route;
    this.method = init.method;
    this.body = init.body;
    this.nonJson = parsed.nonJson;
  }

  /** the wire-shaped object, for a log line or a bug report. */
  toWire(): Record<string, unknown> {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      errors: this.errors,
      retry_after: this.retryAfterMs === null ? null : this.retryAfterMs / 1000,
      route: this.route,
      method: this.method,
      body: this.body,
    };
  }
}

interface ParsedBody {
  code: number | null;
  message: string | null;
  errors: readonly DiscordFieldError[];
  retryAfterMs: number | null;
  nonJson: boolean;
}

function parseBody(body: string): ParsedBody {
  const empty: ParsedBody = {
    code: null,
    message: null,
    errors: [],
    retryAfterMs: null,
    nonJson: false,
  };
  if (body.trim() === "") return empty;

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    // html from a proxy, a truncated body, an empty 502 page. keep the text and
    // label it, because "non-JSON" is the signal that discord never answered.
    return { ...empty, message: `non-JSON response: ${truncate(body, 500)}`, nonJson: true };
  }
  if (typeof raw !== "object" || raw === null) return empty;

  const record = raw as DiscordErrorBody;
  const retry = typeof record.retry_after === "number" ? record.retry_after * 1000 : null;
  return {
    code: typeof record.code === "number" ? record.code : null,
    message: typeof record.message === "string" ? record.message : null,
    errors: flattenFieldErrors(record.errors),
    retryAfterMs: retry,
    nonJson: false,
  };
}

// what to do, per code we have seen. this ADDS to discord's message and never
// replaces it. a code absent here is correct: we have nothing truthful to add.
const CODE_FIXES: Readonly<Record<number, string>> = {
  10003: "the channel was deleted or the id is wrong. re-list channels with /snapback status.",
  10004: "the bot is not in that guild, or the guild was deleted.",
  10008: "that message no longer exists. re-run the capture to pick up deletions.",
  10011: "the role was deleted. re-run /backup create to refresh the stored roles.",
  10013: "the user is not reachable by this application.",
  10026: "the interaction token expired (15 minutes). run the command again.",
  20012: "the guild requires 2FA for this action. enable it on your account first.",
  30005: "the bot is in the maximum number of guilds. leave one before adding another.",
  30007: "the guild has hit discord's webhook ceiling. delete unused webhooks and retry.",
  30013: "the guild has hit the channel limit. delete channels before restoring more.",
  40001: "the token is wrong or was reset. put the current bot token in .env.",
  40002: "the account needs verification before it can do this.",
  40003: "the bot must be a member of the guild to do this. invite it.",
  40004: "the access token expired. the oauth flow needs to run again.",
  40007: "the oauth2 access token is invalid or expired.",
  40013: "the application id in the request is wrong.",
  40014: "the oauth2 scope requested is not one this application has.",
  40101: "the bot is missing a scope or permission for this route.",
  50001: "the bot cannot see that resource. check the channel permissions.",
  50007: "that user has DMs closed or shares no guild with the bot.",
  50013: "the bot lacks the permission for this action. grant it and retry.",
  50027: "the webhook token is wrong. delete the webhook and restore again.",
  50035: "discord rejected fields in the request body. the paths below are the ones it named.",
  50041: "the uploaded file was rejected, usually over the size ceiling for the target.",
  50109: "the request body was not valid json. this is a bug in the caller.",
  40062: "too many requests. this should have been caught by the limiter.",
  160002: "the channel is rate limited for writes. slow the capture down.",
  160004: "this thread is rate limited for writes. slow the capture down.",
};

export interface ErrorReport {
  /** what happened. */
  readonly headline: string;
  /** discord's own code and message, verbatim. */
  readonly said: string;
  readonly code: number | null;
  /** what to do. null when we have nothing truthful to add. */
  readonly fix: string | null;
  readonly fields: readonly DiscordFieldError[];
  readonly status: number;
  readonly nonJson: boolean;
}

/** the three-line error surface: what happened, what discord said, what to do. */
export function formatDiscordError(error: DiscordApiError): ErrorReport {
  const said = error.code === null ? error.message : `${error.code} ${error.message}`;

  return {
    headline: `discord rejected ${error.method} ${error.route} with ${error.status}`,
    said,
    code: error.code,
    fix: error.code === null ? null : (CODE_FIXES[error.code] ?? null),
    fields: error.errors,
    status: error.status,
    nonJson: error.nonJson,
  };
}
