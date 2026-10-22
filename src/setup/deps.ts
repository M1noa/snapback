// everything a wizard step is allowed to touch, defined in one place so a step
// module is a pure renderer plus a validator, with no database, no network, and
// no discord import of its own (AGENTS.md: no long work in a handler, everything
// injected).
//
// this file is also the frozen customID vocabulary for the whole /setup surface
// (D4PLAN 9.3). a step may only emit ids that setupCustomId() below produces, so
// the boot assertion in boot.ts can prove every produced id has a handler.

import type { ContainerComponent, ModalComponent } from "oceanic.js";
import type { GuildSettings, VerifyPanelSettings, WizardState } from "../config/defaults.ts";
import type { JsonObject } from "../db/types.ts";
import { customID } from "../discord/components/row.ts";
import type { StateStore } from "../discord/interactions/state.ts";
import type { Logger } from "../lib/log.ts";

export const SETUP_SURFACE = "setup";

/** the object slot of every /setup customID. */
export const SETUP_OBJECT = {
  nav: "nav",
  step: "step",
  modal: "modal",
  admin: "admin",
  log: "log",
  app: "app",
  panel: "panel",
  policy: "policy",
  data: "data",
} as const;

/** the action slot, per object. kept as one table because the handler registry
 *  keys on (surface, action) and a stray verb is a boot failure, not a 404. */
export const SETUP_ACTION = {
  // navigation: the cursor carries the target step key
  jump: "jump",
  next: "next",
  prev: "prev",
  skip: "skip",
  finish: "finish",
  status: "status",
  // admins
  add: "add",
  remove: "remove",
  // logs
  testfire: "testfire",
  toggle: "toggle",
  // app check
  test: "test",
  probe: "probe",
  // verification panel
  preview: "preview",
  send: "send",
  discard: "discard",
} as const;

export interface SetupCustomIdInput {
  readonly guildId: string;
  readonly object: (typeof SETUP_OBJECT)[keyof typeof SETUP_OBJECT];
  /** a verb from SETUP_ACTION, or a step key for the step and modal objects. */
  readonly action: string;
  readonly cursor?: string;
}

/** the only builder for this surface. the cursor slot is always written. */
export function setupCustomId(input: SetupCustomIdInput): string {
  return customID({
    surface: SETUP_SURFACE,
    guild: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.cursor ?? "",
  });
}

// ---- the stores a step writes through -------------------------------------

export interface SaveInput {
  readonly guildId: string;
  readonly actorUserId: string;
  /** audit action, e.g. "setup.logs" (D4PLAN 16, destination 3). */
  readonly action: string;
  readonly patch: Partial<GuildSettings>;
  /** what the change was aimed at, for the audit row. */
  readonly target?: string | null;
  readonly detail?: JsonObject | null;
}

export interface SaveResult {
  readonly settings: GuildSettings;
  /** the fields the patch actually moved, so a page can say what changed. */
  readonly changed: readonly (keyof GuildSettings)[];
}

/** the one write path for guild settings: merge, clamp, validate, persist, and
 *  append an audit row (D4PLAN 16 destination 3, AGENTS.md "before you call it
 *  done"). nothing else writes settings_json. */
export interface SettingsStore {
  read(guildId: string): Promise<GuildSettings>;
  save(input: SaveInput): Promise<SaveResult>;
}

export interface AdminEntry {
  readonly userId: string;
  readonly addedBy: string | null;
  readonly addedAt: string | null;
  readonly flags: {
    readonly canBackup: boolean;
    readonly canRestore: boolean;
    readonly canManageAdmins: boolean;
    readonly canViewRecords: boolean;
    readonly canDeleteRecords: boolean;
  };
}

export interface AdminStore {
  list(guildId: string): Promise<readonly AdminEntry[]>;
  add(guildId: string, userId: string, actorUserId: string): Promise<void>;
  remove(guildId: string, userId: string): Promise<void>;
  /** flips one flag; the caller has already re-checked authorisation. */
  setFlag(
    guildId: string,
    userId: string,
    flag: keyof AdminEntry["flags"],
    value: boolean,
  ): Promise<void>;
}

/** reads a guide out of docs/ for /setup guide. null when it is missing, which
 *  the guide page renders as "not shipped in this build" rather than a crash. */
export type DocReader = (name: string) => Promise<string | null>;

// ---- the facts a step may display -----------------------------------------

export interface WebFacts {
  readonly publicBaseUrl: string;
  readonly port: number;
  readonly behindCloudflareTunnel: boolean;
  readonly trustedProxyDepth: number;
  /** the challenge the landing page shows before the flow starts. the keys stay
   *  in the environment: /setup reports what is in force, it never stores one. */
  readonly captcha: string;
  /** whether the local socket is accepting, probed live. */
  listening(): Promise<boolean>;
}

export interface PrivacyFacts {
  readonly ipStorage: string; // D4PLAN 14.5: hash | encrypted | plaintext
  readonly tokenStorage: boolean;
}

export interface ApplicationFacts {
  readonly id: string | null;
  readonly name: string | null;
  readonly botUserId: string | null;
  readonly ownerId: string;
  /** GET /applications/@me flags, in decimal. */
  readonly flags: number;
  /** the intents the gateway actually negotiated. */
  readonly intents: number;
}

