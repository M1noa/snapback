// discord interactions router (D4PLAN 9.3, AGENTS.md 7 and 8).
//
// custom ids look like sb:<surface>:<guild>:<object>:<action>:<cursor>. this
// file maps a valid id to one async handler, keyed by surface+action. it builds
// no components, touches no db, and speaks to no discord: it takes a custom id
// and an identity and returns an outcome. long work is enqueued, never run
// inline (rule 7), and the auth hook runs before the handler on every
// interaction (rule 8).

import type { ContainerComponent } from "oceanic.js";

export const CUSTOM_ID_PREFIX = "sb:";
export const MAX_CUSTOM_ID_LENGTH = 100;

// surface and action are lowercase identifiers (action may carry dashes: the
// shared list row's page-prev and page-next come from components/row.ts, whose
// token rule allows them). guild, object, and cursor are opaque slots: anything
// but a colon or a control char (the \x1f separator D4PLAN 9.3 bans; \p{Cc}
// covers it and every other control). cursor may be empty.
const CUSTOM_ID_RE =
  /^sb:(?<surface>[a-z][a-z0-9_]*):(?<guild>[^:\p{Cc}]+):(?<object>[^:\p{Cc}]+):(?<action>[a-z][a-z0-9_-]*):(?<cursor>[^:\p{Cc}]*)$/u;

export interface CustomId {
  readonly raw: string;
  readonly surface: string;
  readonly guild: string;
  readonly object: string;
  readonly action: string;
  readonly cursor: string;
}

// typed so a malformed id fails closed instead of crashing. CustomIdParseError
// is the only thing parseCustomId throws; route() catches it into an outcome.
export class CustomIdParseError extends Error {
  readonly id: string;
  readonly reason: string;

  constructor(id: string, reason: string) {
    super(`invalid custom id ${JSON.stringify(id)}: ${reason}`);
    this.name = "CustomIdParseError";
    this.id = id;
    this.reason = reason;
  }
}

/** the sb: guard. cheap check before the full parse. */
export function isSnapbackCustomId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

export function parseCustomId(raw: string): CustomId {
  if (!isSnapbackCustomId(raw)) throw new CustomIdParseError(raw, "missing sb: prefix");
  if (raw.length > MAX_CUSTOM_ID_LENGTH) {
    throw new CustomIdParseError(raw, `longer than ${MAX_CUSTOM_ID_LENGTH} chars`);
  }
  const groups = CUSTOM_ID_RE.exec(raw)?.groups;
  if (!groups) {
    throw new CustomIdParseError(raw, "expected sb:<surface>:<guild>:<object>:<action>:<cursor>");
  }
  return {
    raw,
    surface: groups.surface!,
    guild: groups.guild!,
    object: groups.object!,
    action: groups.action!,
    cursor: groups.cursor!,
  };
}

export type HandlerKey = string; // "<surface>:<action>"

export function handlerKey(surface: string, action: string): HandlerKey {
  return `${surface}:${action}`;
}

/** one (surface, action) pair the app can produce. the components manifest
 *  supplies these; the boot assertion checks each has a handler. */
export interface CustomIdSpec {
  readonly surface: string;
  readonly action: string;
}

export interface InteractionIdentity {
  readonly userId: string;
  readonly guildId: string;
  readonly isOwner: boolean;
}

export interface AuthInput {
  readonly id: CustomId;
  readonly identity: InteractionIdentity;
}

export interface DenialReason {
  readonly code: string; // SB_ prefixed, one fixed message (AGENTS.md Errors)
  readonly message: string;
  /** the one actionable next step, shown as the last line. */
  readonly fix?: string;
}

// allow or deny. a thrown hook is neither: route() reports it as auth_error, so
// a deny stays distinguishable from a failure.
export type AuthDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: DenialReason };

export type AuthHook = (input: AuthInput) => Promise<AuthDecision> | AuthDecision;

/** a unit of long work. the runner owns the row; this is the request only. */
export interface JobRequest {
  readonly kind: string; // backup | restore | pull | verify_refresh | export
  readonly guildId: string;
  readonly payload: Record<string, unknown>;
}

/** hand work to the runner. never awaited here (non-negotiable 7). */
export type EnqueueJob = (job: JobRequest) => void;

export interface HandlerContext {
  readonly id: CustomId;
  readonly identity: InteractionIdentity;
  readonly enqueue: EnqueueJob;
  /** how the handler answers. the transport supplies it per interaction. */
  readonly surface: HandlerSurface;
}

export type HandlerResult =
  | { readonly kind: "reply" } // handler answered the interaction itself
  | { readonly kind: "deferred"; readonly jobId?: string } // acked, work queued
  | { readonly kind: "noop" };

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult> | HandlerResult;

// what a handler may answer with, in the router's own vocabulary so this file
// does not import the payload builders (dispatch.ts imports this one). a handler
// that answers returns { kind: "reply" } once the surface call has resolved.
export interface ReplyRequest {
  readonly message: ContainerComponent;
  /** edit the message the control sits on instead of posting a new one. */
  readonly update?: boolean;
  /** a private message. a follow-up is used when the interaction is answered. */
  readonly ephemeral?: boolean;
}

// one submitted control's value. a text input and a select option are strings, a
// select and a checkbox group are string arrays, and a file upload contributes
// the id of its first attachment. a bare checkbox arrives as a boolean from
// discord, and the transport normalises it to "true"/"false" before it gets here.
export type SubmittedValue = string | readonly string[] | undefined;

export interface ModalRequest {
  readonly customID: string;
  readonly title: string;
  readonly components: readonly unknown[];
}

