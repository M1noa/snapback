// the restore contract (D4PLAN 12). one module per phase, one context, and a
// report per phase.
//
// a phase never throws for something discord refused: it records the refusal and
// returns, so the phases after it still run. a phase that failed a dependency
// returns `skipped`, and the phase after it says so rather than pretending.
//
// the maps are how a source id becomes a target id. every id crosses as a string,
// and a role is matched by name with the id as a tiebreak (12.4).

import type { Database } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import type { Logger } from "../../lib/log.ts";

/** the phases, in the order they run. the order is not negotiable (12.2). */
export const RESTORE_PHASES = [
  "guild",
  "emojis",
  "roles",
  "categories",
  "channels",
  "overwrites",
  "threads",
  "onboarding",
  "automod",
  "events",
  "members",
  "bans",
  "messages",
  "finish",
] as const;

export type RestorePhaseName = (typeof RESTORE_PHASES)[number];

/** what the operator chose. the defaults are the safe ones (12.5). */
export interface RestoreOptions {
  readonly guild: boolean;
  readonly emojis: boolean;
  readonly stickers: boolean;
  readonly sounds: boolean;
  readonly roles: boolean;
  readonly channels: boolean;
  readonly overwrites: boolean;
  readonly threads: boolean;
  readonly onboarding: boolean;
  readonly automod: boolean;
  readonly events: boolean;
  readonly members: boolean;
  /** 1 roles only, 2 roles and nickname, 3 sync. three is dangerous and off. */
  readonly memberMode: 1 | 2 | 3;
  readonly messages: boolean;
  readonly bans: boolean;
  /** the per-channel message ceiling for this restore. */
  readonly messageLimit: number;
  /** append the original timestamp to each replayed message. */
  readonly timestampSuffix: boolean;
  /** reuse a target role with the same name instead of creating a second one. */
  readonly reuseRoles: boolean;
  /** delete the target's roles the backup does not know about. */
  readonly deleteExtraRoles: boolean;
  /** delete the target's channels and roles first (12.7). */
  readonly clearBefore: boolean;
}

export const DEFAULT_RESTORE_OPTIONS: RestoreOptions = {
  guild: true,
  emojis: true,
  stickers: true,
  sounds: true,
  roles: true,
  channels: true,
  overwrites: true,
  threads: true,
  onboarding: true,
  automod: true,
  events: true,
  members: true,
  memberMode: 1,
  messages: true,
  bans: true,
  messageLimit: 1000,
  timestampSuffix: false,
  reuseRoles: true,
  deleteExtraRoles: false,
  clearBefore: false,
};

/** source id to target id, for the three things a restore has to look up again. */
export interface RestoreMaps {
  /** source role id -> target role id. */
  readonly roles: Map<string, string>;
  /** source channel id -> target channel id. */
  readonly channels: Map<string, string>;
  /** source user id -> target user id. ids are global, so this one is exact. */
  readonly members: Map<string, string>;
  /** source emoji id -> target emoji id, for automod actions. */
  readonly emojis: Map<string, string>;
}

export function createRestoreMaps(): RestoreMaps {
  return {
    roles: new Map(),
    channels: new Map(),
    members: new Map(),
    emojis: new Map(),
  };
}

/** one thing a phase could not do, in the operator's words. */
export interface RestoreNote {
  /** what it was, named so a person can act on it. */
  readonly what: string;
  /** why, in discord's words when discord is the one that said no. */
  readonly why: string;
}

export type PhaseOutcome = "ok" | "warn" | "fail" | "skipped";

export interface PhaseResult {
  readonly outcome: PhaseOutcome;
  /** rows or items this phase created, edited or posted. */
  readonly count: number;
  readonly notes: readonly RestoreNote[];
  /** true when the phase could not do its work at all, so the next phase that
   *  depends on it is skipped rather than run against a half-built guild. */
  readonly failed: boolean;
}

export function phaseOk(count: number, notes: readonly RestoreNote[] = []): PhaseResult {
  return { outcome: notes.length === 0 ? "ok" : "warn", count, notes, failed: false };
}

export function phaseSkipped(reason: string): PhaseResult {
  return {
    outcome: "skipped",
    count: 0,
    notes: [{ what: "the phase", why: reason }],
    failed: false,
  };
}

export function phaseFailed(reason: string, notes: readonly RestoreNote[] = []): PhaseResult {
  return {
    outcome: "fail",
    count: 0,
    notes: [{ what: "the phase", why: reason }, ...notes],
    failed: true,
  };
}

export interface RestoreContext {
  readonly db: Database;
  /** every discord call goes through this (AGENTS.md rule 6). */
  readonly client: DiscordClient;
  readonly log: Logger;
  readonly backupId: string;
  readonly targetGuildId: string;
  readonly options: RestoreOptions;
  readonly maps: RestoreMaps;
  /** the source guild the backup came from, for the report's wording. */
  readonly sourceGuildId: string;
  /** where the backup's asset files live, for the re-upload. */
  readonly backupDir: string;
  /** cooperative cancellation, polled at each phase's checkpoints. */
  readonly signal: { cancelled: boolean; paused: boolean };
  /** persisted to job_progress, so a restart resumes at this phase. */
  readonly checkpoint: (
    phase: RestorePhaseName,
    done: number,
    total: number | null,
  ) => Promise<void>;
  /** a note about something that could not be done. */
  readonly note: (what: string, why: string) => void;
  /** iso timestamp, injectable so a report is not clock-dependent. */
  readonly now: () => string;
}

/** one phase. a phase never throws: it reports what happened. */
export type RestorePhase = (ctx: RestoreContext) => Promise<PhaseResult>;
