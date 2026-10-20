// the sweeps that are not due work (D4PLAN 17.1). the counter reset and the
// orphan webhook sweep.
//
// a sweep is idempotent: running it twice leaves the same state, so a restart in
// the middle of one costs nothing. the counter reset clears the rows of the days
// that are over, and the webhook sweep deletes the webhooks a crashed restore
// left behind.

import { listBackupChannelsByBackup } from "../../db/queries/backup-channels.ts";
import { listJobsByKindAndStatus } from "../../db/queries/jobs.ts";
import { type SqlValue, toNumber } from "../../db/rows.ts";
import type { Database, JobRow } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";

/** the name every webhook snapback creates. only these are ours to delete. */
export const WEBHOOK_NAME = "Snapback";

/** how often the orphan webhook sweep runs. */
export const WEBHOOK_SWEEP_INTERVAL_MS = 6 * 3_600_000;

/** the counters are per utc day, so the day rolls over at midnight utc. the
 *  reset waits five minutes past it, so a write that lands late still lands on
 *  the day it belongs to. */
const RESET_HOUR_UTC = 0;
const RESET_MINUTE_UTC = 5;

/** the utc day of a moment, the way the counter rows write it. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** the moment today's counter reset is due: five minutes past midnight utc. */
export function counterResetAt(now: number): number {
  const at = new Date(now);
  return Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    RESET_HOUR_UTC,
    RESET_MINUTE_UTC,
  );
}

/**
 * the counters of the days that are over. a row for today is a live counter and
 * stays; a row for yesterday is history and goes. the count is read first, so
 * the sweep can report what it did.
 */
export async function resetOldCounters(db: Database, now: number): Promise<number> {
  const today = utcDay(now);
  const rows = await db.query<Record<string, SqlValue>>(
    "SELECT COUNT(*) AS n FROM account_counters WHERE day < ?",
    [today],
  );
  const count = toNumber(rows[0]?.n ?? null) ?? 0;
  await db.run("DELETE FROM account_counters WHERE day < ?", [today]);
  return count;
}

// ---- the orphan webhook sweep ----

/** one webhook of a guild, the way discord lists them. */
export interface GuildWebhook {
  readonly id: string;
  readonly name: string | null;
  readonly channel_id: string | null;
}

/** one channel of a guild, the way discord lists them. */
export interface GuildChannel {
  readonly id: string;
  readonly name: string | null;
}

/** the discord side of the sweep. the client is the only thing that talks to
 *  discord, so this is a port and not a call (AGENTS.md rule 6). */
export interface WebhookPort {
  /** the webhooks of one guild. */
  readonly list: (guildId: string) => Promise<readonly GuildWebhook[]>;
  /** the channels of one guild. */
  readonly channels: (guildId: string) => Promise<readonly GuildChannel[]>;
  /** deletes one webhook. */
  readonly remove: (webhookId: string) => Promise<void>;
}

export interface OrphanSweepResult {
  /** the webhooks that were deleted. */
  readonly deleted: number;
  /** the webhooks that were left alone. */
  readonly left: number;
  /** the ones that could not be dealt with. */
  readonly failed: number;
}

export interface OrphanSweepDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly port: WebhookPort;
  /** the guilds to sweep. */
  readonly guildIds: readonly string[];
}

/**
 * the webhooks snapback created and no job is using. a restore creates one
 * webhook per channel and deletes it when the channel is done, so a webhook
 * that is still there belongs to a restore that crashed.
 */
export async function sweepOrphanWebhooks(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const busy = await busyChannels(deps);
  let deleted = 0;
  let left = 0;
  let failed = 0;

  for (const guildId of deps.guildIds) {
    let webhooks: readonly GuildWebhook[];
    try {
      webhooks = await deps.port.list(guildId);
    } catch (error) {
      failed += 1;
      deps.log.warn("the guild's webhooks could not be listed", {
        guildId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const webhook of webhooks) {
      // only ours. a webhook somebody else made is not ours to delete.
      if (webhook.name !== WEBHOOK_NAME) {
        left += 1;
        continue;
      }
      // a restore that is running right now is using it.
      if (
        busy.unknown.has(guildId) ||
        (webhook.channel_id !== null && busy.channels.has(webhook.channel_id))
      ) {
        left += 1;
        continue;
      }
      try {
        await deps.port.remove(webhook.id);
        deleted += 1;
      } catch (error) {
        failed += 1;
        deps.log.warn("an orphan webhook could not be deleted", {
          webhookId: webhook.id,
          guildId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { deleted, left, failed };
}

/** the channels a running restore job is posting into, and the guilds whose
 *  set could not be worked out. nothing in an unknown guild is deleted. */
interface BusyChannels {
  readonly channels: Set<string>;
  readonly unknown: Set<string>;
}

async function busyChannels(deps: OrphanSweepDeps): Promise<BusyChannels> {
  const channels = new Set<string>();
  const unknown = new Set<string>();
  const jobs = await listJobsByKindAndStatus(deps.db, "restore", "running");

  for (const job of jobs) {
    const targetId = targetGuildOf(job);
    const backupId = backupIdOf(job);
    if (targetId === null) {
      unknown.add(job.guild_id);
      continue;
    }
    if (backupId === null) {
      // a restore with no backup is clearing the target, so the target is in use.
      unknown.add(targetId);
      continue;
    }
    const names = await sourceChannelNames(deps.db, backupId);
    if (names.size === 0) {
      unknown.add(targetId);
      continue;
    }
    let targetChannels: readonly GuildChannel[];
    try {
      targetChannels = await deps.port.channels(targetId);
    } catch (error) {
      deps.log.warn("the target guild's channels could not be listed", {
        guildId: targetId,
        message: error instanceof Error ? error.message : String(error),
      });
      unknown.add(targetId);
      continue;
    }
    for (const channel of targetChannels) {
      if (channel.name !== null && names.has(channelKey(channel.name))) {
        channels.add(channel.id);
      }
    }
  }

  return { channels, unknown };
}

/** the guild a restore job writes into. */
function targetGuildOf(job: JobRow): string | null {
  const payload = job.payload_json ?? {};
  const target = payload.targetId;
  if (typeof target === "string" && target !== "") return target;
  return job.guild_id === "" ? null : job.guild_id;
}

/** the backup a restore job reads. */
function backupIdOf(job: JobRow): string | null {
  const payload = job.payload_json ?? {};
  const backupId = payload.backupId;
  if (typeof backupId === "string" && backupId !== "") return backupId;
  return null;
}

/** the names of the channels a backup holds. */
async function sourceChannelNames(db: Database, backupId: string): Promise<Set<string>> {
  const rows = await listBackupChannelsByBackup(db, backupId);
  const names = new Set<string>();
  for (const row of rows) {
    if (row.name !== null) names.add(channelKey(row.name));
  }
  return names;
}

/** the restore matches a target channel to a source channel by name, and the
 *  name it sends is the sanitised one: lowercase, spaces as dashes. the key is
 *  that name, so a busy channel is found on either side of the match. */
function channelKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}
