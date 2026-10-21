// tests/services/export/dump.test.ts
// the full dump is the migration path: every backup row, every record and
// every job, in one zip. the zip must hold no token, and the records file must
// name the ip mode so a reader can tell a hash from an address.
//
// a real temp-file duckdb and the real query modules, so the dump is proved
// against the rows the database actually holds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { insertGuild } from "../../../src/db/queries/guilds.ts";
import { insertJob } from "../../../src/db/queries/jobs.ts";
import { upsertRecord } from "../../../src/db/queries/verify-records.ts";
import type { Database, JobRow, VerifyRecordRow } from "../../../src/db/types.ts";
import { buildDump, writeDump } from "../../../src/services/export/dump.ts";
import { closeFixtureDb, insertFixtureBackup, openFixtureDb } from "../../fixtures/db.ts";

const GUILD = "1000000000000000001";
const OTHER_GUILD = "1000000000000000002";
const NOW = "2024-06-01T00:00:00.000Z";
const ISO = "2024-01-01T00:00:00.000Z";

// a token value that cannot be mistaken for anything else in a row.
const ACCESS_TOKEN = "access-token-secret-value-0001";
const REFRESH_TOKEN = "refresh-token-secret-value-0002";

const TOKEN_KEY = /token/i;
const ALLOWED_KEYS = new Set(["token_status"]);
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,}[.][A-Za-z0-9_-]{6}[.][A-Za-z0-9_-]{27,}$/;

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();

  await insertGuild(db, {
    guild_id: GUILD,
    name: "the guild",
    icon_url: null,
    owner_user_id: "1000000000000000900",
    added_at: ISO,
    removed_at: null,
    settings_json: null,
  });
  await insertGuild(db, {
    guild_id: OTHER_GUILD,
    name: "the other guild",
    icon_url: null,
    owner_user_id: "1000000000000000900",
    added_at: ISO,
    removed_at: null,
    settings_json: null,
  });

  await insertFixtureBackup(db, {
    backup_id: "0190a000-0000-7000-8000-0000000000d1",
    guild_id: GUILD,
  });
  await insertFixtureBackup(db, {
    backup_id: "0190a000-0000-7000-8000-0000000000d2",
    guild_id: OTHER_GUILD,
  });

  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000e1",
      guild_id: GUILD,
      user_id: "1000000000000000100",
      username: "someone",
      last_ip_hash: "hashed-address-0001",
      access_token_enc: ACCESS_TOKEN,
      refresh_token_enc: REFRESH_TOKEN,
      token_status: "valid",
    }),
  );
  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000e2",
      guild_id: OTHER_GUILD,
      user_id: "1000000000000000101",
      username: "elsewhere",
    }),
  );

  await insertJob(db, makeJob());
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function makeRecord(overrides: Partial<VerifyRecordRow> = {}): VerifyRecordRow {
  return {
    record_id: "0190a000-0000-7000-8000-0000000000e1",
    guild_id: GUILD,
    user_id: "1000000000000000100",
    username: "someone",
    global_name: null,
    discriminator: "0",
    avatar_url: null,
    email: "someone@example.test",
    email_verified: true,
    locale: "en-US",
    mfa_enabled: false,
    premium_type: 0,
    flags: 0,
    connections_json: [],
    guilds_json: [],
    relationships_json: [],
    oauth_scopes_json: ["identify"],
    oauth_granted_at: ISO,
    oauth_last_checked_at: ISO,
    access_token_enc: null,
    refresh_token_enc: null,
    token_expires_at: null,
    token_status: "missing",
    first_ip_hash: null,
    first_ip_enc: null,
    last_ip_hash: null,
    last_ip_enc: null,
    ip_history_json: [],
    country_code: null,
    country_name: null,
    city: null,
    region: null,
    isp: null,
    asn: null,
    as_org: null,
    ip_type: null,
    is_vpn: null,
    is_proxy: null,
    is_tor: null,
    intel_checked_at: null,
    fingerprint_json: null,
    verify_status: "verified",
    refusal_reason: null,
    alt_match_json: null,
    referrer: null,
    user_agent: null,
    revoked_at: null,
    notes: null,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
}

function makeJob(): JobRow {
  return {
    id: "0190a000-0000-7000-8000-0000000000f1",
    guild_id: GUILD,
    kind: "backup",
    status: "succeeded",
    requested_by: "1000000000000000900",
    payload_json: { label: "nightly" },
    progress_json: { step: "done" },
    error_code: null,
    error_body: null,
    created_at: ISO,
    started_at: ISO,
    finished_at: ISO,
    attempts: 1,
  };
}

// visit every key and value of a parsed file.
type Visitor = (key: string | null, value: unknown) => void;

function walk(value: unknown, visit: Visitor, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, null);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey);
  }
}

