import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { DEFAULT_GUILD_SETTINGS } from "../../src/config/defaults.ts";
import * as admins from "../../src/db/queries/admins.ts";
import * as audit from "../../src/db/queries/audit.ts";
import * as guilds from "../../src/db/queries/guilds.ts";
import * as interaction from "../../src/db/queries/interaction-state.ts";
import * as jobs from "../../src/db/queries/jobs.ts";
import * as meta from "../../src/db/queries/meta.ts";
import * as oauth from "../../src/db/queries/oauth-states.ts";
import type { Database, SqlParam } from "../../src/db/types.ts";

// each query module is exercised against a real temp-file duckdb, with the
// schema executed directly (migrate.ts is owned elsewhere). the point is the
// boundary: a snowflake survives as a string, a boolean comes back a boolean,
// and a settings_json blob round-trips.

const SCHEMA = new URL("../../src/db/schema.sql", import.meta.url);

const SNOWFLAKE = "144102483157850112";
const OWNER = "223456789012345678";
const JOB_ID = "0190a000-0000-7000-8000-000000000001";
const JOB_ID_OLD = "0190a000-0000-7000-8000-000000000000";
const AUDIT_ID = "0190a000-0000-7000-8000-000000000002";
const AUDIT_ID_NEW = "0190a000-0000-7000-8000-000000000003";

const PAST = "2000-01-01T00:00:00.000Z";
const NOW = "2024-01-01T00:00:00.000Z";
const LATER = "2025-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

let dir: string;
let instance: DuckDBInstance;
let conn: DuckDBConnection;
let db: Database;

function adapter(connection: DuckDBConnection): Database {
  return {
    kind: "duckdb",
    async query<T>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const reader = await connection.runAndReadAll(sql, params as never);
      return reader.getRowObjectsJS() as unknown as T[];
    },
    async run(sql: string, params?: SqlParam[]): Promise<void> {
      await connection.run(sql, params as never);
    },
    async exec(script: string): Promise<void> {
      await connection.run(script);
    },
    async close(): Promise<void> {
      connection.closeSync();
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-queries-"));
  instance = await DuckDBInstance.create(join(dir, "queries.duckdb"));
  conn = await instance.connect();
  await conn.run(await Bun.file(SCHEMA).text());
  db = adapter(conn);
});

afterAll(() => {
  conn?.closeSync();
  instance?.closeSync();
  rmSync(dir, { recursive: true, force: true });
});

describe("meta", () => {
  test("insert, select back, and upsert on the same key", async () => {
    await meta.setMeta(db, "schema_version", "1");
    expect((await meta.getMeta(db, "schema_version"))?.value).toBe("1");

    await meta.setMeta(db, "schema_version", "2");
    expect((await meta.getMeta(db, "schema_version"))?.value).toBe("2");

    const all = await meta.listMeta(db);
    expect(all.length).toBe(1);

    await meta.deleteMeta(db, "schema_version");
    expect(await meta.getMeta(db, "schema_version")).toBeNull();
  });
});

