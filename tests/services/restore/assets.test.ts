// tests/services/restore/assets.test.ts
//
// the asset helpers (D4PLAN 12.6, 12.3). the capture writes the bytes into the
// backup's own assets/ tree, so the restore reads them from disk and hands
// discord a data uri. a file that is not there, or one over the ceiling, is a
// null the caller reports, never a silent blank icon.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "../../../src/db/types.ts";
import type { DiscordClient } from "../../../src/discord/client.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  MAX_ASSET_BYTES,
  uploadAsset,
  uploadGuildIcon,
} from "../../../src/services/restore/assets.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const BACKUP_ID = "0190a000-0000-7000-8000-0000000000f1";
const SOURCE_GUILD_ID = "1000000000000000001";
const TARGET_GUILD_ID = "1000000000000000002";

let db: Database;
let base: string;
const dirs: string[] = [];

beforeAll(async () => {
  db = await openFixtureDb();
  base = mkdtempSync(join(tmpdir(), "snapback-restore-assets-"));
  dirs.push(base);
});

afterAll(async () => {
  await closeFixtureDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(): RestoreContext {
  return {
    db,
    client: {} as DiscordClient,
    log: createLogger({ level: "error", dir: null }),
    backupId: BACKUP_ID,
    targetGuildId: TARGET_GUILD_ID,
    options: DEFAULT_RESTORE_OPTIONS,
    maps: createRestoreMaps(),
    sourceGuildId: SOURCE_GUILD_ID,
    backupDir: base,
    signal: { cancelled: false, paused: false },
    checkpoint: async () => {},
    note: () => {},
    now: () => "2024-01-01T00:00:00.000Z",
  };
}

function assetDir(kind: string): string {
  const dir = join(base, BACKUP_ID, "assets", kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("restore assets", () => {
  test("a file that is there is read and returned as a data uri", async () => {
    const dir = assetDir("attachment");
    const file = join(dir, "shot.png");
    writeFileSync(file, "hello");

    const uri = await uploadAsset(context(), file, "shot.png");
    expect(uri).toBe("data:image/png;base64,aGVsbG8=");
  });

  test("a missing file returns null", async () => {
    const dir = assetDir("attachment");
    const uri = await uploadAsset(context(), join(dir, "gone.png"), "gone.png");
    expect(uri).toBeNull();
  });

  test("a file over the ceiling returns null", async () => {
    const dir = assetDir("attachment");
    const file = join(dir, "huge.png");
    writeFileSync(file, Buffer.alloc(MAX_ASSET_BYTES + 1));

    const uri = await uploadAsset(context(), file, "huge.png");
    expect(uri).toBeNull();
  });

  test("a file outside the backup's asset directory returns null", async () => {
    const file = join(base, "stray.png");
    writeFileSync(file, "hello");

    const uri = await uploadAsset(context(), file, "stray.png");
    expect(uri).toBeNull();
  });

  test("the guild image comes back as a data uri, and nothing comes back without one", async () => {
    const dir = assetDir("guild");
    writeFileSync(join(dir, "icon.png"), "hello");

    const uri = await uploadGuildIcon(context(), "icon", SOURCE_GUILD_ID);
    expect(uri).toBe("data:image/png;base64,aGVsbG8=");

    const missing = await uploadGuildIcon(context(), "banner", SOURCE_GUILD_ID);
    expect(missing).toBeNull();
  });
});
