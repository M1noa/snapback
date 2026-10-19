// the export expiry sweep (D4PLAN 17.4). an exported file is written under
// data/exports/ with an expiry, and the sweep takes it away when it is past.
//
// the file goes first and the row second: a file that is already gone leaves a
// row the next sweep removes, and a row that is gone leaves a file nobody sweeps
// again.

import { rm } from "node:fs/promises";
import { deletePendingExport, listExpiredExports } from "../../db/queries/exports.ts";
import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";

export interface ExportSweepResult {
  readonly removed: number;
  readonly failed: number;
}

/** the exports whose expiry has passed, and their rows. */
export async function listDueExports(db: Database, now: number): Promise<number> {
  const rows = await listExpiredExports(db, new Date(now).toISOString());
  return rows.length;
}

/** delete the expired exports and their files. */
export async function sweepExpiredExports(
  db: Database,
  now: number,
  log: Logger,
): Promise<ExportSweepResult> {
  const rows = await listExpiredExports(db, new Date(now).toISOString());
  let removed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await rm(row.file_path, { force: true });
      await deletePendingExport(db, row.export_id);
      removed += 1;
    } catch (error) {
      failed += 1;
      log.warn("an export could not be swept", {
        exportId: row.export_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed, failed };
}