interface ZipFile {
  readonly name: string;
  readonly text: string;
}

// a zip reader for the test: the central directory names every file and where
// its data is, and the data is deflated.
function readZip(bytes: Buffer): ZipFile[] {
  let end = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end === -1) throw new Error("the zip has no end of central directory");

  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files: ZipFile[] = [];

  for (let index = 0; index < count; index += 1) {
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = bytes.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : body;

    files.push({ name, text: data.toString("utf8") });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe("buildDump", () => {
  test("it holds every backup row, every record and every job", async () => {
    const bundle = await buildDump(db, { now: () => NOW });
    expect(bundle.exported_at).toBe(NOW);
    expect(bundle.backups.length).toBe(2);
    expect(bundle.records.length).toBe(2);
    expect(bundle.jobs.length).toBe(1);
    expect(bundle.guilds.map((group) => group.guild_id)).toEqual([GUILD, OTHER_GUILD]);
  });

  test("the jobs keep their status and their kind", async () => {
    const bundle = await buildDump(db, { now: () => NOW });
    const job = bundle.jobs[0];
    expect(job?.kind).toBe("backup");
    expect(job?.status).toBe("succeeded");
    expect(job?.guild_id).toBe(GUILD);
  });
});

describe("writeDump", () => {
  test("the zip holds the three files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-dump-"));
    try {
      const bundle = await buildDump(db, { now: () => NOW });
      const written = await writeDump(bundle, dir);
      const files = readZip(Buffer.from(await Bun.file(written.path).arrayBuffer()));

      expect(written.files).toEqual(["backups.json", "records.json", "jobs.json"]);
      expect(files.map((file) => file.name)).toEqual([...written.files]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the bytes count matches what is on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-dump-bytes-"));
    try {
      const bundle = await buildDump(db, { now: () => NOW });
      const written = await writeDump(bundle, dir);
      const onDisk = await stat(written.path);

      expect(written.path).toBe(join(dir, "dump.zip"));
      expect(written.bytes).toBe(onDisk.size);
      expect(written.bytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no file in the zip carries a token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-dump-token-"));
    try {
      const bundle = await buildDump(db, { now: () => NOW });
      const written = await writeDump(bundle, dir);
      const files = readZip(Buffer.from(await Bun.file(written.path).arrayBuffer()));

      for (const file of files) {
        expect(file.text).not.toContain(ACCESS_TOKEN);
        expect(file.text).not.toContain(REFRESH_TOKEN);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the records file names the ip mode and holds the ip in that form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-dump-mode-"));
    try {
      const bundle = await buildDump(db, { now: () => NOW, ipStorage: "hash" });
      const written = await writeDump(bundle, dir);
      const files = readZip(Buffer.from(await Bun.file(written.path).arrayBuffer()));
      const records = files.find((file) => file.name === "records.json");
      expect(records).toBeDefined();

      const parsed: unknown = JSON.parse(records?.text ?? "{}");
      expect(parsed).toMatchObject({ ip_storage: "hash" });
      expect(records?.text).toContain("hashed-address-0001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no key in the zip names a token and no value looks like one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-dump-keys-"));
    try {
      const bundle = await buildDump(db, { now: () => NOW });
      const written = await writeDump(bundle, dir);
      const files = readZip(Buffer.from(await Bun.file(written.path).arrayBuffer()));

      for (const file of files) {
        const parsed: unknown = JSON.parse(file.text);
        walk(parsed, (key, value) => {
          if (key !== null) {
            expect(ALLOWED_KEYS.has(key) || !TOKEN_KEY.test(key)).toBe(true);
          }
          if (typeof value === "string") {
            expect(TOKEN_SHAPE.test(value)).toBe(false);
          }
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the backups file holds the backup rows and the jobs file the jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapback-dump-content-"));
    try {
      const bundle = await buildDump(db, { now: () => NOW });
      const written = await writeDump(bundle, dir);
      const files = readZip(Buffer.from(await Bun.file(written.path).arrayBuffer()));

      const backups: unknown = JSON.parse(
        files.find((f) => f.name === "backups.json")?.text ?? "{}",
      );
      const jobs: unknown = JSON.parse(files.find((f) => f.name === "jobs.json")?.text ?? "{}");

      expect(backups).toMatchObject({
        backups: expect.arrayContaining([expect.objectContaining({ guild_id: GUILD })]),
      });
      expect(jobs).toMatchObject({
        jobs: expect.arrayContaining([
          expect.objectContaining({ kind: "backup", status: "succeeded" }),
        ]),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
