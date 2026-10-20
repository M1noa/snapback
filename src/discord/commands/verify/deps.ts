// what the /verify surface needs, and the one builder for its custom ids.

import type { GuildSettings } from "../../../config/defaults.ts";
import type { Database, VerifyPanelRow, VerifyRecordRow } from "../../../db/types.ts";
import type { CustomIdSpec } from "../../../discord/interactions/router.ts";
import type { StateStore } from "../../../discord/interactions/state.ts";
import type { Logger } from "../../../lib/log.ts";
import type { JobRunner } from "../../../services/jobs/runner.ts";
import { customID } from "../../components/row.ts";

export const VERIFY_SURFACE = "verify";

/** the object slot, one per surface a control lives on. */
export const VERIFY_OBJECT = {
  panel: "panel",
  records: "records",
  record: "record",
  job: "job",
} as const;

/** the action slot, per object. */
export const VERIFY_ACTION = {
  open: "open",
  select: "select",
  submit: "submit",
  details: "details",
  delete: "delete",
  confirm: "confirm",
  refresh: "refresh",
  revoke: "revoke",
} as const;

export interface VerifyCustomIdInput {
  readonly guildId: string;
  readonly object: (typeof VERIFY_OBJECT)[keyof typeof VERIFY_OBJECT];
  readonly action: string;
  readonly cursor?: string;
}

export function verifyCustomId(input: VerifyCustomIdInput): string {
  return customID({
    surface: VERIFY_SURFACE,
    guild: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.cursor ?? "",
  });
}

export interface VerifyDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly jobs: JobRunner;
  readonly now: () => number;
  readonly settings: (guildId: string) => Promise<GuildSettings>;
  /** the confirm nonce and the selection payload. */
  readonly state: StateStore;
  /** the records of this guild. */
  readonly records: (guildId: string, limit: number) => Promise<VerifyRecordRow[]>;
  readonly record: (guildId: string, userId: string) => Promise<VerifyRecordRow | null>;
  /** the panel for this guild, if it has one. */
  readonly panel: (guildId: string) => Promise<VerifyPanelRow | null>;
  /** create or edit the panel and post it. */
  readonly savePanel: (input: {
    guildId: string;
    channelId: string;
    title: string;
    description: string;
    scopes: readonly string[];
    buttonLabel: string;
    /** the accent, as a hex number. */
    color: string;
    thumbnailUrl: string | null;
  }) => Promise<VerifyPanelRow>;
  /** delete one record, and how much of it. */
  readonly deleteRecord: (input: {
    guildId: string;
    userId: string;
    scope: "record" | "ip" | "token" | "all";
  }) => Promise<{ deleted: boolean; what: string }>;
  /**
   * the url that starts the flow for a panel, or null when the oauth is off.
   * the panel's own button carries the panel id, so the handler can find the
   * panel and ask for its url.
   */
  readonly authorizeUrl: (guildId: string, panelId: string) => Promise<string | null>;
  /** the refresh sweep, over the records that are due. */
  readonly refresh: (
    guildId: string,
  ) => Promise<{ checked: number; refreshed: number; failed: number }>;
  /** the instance owner, or null. only the owner may erase captured data. */
  readonly ownerId: string;
  /** re-checked on every interaction (AGENTS.md rule 8). */
  readonly authorize: (userId: string, guildId: string) => Promise<boolean>;
  readonly audit: (input: {
    guildId: string;
    actorUserId: string;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
}

export const VERIFY_SPECS: readonly CustomIdSpec[] = [
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.open },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.select },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.submit },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.details },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.delete },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.confirm },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.refresh },
  { surface: VERIFY_SURFACE, action: VERIFY_ACTION.revoke },
];
