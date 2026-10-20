// services/export/dump.ts
// the full dump (D4PLAN 17.3): every backup row, every record and every job,
// in one zip. it is /setup data's "export everything" and the migration path.
//
// the same discipline as the other exports: no token, no bare ip, and the ip
// mode named in the records file. the records go through the records
// serialiser, so the token columns are never read, and the job rows carry no
// token either: a job payload holds ids and options.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { IpStorage } from "../../config/parse-env.ts";
import { listBackupsByGuild } from "../../db/queries/backups.ts";
import { listJobsByGuild } from "../../db/queries/jobs.ts";
import type { BackupRow, Database, JobRow } from "../../db/types.ts";
import { listAllRecords, type RecordExportRow, recordToExportRow } from "./records.ts";

/** the schema version of the dump. */
export const DUMP_SCHEMA_VERSION = 1;

/** the files the zip holds. */
export const DUMP_FILES = ["backups.json", "records.json", "jobs.json"] as const;

/** everything the database holds, in one bundle. */
export interface DumpBundle {
  readonly schema_version: number;
  readonly exported_at: string;
  /** the ip storage mode in force, so the records file can name it. */
  readonly ip_storage: IpStorage;
  /**
   * the records of each guild. a record row does not name the guild it came
   * from, so the file keeps the grouping here or the guild is lost.
   */
  readonly guilds: readonly DumpGuildRecords[];
  readonly backups: readonly BackupDumpRow[];
  /** every record, flattened. the same rows the guild groups hold. */
  readonly records: readonly RecordExportRow[];
  readonly jobs: readonly JobDumpRow[];
}

/** the records of one guild. */
export interface DumpGuildRecords {
  readonly guild_id: string;
  readonly records: readonly RecordExportRow[];
}

/** the backup's own row, the shape the backups table holds. */
export type BackupDumpRow = BackupRow;

/** the job's own row, the shape the jobs table holds. */
export type JobDumpRow = JobRow;

export interface DumpOptions {
  /** the clock, injected so the exported_at is not clock-dependent (D4PLAN 20). */
  readonly now?: () => string;
  /**
   * the ip storage mode in force. the caller passes the configured mode
   * (env.privacy.ipStorage): the records file names it.
   */
  readonly ipStorage?: IpStorage;
}

/** every backup row, every record and every job, of every guild. */
export async function buildDump(db: Database, options: DumpOptions = {}): Promise<DumpBundle> {
  const now = options.now ?? (() => new Date().toISOString());
  const mode = options.ipStorage ?? "hash";
  const guildIds = await listGuildIds(db);

  const backups: BackupDumpRow[] = [];
  const jobs: JobDumpRow[] = [];
  const guilds: DumpGuildRecords[] = [];
  const records: RecordExportRow[] = [];

  for (const guildId of guildIds) {
    backups.push(...(await listBackupsByGuild(db, guildId)));
    jobs.push(...(await listJobsByGuild(db, guildId)));
    const exported = (await listAllRecords(db, guildId)).map((row) => recordToExportRow(row, mode));
    guilds.push({ guild_id: guildId, records: exported });
    records.push(...exported);
  }

  return {
    schema_version: DUMP_SCHEMA_VERSION,
    exported_at: now(),
    ip_storage: mode,
    guilds,
    backups,
    records,
    jobs,
  };
}

/**
 * writes the dump as a zip under dir, creating dir if it is missing, and
 * returns the absolute path, the byte length and the names it holds.
 */
export async function writeDump(
  bundle: DumpBundle,
  dir: string,
): Promise<{ path: string; bytes: number; files: readonly string[] }> {
  await mkdir(dir, { recursive: true });

  const header = {
    schema_version: bundle.schema_version,
    exported_at: bundle.exported_at,
  };
  const entries: ZipEntry[] = [
    { name: "backups.json", data: jsonBytes({ ...header, backups: bundle.backups }) },
    {
      name: "records.json",
      data: jsonBytes({ ...header, ip_storage: bundle.ip_storage, guilds: bundle.guilds }),
    },
    { name: "jobs.json", data: jsonBytes({ ...header, jobs: bundle.jobs }) },
  ];

  const zip = buildZip(entries);
  const path = resolve(dir, "dump.zip");
  await writeFile(path, zip);

  return { path, bytes: zip.byteLength, files: entries.map((entry) => entry.name) };
}

// the guilds the dump covers. the guild table is the spine of it: a guild the
// bot left is still in that table, and its backups, records and jobs are still
// in the dump.
async function listGuildIds(db: Database): Promise<string[]> {
  const rows = await db.query<{ guild_id: string }>(
    "SELECT guild_id FROM guilds ORDER BY guild_id",
  );
  return rows.map((row) => row.guild_id);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

// a zip with one deflated entry per file: local headers, the data, a central
// directory, and the end record. the timestamp is fixed, so two dumps of the
// same data are the same bytes.
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x0021, 12); // mod date: 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x0021, 14); // mod date
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, central, end]);
}
