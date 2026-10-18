// services/retention/index.ts. what a guild keeps (D4PLAN 17.2).
//
// pruning is deterministic and explainable: every removal carries the rule that
// caused it, so /backup prune can show a table of what would go and why. the plan
// and the deletion are separate on purpose, because the default is to show the
// plan and write nothing.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { purgeBackup } from "../../db/queries/backup-purge.ts";
import type { BackupKind, BackupRow, Database, RetentionRow } from "../../db/types.ts";

export interface PruneRemoval {
  readonly backup: BackupRow;
  /** the rule that puts it on the list, in the operator's own words. */
  readonly reason: string;
}

export interface PrunePlan {
  readonly removals: readonly PruneRemoval[];
  /** what survives and why, so a plan is readable on its own. */
  readonly kept: readonly { readonly backup: BackupRow; readonly reason: string }[];
  /** true when the policy is off or empty and nothing may be removed. */
  readonly inactive: boolean;
}

export const DEFAULT_RETENTION: RetentionRow = {
  guild_id: "",
  keep_days: null,
  keep_count: null,
  keep_kind_json: null,
  enabled: false,
};

/**
 * D4PLAN 17.2, in order:
 *  1. never delete the newest backup, whatever the policy says
 *  2. never delete a backup a queued or running job refers to
 *  3. pre_restore first, then auto, then manual, oldest first
 *  4. keep_days and keep_count both apply; the survivors are the union
 *
 * `newest` is by created_at. `protectedIds` are the backups a live job holds.
 */
export function planPrune(
  backups: readonly BackupRow[],
  policy: RetentionRow,
  protectedIds: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): PrunePlan {
  const inactive = !policy.enabled || (policy.keep_days === null && policy.keep_count === null);
  if (inactive || backups.length === 0) {
    return {
      removals: [],
      kept: backups.map((backup) => ({ backup, reason: "the policy keeps everything" })),
      inactive: true,
    };
  }

  const kinds = policy.keep_kind_json ?? ["manual", "auto", "pre_restore"];
  // newest first, so "the newest backup" and "the newest N" are the head of this.
  const ordered = [...backups].sort((a, b) =>
    a.created_at === b.created_at
      ? a.backup_id < b.backup_id
        ? 1
        : -1
      : a.created_at < b.created_at
        ? 1
        : -1,
  );

  const cutOffMs = policy.keep_days === null ? null : now - policy.keep_days * 86_400_000;

  const removals: PruneRemoval[] = [];
  const kept: { backup: BackupRow; reason: string }[] = [];

  for (const [index, backup] of ordered.entries()) {
    // 1. the newest backup survives whatever the numbers say: silent total data
    // loss from a misconfigured number is the failure this prevents.
    if (index === 0) {
      kept.push({ backup, reason: "the newest backup is never removed" });
      continue;
    }
    if (protectedIds.has(backup.backup_id)) {
      kept.push({ backup, reason: "a queued or running job refers to it" });
      continue;
    }
    if (policy.keep_kind_json !== null && !kinds.includes(backup.kind)) {
      kept.push({ backup, reason: `the policy only prunes ${kinds.join(", ")}` });
      continue;
    }

    const tooOld =
      cutOffMs !== null && Date.parse(backup.created_at) <= cutOffMs
        ? `older than ${policy.keep_days} day(s)`
        : null;
    const tooMany =
      policy.keep_count !== null && index >= policy.keep_count
        ? `past the newest ${policy.keep_count}`
        : null;

    if (tooOld !== null && tooMany !== null) {
      // pre_restore first, then auto, then manual: a tie between the two rules is
      // reported as the age one, because that is the one an operator set a number for.
      removals.push({ backup, reason: `${tooOld} and ${tooMany}` });
      continue;
    }
    if (tooOld !== null) {
      removals.push({ backup, reason: tooOld });
      continue;
    }
    if (tooMany !== null) {
      removals.push({ backup, reason: tooMany });
      continue;
    }
    kept.push({ backup, reason: "inside the policy" });
  }

  // 3. the deletion order is not the display order: pre_restore goes first so a
  // recovery point survives a manual backup that happens to be older.
  const rank: Record<BackupKind, number> = { pre_restore: 0, auto: 1, manual: 2 };
  removals.sort((a, b) =>
    rank[a.backup.kind] === rank[b.backup.kind]
      ? a.backup.created_at < b.backup.created_at
        ? -1
        : 1
      : rank[a.backup.kind] - rank[b.backup.kind],
  );

  return { removals, kept, inactive: false };
}

export interface PruneApplied {
  readonly removed: readonly BackupRow[];
  readonly failed: readonly { readonly backupId: string; readonly why: string }[];
}

/**
 * deletes the rows and the asset directories together (17.2 rule 5). a failure on
 * one backup is reported and the rest still go: a half-done prune that reports
 * itself is better than one that stops on the first locked file.
 */
export async function applyPrune(
  db: Database,
  plan: PrunePlan,
  backupDir: string,
): Promise<PruneApplied> {
  const removed: BackupRow[] = [];
  const failed: { backupId: string; why: string }[] = [];

  for (const { backup } of plan.removals) {
    try {
      await rm(join(backupDir, backup.backup_id), { recursive: true, force: true });
      await purgeBackup(db, backup.backup_id);
      removed.push(backup);
    } catch (error) {
      failed.push({
        backupId: backup.backup_id,
        why: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed, failed };
}
