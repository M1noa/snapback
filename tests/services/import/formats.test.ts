// tests/services/import/formats.test.ts
// an import reads someone else's file, so the tests are about what the file can
// and cannot carry. restorecord's download has no ids on its channels, so a
// parent cannot be resolved from the file alone; that loss is asserted as a skip
// rather than papered over. a snapback bundle carries every row, so it round
// trips with nothing missing but the asset files.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listBackupChannelsByBackup } from "../../../src/db/queries/backup-channels.ts";
import { listBackupRolesByBackup } from "../../../src/db/queries/backup-roles.ts";
import { getBackup } from "../../../src/db/queries/backups.ts";
import type { Database, JobRow } from "../../../src/db/types.ts";
import type { fetchCdn } from "../../../src/lib/http.ts";
import { createLogger, type Logger } from "../../../src/lib/log.ts";
import {
  ImportError,
  parseImportFormat,
  readBackup,
} from "../../../src/services/import/formats.ts";
import { createImportJobHandler } from "../../../src/services/import/job.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const quietLogger = (): Logger => createLogger({ level: "error", dir: null });

const GUILD = "1000000000000000001";

const RESTORECORD = {
  success: true,
  backup: {
    name: "the server",
    icon: null,
    channels: [
      { name: "general", type: 0, position: 0, parentId: null, topic: "hello", nsfw: false },
      { name: "chatter", type: 0, position: 1, parentId: "10", topic: null, nsfw: false },
    ],
    roles: [
      { name: "@everyone", color: 0, hoist: false, permissions: "104324673", isEveryone: true },
      { name: "mods", color: 16711680, hoist: true, permissions: "0", isEveryone: false },
    ],
    createdAt: "2024-06-01T00:00:00.000Z",
  },
};

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    guild_id: GUILD,
    kind: "import",
    status: "running",
    requested_by: "2000000000000000001",
    payload_json: payload,
    progress_json: null,
    error_code: null,
    error_body: null,
    created_at: "2024-06-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    attempts: 1,
  };
}

function ctx(payload: Record<string, unknown>) {
  return {
    job: job(payload),
    signal: { cancelled: false, paused: false },
    log: quietLogger(),
    checkpoint: async () => {},
  };
}

// the injected seam, so nothing here opens a socket.
function fetchServing(value: unknown): typeof fetchCdn {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return async () => ({ bytes, contentType: "application/json", size: bytes.byteLength });
}

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

describe("format detection", () => {
  test("a foreign backup is told apart, and an unknown object is refused", () => {
    expect(readBackup(RESTORECORD, "auto", "b-1").format).toBe("restorecord");
    // no createdAt envelope, so it is the looser of the two foreign shapes.
    const loose = { channels: [], roles: [{ name: "mods" }] };
    expect(readBackup(loose, "auto", "b-1").format).toBe("vaultcord");
    expect(() => readBackup({ nothing: true }, "auto", "b-1")).toThrow(ImportError);
  });

  test("an override is honoured even when detection would differ", () => {
    expect(readBackup(RESTORECORD, "vaultcord", "b-1").format).toBe("vaultcord");
    expect(parseImportFormat("auto")).toBe("auto");
    expect(() => parseImportFormat("discord")).toThrow(ImportError);
  });
});

describe("a restorecord file", () => {
  test("keeps the roles and channels, and says what it could not carry", () => {
    const read = readBackup(RESTORECORD, "auto", "b-1");
    expect(read.roles.map((row) => row.name)).toEqual(["@everyone", "mods"]);
    expect(read.roles[1]?.color).toBe(16711680);
    expect(read.channels.map((row) => row.name)).toEqual(["general", "chatter"]);
    expect(read.bundle).toBeNull();
    // no channel carries an id in their file, so the parent cannot be resolved.
    expect(read.channels[1]?.parent_source_id).toBeNull();
    expect(read.skips.some((skip) => skip.category === "channels")).toBe(true);
    // shape only: no members, no messages, no files.
    expect(read.skips.some((skip) => skip.category === "members")).toBe(true);
  });

  test("synthesises ids that no live object will match", () => {
    const read = readBackup(RESTORECORD, "auto", "b-1");
    expect(read.channels.map((row) => row.source_channel_id)).toEqual([
      "rc-channel-0",
      "rc-channel-1",
    ]);
    expect(read.roles.map((row) => row.source_role_id)).toEqual(["rc-role-0", "rc-role-1"]);
  });
});

describe("the import job", () => {
  test("stores the rows and seals the backup", async () => {
    const before: string[] = [];
    const handler = createImportJobHandler({
      db,
      log: quietLogger(),
      fetchImpl: fetchServing(RESTORECORD),
    });
    const context = ctx({ url: "https://cdn.discordapp.com/attachments/1/2/backup.json" });
    await handler(context);

    const stored = await db.query<{ backup_id: string }>(
      "SELECT backup_id FROM backups WHERE guild_id = ?",
      [GUILD],
    );
    for (const row of stored) before.push(row.backup_id);
    expect(before.length).toBe(1);

    const backup = await getBackup(db, before[0] as string);
    expect(backup?.kind).toBe("manual");
    expect(backup?.role_count).toBe(2);
    expect(backup?.channel_count).toBe(2);
    expect(backup?.size_bytes).toBe(0);
    // the loss is recorded, so the self-check can report it later.
    expect(backup?.self_check_json?.skipped.some((s) => s.category === "members")).toBe(true);

    const roles = await listBackupRolesByBackup(db, before[0] as string);
    const channels = await listBackupChannelsByBackup(db, before[0] as string);
    expect(roles.map((row) => row.name).sort()).toEqual(["@everyone", "mods"]);
    expect(channels.map((row) => row.name).sort()).toEqual(["chatter", "general"]);
  });

  test("a payload with no url fails with the fixed message", async () => {
    const handler = createImportJobHandler({ db, log: quietLogger() });
    await expect(handler(ctx({}))).rejects.toThrow(ImportError);
  });
});
