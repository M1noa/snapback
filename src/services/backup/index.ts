// the capture pipeline (D4PLAN 11). one job per backup, steps in a fixed order
// with a checkpoint each, then a self-check and a seal.
//
// order is not cosmetic. channels before messages (a message needs its channel),
// roles before members (a member needs its role names), members before messages
// (a message author's nickname comes from the member list). welcome screen and
// the guild's own assets ride the guild step, because neither depends on another
// step having run.

import { join } from "node:path";
import type { GuildSettings } from "../../config/defaults.ts";
import { insertBackup } from "../../db/queries/backups.ts";
import type { BackupKind, BackupRow, Database } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import type { Logger } from "../../lib/log.ts";
import { captureEmojis, captureSounds, captureStickers, createAssetStore } from "./assets.ts";
import { captureAutomod } from "./automod.ts";
import { captureChannels, captureThreads } from "./channels.ts";
import { captureEvents } from "./events.ts";
import { captureGuild } from "./guild.ts";
import { captureBans, captureMembers } from "./members.ts";
import { captureMessages } from "./messages.ts";
import { captureOnboarding } from "./onboarding.ts";
import { captureRoles } from "./roles.ts";
import { countRows, type SelfCheckResult, type StoredCounts, sealBackup } from "./selfcheck.ts";
import {
  type AssetStore,
  BACKUP_SCHEMA_VERSION,
  type BackupContext,
  type BackupLimits,
  type Capture,
  type CaptureCounts,
  type CountedCategory,
  createSkipList,
} from "./types.ts";

export interface BackupRunOptions {
  readonly guildId: string;
  readonly kind: BackupKind;
  readonly createdBy: string;
  readonly label: string | null;
  readonly settings: GuildSettings;
  readonly limits: BackupLimits;
  /** where backups/<id>/assets/ lives. */
  readonly backupDir: string;
  readonly maxAssetBytes: number;
}

export interface BackupRunDeps {
  readonly db: Database;
  readonly client: DiscordClient;
  readonly log: Logger;
  readonly now?: () => string;
  /** the job runner stores this; without one a resumable backup cannot resume. */
  readonly checkpoint?: (step: string, counts: CaptureCounts) => Promise<void>;
  /**
   * the asset store for one backup. injectable so a test runs the whole pipeline
   * without a disk or a network, and so a deployment can swap the fetch.
   */
  readonly assets?: (backupId: string) => AssetStore;
}

export interface BackupRunResult {
  readonly backup: BackupRow;
  readonly check: SelfCheckResult;
  readonly counts: StoredCounts;
}

// one entry per D4PLAN 11 step, in the plan's order. `counts` names the one
// category whose written total the self-check compares against the stored rows;
// steps that write no counted table leave it null.
const STEPS: readonly { step: string; capture: Capture; counts: CountedCategory | null }[] = [
  { step: "guild", capture: captureGuild, counts: null },
  { step: "roles", capture: captureRoles, counts: "roles" },
  { step: "emojis", capture: captureEmojis, counts: null },
  { step: "stickers", capture: captureStickers, counts: null },
  { step: "sounds", capture: captureSounds, counts: null },
  { step: "channels", capture: captureChannels, counts: "channels" },
  { step: "threads", capture: captureThreads, counts: null },
  { step: "onboarding", capture: captureOnboarding, counts: null },
  { step: "automod", capture: captureAutomod, counts: null },
  { step: "events", capture: captureEvents, counts: null },
  { step: "bans", capture: captureBans, counts: null },
  { step: "members", capture: captureMembers, counts: "members" },
  { step: "messages", capture: captureMessages, counts: "messages" },
];

export async function runBackup(
  deps: BackupRunDeps,
  options: BackupRunOptions,
): Promise<BackupRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const backupId = Bun.randomUUIDv7();
  const startedAt = now();

  // the row exists before the first request, so a crash leaves an open backup
  // rather than an invisible half-capture. listOpenBackups is how it is found.
  const skeleton: BackupRow = {
    backup_id: backupId,
    guild_id: options.guildId,
    label: options.label,
    kind: options.kind,
    guild_name: null,
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: null,
    member_count: 0,
    message_count: 0,
    channel_count: 0,
    role_count: 0,
    size_bytes: 0,
    schema_version: BACKUP_SCHEMA_VERSION,
    guild_settings_json: null,
    onboarding_json: null,
    welcome_screen_json: null,
    widget_json: null,
    afk_json: null,
    self_check_json: null,
    created_at: startedAt,
    created_by: options.createdBy,
  };
  await insertBackup(deps.db, skeleton);

  const skips = createSkipList();
  const failures: string[] = [];
  // mutable here, frozen into the seal: the steps fill it as they report.
  const recorded: { roles: number; channels: number; members: number; messages: number } = {
    roles: 0,
    channels: 0,
    members: 0,
    messages: 0,
  };
  const dir = join(options.backupDir, backupId);

  const ctx: BackupContext = {
    db: deps.db,
    client: deps.client,
    log: deps.log,
    backupId,
    guildId: options.guildId,
    settings: options.settings,
    limits: options.limits,
    assets:
      deps.assets?.(backupId) ??
      createAssetStore({ dir, maxBytes: options.maxAssetBytes, log: deps.log }),
    skips,
    checkpoint: async (step, counts) => {
      await deps.checkpoint?.(step, counts);
    },
    now,
  };

  for (const { step, capture, counts } of STEPS) {
    try {
      const result = await capture(ctx);
      if (counts !== null) recorded[counts] = result.counts?.[counts] ?? result.written;
      await deps.checkpoint?.(step, { done: 1, total: 1 });
    } catch (error) {
      // one broken step does not throw away the work of the others, but it does
      // make the backup incomplete: the seal carries the failure into the
      // self-check, so a partial backup can never read as complete.
      const why = error instanceof Error ? error.message : String(error);
      failures.push(`step ${step} failed: ${why}`);
      ctx.skips.add({ category: step, what: `the ${step} step`, why });
      deps.log.error("backup step failed", {
        backupId,
        guildId: options.guildId,
        step,
        error: why,
      });
    }
  }

  const { backup, check } = await sealBackup({
    db: deps.db,
    backupId,
    recorded,
    skips: skips.all(),
    assetDir: dir,
    extraFailures: failures,
  });

  return { backup, check, counts: await countRows(deps.db, backupId) };
}
