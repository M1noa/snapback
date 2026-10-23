// the import job. reading one uploaded backup file into a stored backup, so
// /backup info, /backup export, and /restore all work on it afterwards.
//
// the file arrives as a url: an attachment's option value is an id, and the
// handler trades it for the cdn url discord resolved. that url is signed and
// short-lived, so a run resumed after a restart downloads again and an expired
// url fails with the cdn's own status rather than silently importing nothing.
//
// an import writes no files. assets stay as the urls the file carries, so
// size_bytes is zero and the assets note is in the skip list.

import * as automodDb from "../../db/queries/backup-automod.ts";
import * as bansDb from "../../db/queries/backup-bans.ts";
import * as channelsDb from "../../db/queries/backup-channels.ts";
import * as emojisDb from "../../db/queries/backup-emojis.ts";
import * as eventsDb from "../../db/queries/backup-events.ts";
import * as membersDb from "../../db/queries/backup-members.ts";
import * as messagesDb from "../../db/queries/backup-messages.ts";
import * as overwritesDb from "../../db/queries/backup-overwrites.ts";
import { purgeBackupRows } from "../../db/queries/backup-purge.ts";
import * as rolesDb from "../../db/queries/backup-roles.ts";
import * as soundsDb from "../../db/queries/backup-sounds.ts";
import * as stickersDb from "../../db/queries/backup-stickers.ts";
import * as threadsDb from "../../db/queries/backup-threads.ts";
import { insertBackup } from "../../db/queries/backups.ts";
import type { BackupRow, Database, Skip } from "../../db/types.ts";
import { fetchCdn } from "../../lib/http.ts";
import type { Logger } from "../../lib/log.ts";
import { sealBackup } from "../backup/selfcheck.ts";
import { BACKUP_SCHEMA_VERSION } from "../backup/types.ts";
import type { JobHandler } from "../jobs/runner.ts";
import {
  ImportError,
  type ImportedBackup,
  type ImportFormatChoice,
  parseImportFormat,
  readBackup,
} from "./formats.ts";

/** a backup file is json a person downloads, so it may be far past a cdn image. */
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 60_000;

export interface ImportJobDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly maxBytes?: number;
  readonly now?: () => number;
  /** the injected seam is fetchCdn's type, as in the asset store: a test reads
   *  known bytes through it and never touches the network. */
  readonly fetchImpl?: typeof fetchCdn;
}

interface ImportPayload {
  readonly url?: string;
  readonly label?: string;
  readonly format?: string;
}

export function createImportJobHandler(deps: ImportJobDeps): JobHandler {
  return async (ctx) => {
    const payload = (ctx.job.payload_json ?? {}) as ImportPayload;
    const url = payload.url ?? "";
    if (url === "") throw new ImportError("SB_IMPORT_NO_FILE");
    const format: ImportFormatChoice = parseImportFormat(payload.format);

    // the cdn refuses a host it does not own, a non-200, and a body over the cap.
    const fetchImpl = deps.fetchImpl ?? fetchCdn;
    const response = await fetchImpl(url, {
      maxBytes: deps.maxBytes ?? IMPORT_MAX_BYTES,
      timeoutMs: IMPORT_TIMEOUT_MS,
    });
    const parsed = parseJson(response.bytes);

    const backupId = Bun.randomUUIDv7();
    const imported = readBackup(parsed, format, backupId);

    const now = deps.now ?? (() => Date.now());
    const createdAt = new Date(now()).toISOString();
    const label = payload.label ?? imported.name;

    // a skeleton with no self-check is what an unfinished backup looks like, so
    // the row is visible while the import runs and sealed when it finishes.
    const skeleton = skeletonRow({
      backupId,
      guildId: ctx.job.guild_id,
      requestedBy: ctx.job.requested_by,
      createdAt,
      label: label === null ? null : label,
      name: imported.name,
      iconUrl: imported.iconUrl,
      source: imported.row,
      format: imported.format,
    });
    await insertBackup(deps.db, skeleton);

    // an import into an id that already has children would collide on the
    // (backup_id, source id) key, so this is the same idempotence as a capture.
    await purgeBackupRows(deps.db, backupId);

    const skips: Skip[] = [...imported.skips];
    const failures: string[] = [];

    await writeRows(deps.db, backupId, imported, skips, failures);

    const sealed = await sealBackup({
      db: deps.db,
      backupId,
      recorded: {
        roles: imported.roles.length,
        channels: imported.channels.length,
        members: imported.bundle?.members.length ?? 0,
        messages: imported.bundle?.messages.length ?? 0,
      },
      skips,
      assetDir: null,
      extraFailures: failures,
    });

    ctx.log.info("backup imported", {
      backupId,
      format: imported.format,
      roles: imported.roles.length,
      channels: imported.channels.length,
      ok: sealed.check.ok,
    });
  };
}

