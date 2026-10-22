// the export job (D4PLAN 17.3, 17.4). writing a backup out can take longer than
// an interaction lives, so it is a job, and the file is recorded with the expiry
// the sweeper will use.

import { join } from "node:path";
import { insertPendingExport } from "../../db/queries/exports.ts";
import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import type { JobHandler } from "../jobs/runner.ts";
import { parseExportFormat, writeFormattedExport } from "./formats.ts";
import { buildExport } from "./json.ts";

/** how long a written export stays on disk before the sweeper takes it. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExportJobDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly exportDir: string;
  readonly now?: () => number;
}

interface ExportPayload {
  readonly backupId?: string;
  readonly format?: string;
}

export function createExportJobHandler(deps: ExportJobDeps): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload_json ?? {}) as ExportPayload;
    const backupId = payload.backupId ?? "";
    if (backupId === "") {
      throw new Error("SB_EXPORT_NO_BACKUP: the export job carries no backup id");
    }

    // an unset format is json: an older queued job, or a caller that does not
    // care, still gets the lossless bundle.
    const format = parseExportFormat(payload.format ?? "json");

    const now = deps.now ?? (() => Date.now());
    const at = new Date(now());
    const bundle = await buildExport(deps.db, backupId, { now: () => at.toISOString() });
    const dir = join(deps.exportDir, ctx.job.guild_id);
    const { path, bytes } = await writeFormattedExport(bundle, dir, format);

    await insertPendingExport(deps.db, {
      export_id: Bun.randomUUIDv7(),
      guild_id: ctx.job.guild_id,
      kind: "backup",
      scope_json: { backupId, format },
      file_path: path,
      size_bytes: bytes,
      created_at: at.toISOString(),
      expires_at: new Date(at.getTime() + EXPORT_TTL_MS).toISOString(),
    });

    ctx.log.info("export written", { path, bytes, backupId, format });
  };
}