export interface HandlerSurface {
  /** answer the interaction. */
  reply(request: ReplyRequest): Promise<void>;
  /** answer with a modal. an interaction can only be answered once. */
  openModal(modal: ModalRequest): Promise<void>;
  /** every control the user submitted. a button submits nothing, so it is empty. */
  readonly values: Readonly<Record<string, SubmittedValue>>;
  /** which interaction this is: a click on a message control, or the submission
   *  of a modal. a step's "edit" button and the modal it opens carry the same
   *  customID, so this is the one honest way to tell them apart. */
  readonly source: "component" | "modal";
}

const NO_SURFACE: HandlerSurface = {
  reply: async () => {
    // a handler that answers through route() without a surface wired is a
    // programming error, but throwing here would look like a handler failure.
    throw new Error("router has no interaction surface; pass one to route()");
  },
  openModal: async () => {
    throw new Error("router has no interaction surface; pass one to route()");
  },
  values: {},
  source: "component",
};

// the error branches carry the Error itself, not just its message: the handler
// wrapper logs the stack, and a message alone throws that away. message stays
// for the caller that only wants a string.
export type RouteOutcome =
  | { readonly kind: "handled"; readonly result: HandlerResult }
  | { readonly kind: "denied"; readonly reason: DenialReason }
  | { readonly kind: "unregistered"; readonly surface: string; readonly action: string }
  | { readonly kind: "invalid_id"; readonly error: CustomIdParseError }
  | { readonly kind: "auth_error"; readonly message: string; readonly error: unknown }
  | { readonly kind: "handler_error"; readonly message: string; readonly error: unknown };

export class DuplicateHandlerError extends Error {
  readonly key: HandlerKey;
  constructor(key: HandlerKey) {
    super(`a handler is already registered for ${key}`);
    this.name = "DuplicateHandlerError";
    this.key = key;
  }
}

// thrown at boot when a produced id has no handler. missing holds the whole
// list, so the report names every gap at once, not just the first.
export class UnhandledCustomIdsError extends Error {
  readonly missing: readonly CustomIdSpec[];
  constructor(missing: readonly CustomIdSpec[]) {
    const list = missing.map((spec) => handlerKey(spec.surface, spec.action)).join(", ");
    super(`no handler registered for ${missing.length} custom id(s): ${list}`);
    this.name = "UnhandledCustomIdsError";
    this.missing = missing;
  }
}

const NO_ENQUEUE: EnqueueJob = () => {
  throw new Error("router has no enqueue configured; pass enqueue in RouterOptions");
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RouterOptions {
  /** runs before every handler, on every interaction (rule 8). */
  readonly authorize: AuthHook;
  /** supplied once per process. defaults to one that throws, so a missing
   *  wiring is loud rather than a silent dropped job. */
  readonly enqueue?: EnqueueJob;
}

export class Router {
  readonly #handlers = new Map<HandlerKey, Handler>();
  readonly #authorize: AuthHook;
  readonly #enqueue: EnqueueJob;

  constructor(options: RouterOptions) {
    this.#authorize = options.authorize;
    this.#enqueue = options.enqueue ?? NO_ENQUEUE;
  }

  /** one handler per surface+action. a duplicate is a boot-time programming error. */
  register(surface: string, action: string, handler: Handler): this {
    const key = handlerKey(surface, action);
    if (this.#handlers.has(key)) throw new DuplicateHandlerError(key);
    this.#handlers.set(key, handler);
    return this;
  }

  has(surface: string, action: string): boolean {
    return this.#handlers.has(handlerKey(surface, action));
  }

  /** every registered key, sorted, for the boot report. */
  registeredKeys(): HandlerKey[] {
    return [...this.#handlers.keys()].sort();
  }

  /** the produced ids with no handler, deduped, in first-seen order. */
  missing(specs: readonly CustomIdSpec[]): CustomIdSpec[] {
    const seen = new Set<HandlerKey>();
    const gaps: CustomIdSpec[] = [];
    for (const spec of specs) {
      const key = handlerKey(spec.surface, spec.action);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!this.#handlers.has(key)) gaps.push({ surface: spec.surface, action: spec.action });
    }
    return gaps;
  }

  /** boot assertion: every produced id must have a handler, or it throws with
   *  the full list. run it after registration, before the client connects. */
  assertComplete(specs: readonly CustomIdSpec[]): void {
    const gaps = this.missing(specs);
    if (gaps.length > 0) throw new UnhandledCustomIdsError(gaps);
  }

  /** total: every failure path is an outcome, never a throw. the surface is how
   *  a handler answers, so a caller that only wants the decision may omit it. */
  async route(
    rawId: string,
    identity: InteractionIdentity,
    surface: HandlerSurface = NO_SURFACE,
  ): Promise<RouteOutcome> {
    let id: CustomId;
    try {
      id = parseCustomId(rawId);
    } catch (error) {
      if (error instanceof CustomIdParseError) return { kind: "invalid_id", error };
      throw error; // not ours; let the caller's wrapper see it
    }

    const handler = this.#handlers.get(handlerKey(id.surface, id.action));
    if (!handler) return { kind: "unregistered", surface: id.surface, action: id.action };

    let decision: AuthDecision;
    try {
      decision = await this.#authorize({ id, identity });
    } catch (error) {
      return { kind: "auth_error", message: messageOf(error), error };
    }
    if (decision.kind === "deny") return { kind: "denied", reason: decision.reason };

    try {
      const result = await handler({ id, identity, enqueue: this.#enqueue, surface });
      return { kind: "handled", result };
    } catch (error) {
      return { kind: "handler_error", message: messageOf(error), error };
    }
  }
}