// the children, in the order the tables expect. a foreign format fills two of
// them; a snapback bundle fills all twelve.
async function writeRows(
  db: Database,
  backupId: string,
  imported: ImportedBackup,
  skips: Skip[],
  failures: string[],
): Promise<void> {
  const bundle = imported.bundle;

  // a step that threw does not lose the rows already written. the seal marks the
  // backup incomplete and names what failed, which is what /backup info shows.
  async function write(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      failures.push(`${what}: ${why}`);
      skips.push({ category: what, what: `the ${what} of the source backup`, why });
    }
  }

  await write("roles", () => rolesDb.insertBackupRoles(db, imported.roles));
  await write("channels", () => channelsDb.insertBackupChannels(db, imported.channels));
  if (bundle === null) return;

  await write("overwrites", () =>
    overwritesDb.insertBackupChannelOverwrites(
      db,
      bundle.overwrites.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("threads", () =>
    threadsDb.insertBackupThreads(
      db,
      bundle.threads.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("members", () =>
    membersDb.insertBackupMembers(
      db,
      bundle.members.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("messages", () =>
    messagesDb.insertBackupMessages(
      db,
      bundle.messages.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("bans", () =>
    bansDb.insertBackupBans(
      db,
      bundle.bans.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("emojis", () =>
    emojisDb.insertBackupEmojis(
      db,
      bundle.emojis.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("stickers", () =>
    stickersDb.insertBackupStickers(
      db,
      bundle.stickers.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("sounds", () =>
    soundsDb.insertBackupSounds(
      db,
      bundle.sounds.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("automod", () =>
    automodDb.insertBackupAutomods(
      db,
      bundle.automod.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
  await write("events", () =>
    eventsDb.insertBackupEvents(
      db,
      bundle.events.map((row) => ({ ...row, backup_id: backupId })),
    ),
  );
}

// the row as it starts. counts are zero until the seal recounts; the source's own
// counts are not trusted because a foreign file lies about nothing and knows less.
function skeletonRow(input: {
  backupId: string;
  guildId: string;
  requestedBy: string;
  createdAt: string;
  label: string | null;
  name: string | null;
  iconUrl: string | null;
  source: BackupRow | null;
  format: string;
}): BackupRow {
  const source = input.source;
  return {
    backup_id: input.backupId,
    // the importing guild owns the backup. a snapback bundle's guild id names
    // where it came from, and a restore into the same guild must not read that
    // as "already here".
    guild_id: input.guildId,
    label: input.label,
    kind: "manual",
    guild_name: input.name,
    icon_url: input.iconUrl,
    banner_url: source?.banner_url ?? null,
    splash_url: source?.splash_url ?? null,
    discovery_splash_url: source?.discovery_splash_url ?? null,
    owner_user_id: source?.owner_user_id ?? null,
    member_count: 0,
    message_count: 0,
    channel_count: 0,
    role_count: 0,
    size_bytes: 0,
    schema_version: source?.schema_version ?? BACKUP_SCHEMA_VERSION,
    guild_settings_json: source?.guild_settings_json ?? null,
    onboarding_json: source?.onboarding_json ?? null,
    welcome_screen_json: source?.welcome_screen_json ?? null,
    widget_json: source?.widget_json ?? null,
    afk_json: source?.afk_json ?? null,
    self_check_json: null,
    created_at: input.createdAt,
    created_by: input.requestedBy,
  };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ImportError("SB_IMPORT_MALFORMED");
  }
}