describe("guilds", () => {
  test("insert, select back, update, and upsert", async () => {
    await guilds.insertGuild(db, {
      guild_id: SNOWFLAKE,
      name: "original",
      icon_url: null,
      owner_user_id: OWNER,
      added_at: NOW,
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });

    const got = await guilds.getGuild(db, SNOWFLAKE);
    expect(got?.guild_id).toBe(SNOWFLAKE);
    expect(typeof got?.guild_id).toBe("string");

    await guilds.updateGuild(db, {
      guild_id: SNOWFLAKE,
      name: "renamed",
      icon_url: "https://cdn.discordapp.com/icons/1/a.png",
      owner_user_id: OWNER,
      added_at: NOW,
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });
    expect((await guilds.getGuild(db, SNOWFLAKE))?.name).toBe("renamed");

    await guilds.upsertGuild(db, {
      guild_id: SNOWFLAKE,
      name: "upserted",
      icon_url: null,
      owner_user_id: OWNER,
      added_at: NOW,
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });
    const list = await guilds.listActiveGuilds(db);
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("upserted");
  });

  test("settings_json round-trips through readGuildSettings", async () => {
    const settings = {
      ...DEFAULT_GUILD_SETTINGS,
      ephemeral_default: false,
      log_channel_id: "999000111222333444",
    };
    await guilds.setGuildSettings(db, SNOWFLAKE, settings);
    expect(await guilds.getGuildSettings(db, SNOWFLAKE)).toEqual(settings);

    // a partial stored blob still comes back complete.
    await guilds.updateGuild(db, {
      guild_id: SNOWFLAKE,
      name: "upserted",
      icon_url: null,
      owner_user_id: OWNER,
      added_at: NOW,
      removed_at: null,
      settings_json: { ...DEFAULT_GUILD_SETTINGS, notify_on_join: true },
    });
    const stored = await guilds.getGuildSettings(db, SNOWFLAKE);
    expect(stored?.notify_on_join).toBe(true);
    expect(stored?.ephemeral_default).toBe(DEFAULT_GUILD_SETTINGS.ephemeral_default);

    const removed = await guilds.markGuildRemoved(db, SNOWFLAKE, LATER);
    expect(removed).toBeUndefined();
    await guilds.updateGuild(db, {
      guild_id: SNOWFLAKE,
      name: "upserted",
      icon_url: null,
      owner_user_id: OWNER,
      added_at: NOW,
      removed_at: null,
      settings_json: DEFAULT_GUILD_SETTINGS,
    });
  });
});

describe("guild_admins", () => {
  test("insert, select back, update flags, and remove", async () => {
    await admins.insertAdmin(db, {
      guild_id: SNOWFLAKE,
      user_id: OWNER,
      added_by: OWNER,
      added_at: NOW,
      can_backup: true,
      can_restore: false,
      can_manage_admins: false,
      can_view_records: true,
      can_delete_records: false,
    });

    const got = await admins.getAdmin(db, SNOWFLAKE, OWNER);
    expect(got?.can_backup).toBe(true);
    expect(typeof got?.can_backup).toBe("boolean");

    await admins.setAdminFlags(db, SNOWFLAKE, OWNER, {
      can_backup: false,
      can_restore: true,
      can_manage_admins: true,
      can_view_records: false,
      can_delete_records: true,
    });
    const flags = await admins.getAdmin(db, SNOWFLAKE, OWNER);
    expect(flags?.can_restore).toBe(true);
    expect(flags?.can_backup).toBe(false);

    await admins.upsertAdmin(db, {
      guild_id: SNOWFLAKE,
      user_id: OWNER,
      added_by: OWNER,
      added_at: LATER,
      can_backup: true,
      can_restore: true,
      can_manage_admins: true,
      can_view_records: true,
      can_delete_records: true,
    });
    expect((await admins.listAdminsForGuild(db, SNOWFLAKE)).length).toBe(1);
    expect((await admins.listGuildsForUser(db, OWNER)).length).toBe(1);

    await admins.removeAdmin(db, SNOWFLAKE, OWNER);
    expect(await admins.getAdmin(db, SNOWFLAKE, OWNER)).toBeNull();
  });
});