/** one line of the /setup app self-test (D4PLAN 7.6). */
export interface SelfTestLine {
  readonly step: string;
  readonly passed: boolean;
  /** pass: what was checked. fail: discord's own words, never a paraphrase. */
  readonly said: string;
  readonly fix: string | null;
}

export interface AppFacts {
  readonly ownerId: string;
  readonly gatewayReady: boolean;
  readonly gatewayPingMs: number | null;
  /** true once the gateway negotiated GUILD_MEMBERS. */
  readonly memberIntent: boolean;
  readonly devGuildId: string | undefined;
  application(): Promise<ApplicationFacts>;
  /** the scripted 7.6 check. every line is a pass or a fix. */
  selfTest(): Promise<readonly SelfTestLine[]>;
}

/** one line of the D4PLAN 7.3 Developer Panel checklist, as the wizard shows it.
 *  `done` is null when the API cannot settle it and the operator has to look. */
export interface PortalItem {
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly done: boolean | null;
  readonly fix: string | null;
}

/** the Developer Panel checklist and the install link (D4PLAN 7.3). */
export interface Portal {
  items(): Promise<readonly PortalItem[]>;
  /** the permission bitfield the enabled features need, as a decimal string. */
  permissionBits(): string;
  /** the install url. scopes default to the panel's, so a caller rarely passes. */
  invite(scopes?: readonly string[]): string;
}

/** the thin network edge for branding. the bytes are validated and cropped
 *  before they reach this (D4PLAN 10.2). */
export interface ImageApplier {
  current(): Promise<{ displayName: string | null; avatarSet: boolean; bannerSet: boolean }>;
  setAvatar(dataUri: string): Promise<void>;
  setBanner(dataUri: string): Promise<void>;
  setDisplayName(name: string): Promise<void>;
}

/** reads an uploaded file's bytes. the value is the attachment's cdn url, which
 *  the transport resolves before a step ever sees it: an id alone cannot be
 *  fetched. the one fetch outside the rest client (AGENTS.md rule 6). */
export interface FileReader {
  read(url: string): Promise<{
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  }>;
}

/** the outcome of one test fire. `said` is discord's own words when the post
 *  failed, never a paraphrase (non-negotiable 5). */
export interface LogTestResult {
  readonly posted: boolean;
  readonly said: string;
  readonly fix: string | null;
}

export type LogTest = (guildId: string) => Promise<LogTestResult>;

export type PanelPoster = (panel: VerifyPanelSettings, channelId: string) => Promise<void>;

export interface SetupDeps {
  readonly log: Logger;
  /** epoch ms. injected so a page renders a stable timestamp in a test. */
  readonly now: () => number;
  readonly store: SettingsStore;
  readonly admins: AdminStore;
  readonly web: WebFacts;
  readonly privacy: PrivacyFacts;
  readonly app: AppFacts;
  readonly portal: Portal;
  readonly images: ImageApplier;
  readonly files: FileReader;
  readonly docs: DocReader;
  /** short-lived payloads too large for a customID (D4PLAN 9.3). a destructive
   *  confirmation keeps its one-time nonce and its target here. */
  readonly state: StateStore;
  /** posts one log-channel test event (D4PLAN 16 destination 1). the logging
   *  module owns the real fan-out; this is the whole edge the wizard needs. */
  readonly logs: LogTest;
  /** posts the verification panel into a channel (D4PLAN 10.3, 13.1). the verify
   *  surface owns the panel's lifecycle; the wizard only places the first one. */
  readonly postPanel: PanelPoster;
}

// ---- the step module contract ---------------------------------------------

export interface StepContext {
  readonly guildId: string;
  readonly userId: string;
  readonly settings: GuildSettings;
  readonly wizard: WizardState;
  readonly deps: SetupDeps;
}

/** what a step gets back from a submission. keys are the full customID strings
 *  the step produced with setupCustomId(), so a step reads values by building
 *  the same id rather than by inventing a key naming scheme. a text input, a
 *  radio group, and a file upload (the cdn url of its first attachment) contribute
 *  a string, a select and a checkbox group contribute a string array, and a bare
 *  checkbox contributes "true" or "false". a button contributes nothing. */
export type StepValues = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface StepModule {
  /** matches a key in WIZARD_STEPS, and is the customID action for this step. */
  readonly key: string;
  /** the step's page. the caller wraps it with the wizard chrome (step rail,
   *  previous/next/skip, and the way back). */
  render(ctx: StepContext): Promise<ContainerComponent> | ContainerComponent;
  /** validate and normalise submitted values into a settings patch. absent for a
   *  step with nothing to submit. throws SetupInputError on bad input. */
  apply?(
    ctx: StepContext,
    values: StepValues,
  ): Promise<Partial<GuildSettings>> | Partial<GuildSettings>;
  /** the modal this step's controls open, if any. */
  modal?(ctx: StepContext): { title: string; components: ModalComponent[] } | null;
}

/** a validation failure the user can act on. the message is ours, the detail is
 *  what they typed, and it never replaces a DiscordApiError. */
export class SetupInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "SetupInputError";
    this.field = field;
  }
}