describe("jobs", () => {
  test("insert, select back, status change, and payload json", async () => {
    await jobs.insertJob(db, {
      id: JOB_ID,
      guild_id: SNOWFLAKE,
      kind: "backup",
      status: "queued",
      requested_by: OWNER,
      payload_json: { channels: ["1", "2"] },
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: NOW,
      started_at: null,
      finished_at: null,
      attempts: 0,
    });

    const got = await jobs.getJob(db, JOB_ID);
    expect(got?.id).toBe(JOB_ID);
    expect(typeof got?.id).toBe("string");
    expect(got?.payload_json).toEqual({ channels: ["1", "2"] });
    expect(got?.attempts).toBe(0);
    expect(Number.isNaN(Number(got?.id))).toBe(true); // a uuid, not a coerced number

    await jobs.setJobStatus(db, JOB_ID, "running");
    expect((await jobs.getJob(db, JOB_ID))?.status).toBe("running");
  });

  test("resumable reads return queued/running/paused oldest first", async () => {
    await jobs.insertJob(db, {
      id: JOB_ID_OLD,
      guild_id: SNOWFLAKE,
      kind: "backup",
      status: "paused",
      requested_by: OWNER,
      payload_json: null,
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: "2023-01-01T00:00:00.000Z",
      started_at: null,
      finished_at: null,
      attempts: 1,
    });

    const resumable = await jobs.listResumableJobs(db);
    expect(resumable.map((row) => row.id)).toEqual([JOB_ID_OLD, JOB_ID]);

    const byGuild = await jobs.listResumableJobsForGuild(db, SNOWFLAKE);
    expect(byGuild.map((row) => row.id)).toEqual([JOB_ID_OLD, JOB_ID]);

    const running = await jobs.listJobsByGuildAndStatus(db, SNOWFLAKE, "running");
    expect(running.map((row) => row.id)).toEqual([JOB_ID]);

    const byKind = await jobs.listJobsByKindAndStatus(db, "backup", "paused");
    expect(byKind.map((row) => row.id)).toEqual([JOB_ID_OLD]);

    const list = await jobs.listJobsByGuild(db, SNOWFLAKE);
    expect(list.length).toBe(2);
  });

  test("update writes progress_json back", async () => {
    await jobs.updateJob(db, {
      id: JOB_ID,
      guild_id: SNOWFLAKE,
      kind: "backup",
      status: "succeeded",
      requested_by: OWNER,
      payload_json: null,
      progress_json: { done: 5, total: 5 },
      error_code: null,
      error_body: null,
      created_at: NOW,
      started_at: NOW,
      finished_at: LATER,
      attempts: 1,
    });
    const got = await jobs.getJob(db, JOB_ID);
    expect(got?.status).toBe("succeeded");
    expect(got?.progress_json).toEqual({ done: 5, total: 5 });
  });

  test("job_progress checkpoints upsert on (job_id, step)", async () => {
    await jobs.insertJobProgress(db, {
      job_id: JOB_ID,
      step: "channels",
      cursor: null,
      done_count: 1,
      total_count: 3,
      updated_at: NOW,
    });
    await jobs.upsertJobProgress(db, {
      job_id: JOB_ID,
      step: "channels",
      cursor: "123",
      done_count: 2,
      total_count: 3,
      updated_at: LATER,
    });

    const got = await jobs.getJobProgress(db, JOB_ID, "channels");
    expect(got?.done_count).toBe(2);
    expect(got?.cursor).toBe("123");

    await jobs.updateJobProgress(db, {
      job_id: JOB_ID,
      step: "channels",
      cursor: null,
      done_count: 3,
      total_count: 3,
      updated_at: FUTURE,
    });
    expect((await jobs.getJobProgress(db, JOB_ID, "channels"))?.done_count).toBe(3);
    expect((await jobs.listJobProgress(db, JOB_ID)).length).toBe(1);

    await jobs.deleteJobProgress(db, JOB_ID);
    expect((await jobs.listJobProgress(db, JOB_ID)).length).toBe(0);
  });
});

describe("audit_log", () => {
  test("insert, select back, and newest-first listing", async () => {
    await audit.insertAudit(db, {
      id: AUDIT_ID,
      guild_id: SNOWFLAKE,
      actor_user_id: OWNER,
      action: "backup.create",
      target: null,
      detail_json: { label: "nightly" },
      created_at: NOW,
    });
    await audit.insertAudit(db, {
      id: AUDIT_ID_NEW,
      guild_id: SNOWFLAKE,
      actor_user_id: OWNER,
      action: "backup.prune",
      target: JOB_ID,
      detail_json: null,
      created_at: LATER,
    });

    expect((await audit.getAudit(db, AUDIT_ID))?.detail_json).toEqual({ label: "nightly" });

    const list = await audit.listAuditByGuild(db, SNOWFLAKE);
    expect(list.map((row) => row.id)).toEqual([AUDIT_ID_NEW, AUDIT_ID]);

    const byActor = await audit.listAuditByActor(db, SNOWFLAKE, OWNER);
    expect(byActor.length).toBe(2);

    const paged = await audit.listAuditByGuild(db, SNOWFLAKE, { before: LATER, limit: 10 });
    expect(paged.map((row) => row.id)).toEqual([AUDIT_ID]);
  });
});

describe("interaction_state", () => {
  test("insert, select back, update, and sweep by expires_at", async () => {
    await interaction.insertInteractionState(db, {
      state_id: "abc123",
      guild_id: SNOWFLAKE,
      user_id: OWNER,
      surface: "restore",
      payload_json: { selection: ["1", "2"] },
      created_at: NOW,
      expires_at: FUTURE,
    });

    expect((await interaction.getInteractionState(db, "abc123"))?.payload_json).toEqual({
      selection: ["1", "2"],
    });

    await interaction.updateInteractionState(db, {
      state_id: "abc123",
      guild_id: SNOWFLAKE,
      user_id: OWNER,
      surface: "restore",
      payload_json: { selection: ["3"] },
      created_at: NOW,
      expires_at: FUTURE,
    });
    expect((await interaction.getInteractionState(db, "abc123"))?.payload_json).toEqual({
      selection: ["3"],
    });

    await interaction.insertInteractionState(db, {
      state_id: "stale",
      guild_id: SNOWFLAKE,
      user_id: OWNER,
      surface: "restore",
      payload_json: {},
      created_at: PAST,
      expires_at: PAST,
    });
    await interaction.deleteExpiredInteractionState(db, NOW);
    expect(await interaction.getInteractionState(db, "stale")).toBeNull();
    expect(await interaction.getInteractionState(db, "abc123")).not.toBeNull();
    expect((await interaction.listInteractionStateForGuild(db, SNOWFLAKE)).length).toBe(1);

    await interaction.deleteInteractionState(db, "abc123");
    expect(await interaction.getInteractionState(db, "abc123")).toBeNull();
  });
});

describe("oauth_states", () => {
  test("insert, consume, update, and sweep by expires_at", async () => {
    await oauth.insertOauthState(db, {
      state: "nonce",
      guild_id: SNOWFLAKE,
      created_at: NOW,
      expires_at: FUTURE,
      consumed_at: null,
      client_ip: null,
    });

    expect((await oauth.getOauthState(db, "nonce"))?.guild_id).toBe(SNOWFLAKE);

    await oauth.markOauthStateConsumed(db, "nonce", LATER);
    expect((await oauth.getOauthState(db, "nonce"))?.consumed_at).toBe(LATER);

    await oauth.updateOauthState(db, {
      state: "nonce",
      guild_id: SNOWFLAKE,
      created_at: NOW,
      expires_at: FUTURE,
      consumed_at: LATER,
      client_ip: null,
    });
    expect((await oauth.listOauthStatesForGuild(db, SNOWFLAKE)).length).toBe(1);

    await oauth.insertOauthState(db, {
      state: "stale",
      guild_id: SNOWFLAKE,
      created_at: PAST,
      expires_at: PAST,
      consumed_at: null,
      client_ip: null,
    });
    await oauth.deleteExpiredOauthStates(db, NOW);
    expect(await oauth.getOauthState(db, "stale")).toBeNull();

    await oauth.deleteOauthState(db, "nonce");
    expect(await oauth.getOauthState(db, "nonce")).toBeNull();
  });
});
