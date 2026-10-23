// tests/discord/commands/users.test.ts
//
// the /users surface: the commands, the pages they render, and the two rules
// that matter most here. an export carries no token and no bare address, and a
// record from another server is not reachable from this one.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerComponent } from "oceanic.js";
import type { VerifyRecordRow } from "../../../src/db/types.ts";
import {
  buildRecordsExport,
  buildTrackingExport,
  createExportDispatcher,
  createTrackingExportJobHandler,
  EVENTS_LIMIT,
  hasEvents,
  recordsExportToJson,
  trackingExportToJson,
  USERS_ACTION,
  USERS_OBJECT,
  USERS_SPECS,
  USERS_SURFACE,
  type UsersDeps,
  usersCustomId,
} from "../../../src/discord/commands/users/deps.ts";
import { registerUsersHandlers } from "../../../src/discord/commands/users/handlers.ts";
import { usersCommands } from "../../../src/discord/commands/users/index.ts";
import { countComponents, PAGE_LIMIT } from "../../../src/discord/components/page.ts";
import { parseCustomId, Router } from "../../../src/discord/interactions/router.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { EXPORT_TTL_MS } from "../../../src/services/export/job.ts";
import type { JobContext } from "../../../src/services/jobs/runner.ts";

const GUILD = "123456789012345678";
const OTHER_GUILD = "222222222222222222";
const USER = "987654321098765432";
const OWNER = "111111111111111111";
const AT = "2024-06-01T12:00:00.000Z";

function makeRecord(overrides: Partial<VerifyRecordRow> = {}): VerifyRecordRow {
  return {
    record_id: "0190a000-0000-7000-8000-0000000000d1",
    guild_id: GUILD,
    user_id: USER,
    username: "someone",
    global_name: "Some One",
    discriminator: "0",
    avatar_url: null,
    email: "someone@example.com",
    email_verified: true,
    locale: "en-GB",
    mfa_enabled: false,
    premium_type: 0,
    flags: 0,
    connections_json: null,
    guilds_json: null,
    relationships_json: null,
    oauth_scopes_json: ["identify", "email", "guilds.join"],
    oauth_granted_at: "2024-06-01T00:00:00.000Z",
    oauth_last_checked_at: null,
    access_token_enc: "ACCESS-TOKEN-CIPHERTEXT",
    refresh_token_enc: "REFRESH-TOKEN-CIPHERTEXT",
    token_expires_at: "2024-06-02T00:00:00.000Z",
    token_status: "valid",
    first_ip_hash: "sha256-of-the-address",
    first_ip_enc: null,
    last_ip_hash: "sha256-of-the-address",
    last_ip_enc: null,
    ip_history_json: [{ hash: "sha256-of-the-address", at: AT, event: "verify" }],
    country_code: "gb",
    country_name: "United Kingdom",
    city: null,
    region: null,
    isp: "an isp",
    asn: null,
    as_org: "an org",
    ip_type: "residential",
    is_vpn: false,
    is_proxy: false,
    is_tor: false,
    intel_checked_at: null,
    fingerprint_json: null,
    verify_status: "verified",
    refusal_reason: null,
    alt_match_json: null,
    referrer: null,
    user_agent: null,
    revoked_at: null,
    notes: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as VerifyRecordRow;
}

/** the jobs the surface queued, so a test can see what it asked for. */
interface FakeHarness {
  readonly enqueued: { kind: string; payload: unknown }[];
}

/**
 * the rows a guild_blacklist query would return. the fake knows the three
 * shapes the query module uses: the whole list of a guild, one entry, and a
 * list of values to look for.
 */
function blacklistMatch(
  sql: string,
  params: unknown[] | undefined,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const [guildId, kind, ...rest] = params ?? [];
  const forGuild = rows.filter((row) => row.guild_id === guildId);
  if (!sql.includes("kind = ?")) return forGuild;
  const forKind = forGuild.filter((row) => row.kind === kind);
  return sql.includes("value IN")
    ? forKind.filter((row) => rest.includes(row.value))
    : forKind.filter((row) => row.value === rest[0]);
}

function fakeDeps(
  overrides: Partial<UsersDeps> = {},
  harness: FakeHarness = { enqueued: [] },
): UsersDeps {
  const records = [makeRecord()];
  const jobRows: Record<string, unknown>[] = [];
  const blacklistRows: Record<string, unknown>[] = [];
  return {
    ownerId: OWNER,
    db: {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM jobs")) return jobRows;
        if (sql.includes("FROM guild_blacklist")) {
          return blacklistMatch(sql, params, blacklistRows);
        }
        return [];
      },
      run: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO guild_blacklist")) {
          blacklistRows.push({
            guild_id: params?.[0],
            kind: params?.[1],
            value: params?.[2],
            added_by: params?.[3],
            added_at: params?.[4],
            reason: params?.[5],
          });
        }
        if (sql.includes("DELETE FROM guild_blacklist")) {
          const index = blacklistRows.findIndex(
            (row) =>
              row.guild_id === params?.[0] && row.kind === params?.[1] && row.value === params?.[2],
          );
          if (index >= 0) blacklistRows.splice(index, 1);
        }
      },
    } as unknown as UsersDeps["db"],
    log: createLogger({ level: "error", dir: null }),
    jobs: {
      enqueue: async (kind: string, input: { guildId: string; payload?: unknown }) => {
        harness.enqueued.push({ kind, payload: input.payload });
        jobRows.push({
          id: `job-${harness.enqueued.length}`,
          guild_id: input.guildId,
          kind,
          status: "queued",
          requested_by: OWNER,
          payload_json: JSON.stringify(input.payload ?? null),
          progress_json: null,
          error_code: null,
          error_body: null,
          created_at: AT,
          started_at: null,
          finished_at: null,
          attempts: 0,
        });
        return { id: `job-${harness.enqueued.length}` };
      },
      eta: async () => null,
    } as unknown as UsersDeps["jobs"],
    now: () => Date.parse(AT),
    ipStorage: "hash",
    exportDir: "/tmp/snapback-users-test",
    authorize: async () => true,
    audit: async () => {},
    records: async (guildId) => records.filter((row) => row.guild_id === guildId),
    record: async (guildId, userId) =>
      records.find((row) => row.guild_id === guildId && row.user_id === userId) ?? null,
    member: async () => ({ state: "member", nickname: null, joinedAt: null }),
    // off unless a test hands one in. null is the switch-off shape.
    tracking: null,
    ...overrides,
  };
}

/** the smallest job context a handler reads: the row's payload and a logger. */
function jobContext(
  payload: Record<string, unknown> | null,
  requestedBy: string = OWNER,
): JobContext {
  return {
    job: {
      id: "job-1",
      guild_id: GUILD,
      kind: "export",
      status: "running",
      requested_by: requestedBy,
      payload_json: payload,
      progress_json: null,
      error_code: null,
      error_body: null,
      created_at: AT,
      started_at: AT,
      finished_at: null,
      attempts: 1,
    },
    signal: { cancelled: false, paused: false },
    log: createLogger({ level: "error", dir: null }),
    checkpoint: async () => {},
  };
}

function walk(node: unknown, visit: (n: { customID?: string }) => void): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { customID?: string; components?: unknown[] };
  visit(record);
  if (Array.isArray(record.components)) for (const child of record.components) walk(child, visit);
}

describe("the /users command group", () => {
  test("every documented subcommand is registered, once", () => {
    const names = usersCommands(fakeDeps())
      .map((command) => command.subcommand)
      .sort();
    expect(names).toEqual(["blacklist", "export", "lookup"]);
  });

  test("every page the group renders stays inside the component budget", async () => {
    const commands = usersCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: OWNER,
        options: { user: USER, scope: "records" },
      });
      expect(countComponents(result.page as ContainerComponent)).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  test("every id a page produces parses as a users control", async () => {
    const commands = usersCommands(fakeDeps());
    for (const command of commands) {
      const result = await command.run({
        guildId: GUILD,
        userId: OWNER,
        options: { user: USER, scope: "records" },
      });
      const ids: string[] = [];
      walk(result.page, (node) => {
        if (typeof node.customID === "string") ids.push(node.customID);
      });
      for (const produced of ids) {
        const parsed = parseCustomId(produced);
        expect(parsed?.surface).toBe(USERS_SURFACE);
        expect(parsed?.guild).toBe(GUILD);
      }
    }
  });

  test("a person who is not an admin gets a refusal", async () => {
    const deps = fakeDeps({ authorize: async () => false });
    const lookup = usersCommands(deps).find((command) => command.subcommand === "lookup");
    const result = await lookup?.run({ guildId: GUILD, userId: USER, options: { user: USER } });
    expect(JSON.stringify(result?.page)).toContain("snapback admins");
  });
});

describe("the export", () => {
  test("it carries no token and no bare address", () => {
    const bundle = buildRecordsExport([makeRecord()], "hash", GUILD, AT);
    const json = recordsExportToJson(bundle);

    expect(json).not.toContain("ACCESS-TOKEN-CIPHERTEXT");
    expect(json).not.toContain("REFRESH-TOKEN-CIPHERTEXT");
    expect(json).not.toContain("access_token");
    expect(json).not.toContain("refresh_token");
    expect(json).not.toContain("203.0.113.7");
    // the hash the mode produced is what the file holds.
    expect(json).toContain("sha256-of-the-address");
  });

  test("the address is written in the form the storage mode produced", () => {
    const record = makeRecord({
      first_ip_hash: "sha256-of-the-address",
      first_ip_enc: "203.0.113.7",
      last_ip_hash: "sha256-of-the-address",
      last_ip_enc: "203.0.113.7",
    });

    const hashed = recordsExportToJson(buildRecordsExport([record], "hash", GUILD, AT));
    expect(hashed).not.toContain("203.0.113.7");
    expect(hashed).toContain("sha256-of-the-address");
    expect(hashed).toContain('"ip_storage": "hash"');

    const plain = recordsExportToJson(buildRecordsExport([record], "plaintext", GUILD, AT));
    expect(plain).toContain("203.0.113.7");
    expect(plain).toContain('"ip_storage": "plaintext"');
  });

  test("writing it out is a job, not an inline write", async () => {
    const harness: FakeHarness = { enqueued: [] };
    const deps = fakeDeps({}, harness);
    const exportCommand = usersCommands(deps).find((command) => command.subcommand === "export");
    await exportCommand?.run({ guildId: GUILD, userId: OWNER, options: { scope: "records" } });

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]?.kind).toBe("export");
    const payload = harness.enqueued[0]?.payload as { scope?: string };
    expect(payload.scope).toBe("records");
  });

  test("the kind the job lands on reads the scope and picks the handler", async () => {
    const calls: string[] = [];
    const handler = createExportDispatcher({
      backup: async () => void calls.push("backup"),
      records: async () => void calls.push("records"),
      tracking: async () => void calls.push("tracking"),
    });

    // the payload /users export enqueues must reach the records writer, not the
    // backup writer, which would throw SB_EXPORT_NO_BACKUP on it. the timeline
    // scopes must not fall through to the backup writer either.
    await handler(jobContext({ scope: "records", guildId: GUILD, fromUserId: "" }));
    await handler(jobContext({ scope: "tracking_user", guildId: GUILD, subjectId: USER }));
    await handler(jobContext({ scope: "tracking_server", guildId: GUILD }));
    await handler(jobContext({ scope: "tracking_all", guildId: GUILD }));
    await handler(jobContext({ backupId: "0190a000-0000-7000-8000-0000000000b1" }));
    await handler(jobContext(null));

    expect(calls).toEqual(["records", "tracking", "tracking", "tracking", "backup", "backup"]);
  });

  test("the owner may write every server's timeline at once", async () => {
    const harness: FakeHarness = { enqueued: [] };
    const deps = fakeDeps({ db: timelineDb([eventRow()]).db }, harness);
    const exportCommand = usersCommands(deps).find((command) => command.subcommand === "export");
    await exportCommand?.run({ guildId: GUILD, userId: OWNER, options: { scope: "tracking_all" } });

    expect(harness.enqueued).toHaveLength(1);
    const payload = harness.enqueued[0]?.payload as { scope?: string };
    expect(payload.scope).toBe("tracking_all");
  });

  test("a guild admin may not", async () => {
    const harness: FakeHarness = { enqueued: [] };
    const deps = fakeDeps({ ownerId: OWNER, db: timelineDb([eventRow()]).db }, harness);
    const exportCommand = usersCommands(deps).find((command) => command.subcommand === "export");
    const result = await exportCommand?.run({
      guildId: GUILD,
      userId: USER,
      options: { scope: "tracking_all" },
    });

    expect(JSON.stringify(result?.page)).toContain("instance owner");
    // refused before a job, so there is nothing queued for the worker to pick up.
    expect(harness.enqueued).toHaveLength(0);
  });
});

describe("the record picker", () => {
  test("opens the record it names", async () => {
    const deps = fakeDeps();
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, deps);

    const lookup = usersCommands(deps).find((command) => command.subcommand === "lookup");
    const result = await lookup?.run({ guildId: GUILD, userId: OWNER, options: { user: USER } });
    const ids: string[] = [];
    walk(result?.page, (node) => {
      if (typeof node.customID === "string") ids.push(node.customID);
    });
    const selectId = ids.find((id) => id.includes(`:${USERS_ACTION.open}:`));
    expect(selectId).toBeDefined();

    const messages: string[] = [];
    const outcome = await router.route(
      selectId!,
      { userId: OWNER, guildId: GUILD, isOwner: true },
      {
        reply: async (request) => {
          messages.push(JSON.stringify(request.message));
        },
        openModal: async () => {},
        values: { [selectId!]: [USER] },
        source: "component",
      },
    );
    expect(outcome.kind).toBe("handled");
    expect(messages.join("")).toContain("the record for someone");
  });
});

describe("a record from another server", () => {
  test("is not reachable from this one", async () => {
    const elsewhere = makeRecord({
      guild_id: OTHER_GUILD,
      username: "elsewhere",
      email: "elsewhere@example.com",
    });
    // both reads are scoped to the guild, the way the wiring scopes them.
    const deps = fakeDeps({
      records: async () => [elsewhere],
      record: async (guildId, userId) =>
        elsewhere.guild_id === guildId && elsewhere.user_id === userId ? elsewhere : null,
    });
    const lookup = usersCommands(deps).find((command) => command.subcommand === "lookup");
    const result = await lookup?.run({ guildId: GUILD, userId: OWNER, options: { user: USER } });

    const text = JSON.stringify(result?.page);
    expect(text).toContain("no such record");
    expect(text).not.toContain("elsewhere@example.com");
    expect(text).not.toContain("elsewhere");
  });
});

describe("the blacklist", () => {
  test("the page lists the entries", async () => {
    const deps = fakeDeps();
    const command = usersCommands(deps).find((item) => item.subcommand === "blacklist");

    const added = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "add", kind: "user_id", value: USER },
    });
    expect(JSON.stringify(added?.page)).toContain("added the user_id entry");

    const listed = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "list" },
    });
    const text = JSON.stringify(listed?.page);
    expect(text).toContain(USER);
    expect(text).toContain("not a ban");
  });

  test("adding one needs the kind and the value", async () => {
    const deps = fakeDeps();
    const command = usersCommands(deps).find((item) => item.subcommand === "blacklist");

    const withoutKind = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "add", value: USER },
    });
    expect(JSON.stringify(withoutKind?.page)).toContain("an entry needs a kind and a value");

    const withoutValue = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "add", kind: "user_id" },
    });
    expect(JSON.stringify(withoutValue?.page)).toContain("an entry needs a kind and a value");
  });

  test("an entry is removed", async () => {
    const deps = fakeDeps();
    const command = usersCommands(deps).find((item) => item.subcommand === "blacklist");
    await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "add", kind: "ip_hash", value: "sha256-of-an-address" },
    });

    const removed = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "remove", kind: "ip_hash", value: "sha256-of-an-address" },
    });
    expect(JSON.stringify(removed?.page)).toContain("removed the ip_hash entry");

    const listed = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "list" },
    });
    expect(JSON.stringify(listed?.page)).not.toContain("sha256-of-an-address");
  });

  test("the page says that nothing is blocked on a match", async () => {
    const deps = fakeDeps();
    const command = usersCommands(deps).find((item) => item.subcommand === "blacklist");
    const listed = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "list" },
    });
    expect(JSON.stringify(listed?.page)).toContain("nothing is blocked on a match");
  });

  test("the page's button is handled", async () => {
    const deps = fakeDeps();
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, deps);
    const command = usersCommands(deps).find((item) => item.subcommand === "blacklist");
    const listed = await command?.run({
      guildId: GUILD,
      userId: OWNER,
      options: { action: "list" },
    });
    const ids: string[] = [];
    walk(listed?.page, (node) => {
      if (typeof node.customID === "string") ids.push(node.customID);
    });
    const refresh = ids.find((id) => id.includes(`:${USERS_OBJECT.blacklist}:`));
    expect(refresh).toBeDefined();

    const messages: string[] = [];
    const outcome = await router.route(
      refresh!,
      { userId: OWNER, guildId: GUILD, isOwner: true },
      {
        reply: async (request) => {
          messages.push(JSON.stringify(request.message));
        },
        openModal: async () => {},
        values: {},
        source: "component",
      },
    );
    expect(outcome.kind).toBe("handled");
    expect(messages.join("")).toContain("the blacklist of this server");
  });
});

describe("the boot assertion", () => {
  test("every spec has a handler, and every handler has a spec", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, fakeDeps());
    const registered = router.registeredKeys().filter((key) => key.startsWith(`${USERS_SURFACE}:`));
    expect(registered.sort()).toEqual(
      USERS_SPECS.map((spec) => `${spec.surface}:${spec.action}`).sort(),
    );
  });

  test("a gap in the surface fails the boot", () => {
    const router = new Router({ authorize: async () => ({ kind: "allow" }) });
    registerUsersHandlers(router, fakeDeps());
    expect(() =>
      router.assertComplete([...USERS_SPECS, { surface: USERS_SURFACE, action: "ghost" }]),
    ).toThrow();
  });
});

describe("the custom id builder", () => {
  test("the cursor slot is always written", () => {
    const id = usersCustomId({
      guildId: GUILD,
      object: USERS_OBJECT.record,
      action: USERS_ACTION.export,
    });
    expect(id.split(":")).toHaveLength(6);
    expect(parseCustomId(id)?.cursor).toBe("");
  });
});

// the timeline export. the same rules as the records export apply, plus one of
// its own: a file is read down the page, so it is written oldest first even
// though every query hands back the newest change first.

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "0190a000-0000-7000-8000-0000000000e1",
    guild_id: GUILD,
    subject_kind: "user",
    subject_id: USER,
    kind: "member_join",
    actor_id: null,
    source: "gateway",
    channel_id: null,
    before_json: null,
    after_json: JSON.stringify({ nickname: "before" }),
    detail_json: null,
    at: AT,
    recorded_at: AT,
    ...overrides,
  };
}

/** answers tracked_events reads and captures pending_exports writes. the json
 *  columns come back as text, because parseJson throws on anything else. */
function timelineDb(rows: readonly Record<string, unknown>[]): {
  db: UsersDeps["db"];
  inserted: unknown[][];
  limits: unknown[];
} {
  const inserted: unknown[][] = [];
  const limits: unknown[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (!sql.includes("FROM tracked_events")) return [];
      // the limit is the last bind of every read in the module
      const limit = params?.[params.length - 1];
      limits.push(limit);
      return typeof limit === "number" ? rows.slice(0, limit) : rows;
    },
    run: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO pending_exports")) inserted.push(params ?? []);
    },
  };
  return { db: db as unknown as UsersDeps["db"], inserted, limits };
}

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "sb-timeline-"));
}

describe("the timeline export", () => {
  test("events are written oldest first", () => {
    const rows = [
      eventRow({ event_id: "e3", at: "2024-06-03T00:00:00.000Z" }),
      eventRow({ event_id: "e2", at: "2024-06-02T00:00:00.000Z" }),
      eventRow({ event_id: "e1", at: "2024-06-01T00:00:00.000Z" }),
    ];
    const bundle = buildTrackingExport({
      scope: "tracking_server",
      subjectId: null,
      guildId: GUILD,
      events: rows as never,
      truncated: false,
      exportedAt: AT,
    });
    expect(bundle.events.map((event) => event.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(bundle.event_count).toBe(3);
  });

  test("an event carries the recorded fields and nothing else", () => {
    const bundle = buildTrackingExport({
      scope: "tracking_server",
      subjectId: null,
      guildId: GUILD,
      // buildTrackingExport takes rows the query layer already parsed
      events: [{ ...eventRow(), after_json: { nickname: "before" } }] as never,
      truncated: false,
      exportedAt: AT,
    });
    // the key set is the structural promise: no message text, no attachment,
    // nothing the row does not hold.
    expect(Object.keys(bundle.events[0]!).sort()).toEqual([
      "actor_id",
      "after",
      "at",
      "before",
      "channel_id",
      "detail",
      "event_id",
      "guild_id",
      "kind",
      "recorded_at",
      "source",
      "subject_id",
      "subject_kind",
    ]);
    expect(bundle.events[0]!.after).toEqual({ nickname: "before" });
    expect(bundle.events[0]!.before).toBeNull();
    expect(bundle.events[0]!.guild_id).toBe(GUILD);
  });

  test("a cut file says it was cut", () => {
    const complete = buildTrackingExport({
      scope: "tracking_user",
      subjectId: USER,
      guildId: GUILD,
      events: [eventRow()] as never,
      truncated: false,
      exportedAt: AT,
    });
    expect(complete.truncated).toBe(false);
    expect(complete.note).toContain("every event this server still holds");

    const cut = buildTrackingExport({
      scope: "tracking_user",
      subjectId: USER,
      guildId: GUILD,
      events: [eventRow()] as never,
      truncated: true,
      exportedAt: AT,
    });
    expect(cut.truncated).toBe(true);
    expect(cut.note).toContain("older events were left out");
    expect(cut.event_count).toBe(1);
  });

  test("the file is the bundle, indented, with a newline", () => {
    const bundle = buildTrackingExport({
      scope: "tracking_server",
      subjectId: null,
      guildId: GUILD,
      events: [eventRow()] as never,
      truncated: false,
      exportedAt: AT,
    });
    const json = trackingExportToJson(bundle);
    expect(json).toBe(`${JSON.stringify(bundle, null, 2)}\n`);
    expect(json.endsWith("}\n")).toBe(true);
  });

  test("the server job writes timeline-server.json and records it", async () => {
    const dir = await scratch();
    const { db, inserted } = timelineDb([eventRow()]);
    const handler = createTrackingExportJobHandler({
      db,
      exportDir: dir,
      now: () => Date.parse(AT),
      ownerId: OWNER,
    });
    try {
      await handler(jobContext({ scope: "tracking_server" }));
      const path = join(dir, GUILD, "timeline-server.json");
      const written = await readFile(path, "utf8");
      expect(JSON.parse(written).scope).toBe("tracking_server");
      expect(JSON.parse(written).subject_id).toBeNull();

      const [row] = inserted;
      expect(row?.[1]).toBe(GUILD);
      expect(row?.[2]).toBe("tracking_server");
      expect(JSON.parse(String(row?.[3]))).toEqual({
        subjectId: null,
        eventCount: 1,
        truncated: false,
      });
      expect(row?.[4]).toBe(path);
      expect(row?.[5]).toBe(Buffer.byteLength(written, "utf8"));
      expect(row?.[6]).toBe(AT);
      expect(row?.[7]).toBe(new Date(Date.parse(AT) + EXPORT_TTL_MS).toISOString());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a person's job writes timeline-user.json", async () => {
    const dir = await scratch();
    const { db, inserted } = timelineDb([eventRow()]);
    const handler = createTrackingExportJobHandler({
      db,
      exportDir: dir,
      now: () => Date.parse(AT),
      ownerId: OWNER,
    });
    try {
      await handler(jobContext({ scope: "tracking_user", subjectId: USER }));
      const path = join(dir, GUILD, "timeline-user.json");
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.scope).toBe("tracking_user");
      expect(written.subject_id).toBe(USER);
      expect(inserted[0]?.[2]).toBe("tracking_user");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a person's export that names nobody fails", async () => {
    const dir = await scratch();
    const { db, inserted } = timelineDb([]);
    const handler = createTrackingExportJobHandler({
      db,
      exportDir: dir,
      now: () => Date.parse(AT),
      ownerId: OWNER,
    });
    try {
      await expect(handler(jobContext({ scope: "tracking_user" }))).rejects.toThrow(
        /SB_EXPORT_NO_SUBJECT/,
      );
      expect(inserted).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("one row past the cap means the file was cut", async () => {
    const dir = await scratch();
    const rows = Array.from({ length: EVENTS_LIMIT + 1 }, (_unused, index) =>
      eventRow({ event_id: `e${index}` }),
    );
    const { db, inserted, limits } = timelineDb(rows);
    const handler = createTrackingExportJobHandler({
      db,
      exportDir: dir,
      now: () => Date.parse(AT),
      ownerId: OWNER,
    });
    try {
      await handler(jobContext({ scope: "tracking_server" }));
      // one row past the cap answers "is there more" without a second count
      expect(limits).toEqual([EVENTS_LIMIT + 1]);
      const written = JSON.parse(await readFile(join(dir, GUILD, "timeline-server.json"), "utf8"));
      expect(written.event_count).toBe(EVENTS_LIMIT);
      expect(written.events).toHaveLength(EVENTS_LIMIT);
      expect(written.truncated).toBe(true);
      expect(JSON.parse(String(inserted[0]?.[3])).truncated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the whole-instance job writes timeline-all.json with every guild's rows", async () => {
    const dir = await scratch();
    const { db, inserted } = timelineDb([
      eventRow({ event_id: "e1" }),
      eventRow({ event_id: "e2", guild_id: OTHER_GUILD }),
    ]);
    const handler = createTrackingExportJobHandler({
      db,
      exportDir: dir,
      now: () => Date.parse(AT),
      ownerId: OWNER,
    });
    try {
      await handler(jobContext({ scope: "tracking_all" }));
      // still the invoking guild's folder: a pending export row can only point there.
      const path = join(dir, GUILD, "timeline-all.json");
      const written = JSON.parse(await readFile(path, "utf8"));

      expect(written.scope).toBe("tracking_all");
      // the header names no guild, so the rows have to.
      expect(written.guild_id).toBeNull();
      expect(written.events.map((event: { guild_id: string }) => event.guild_id).sort()).toEqual([
        GUILD,
        OTHER_GUILD,
      ]);
      expect(written.note).toContain("the guild is named on each row");
      expect(inserted[0]?.[1]).toBe(GUILD);
      expect(inserted[0]?.[2]).toBe("tracking_all");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the job refuses the whole-instance file to anyone but the owner", async () => {
    const dir = await scratch();
    const { db, inserted } = timelineDb([eventRow()]);
    const handler = createTrackingExportJobHandler({
      db,
      exportDir: dir,
      now: () => Date.parse(AT),
      ownerId: OWNER,
    });
    try {
      // the command already refused this. the row outlives the interaction, so the
      // job checks the person on the row too.
      await expect(handler(jobContext({ scope: "tracking_all" }, USER))).rejects.toThrow(
        /SB_EXPORT_NOT_OWNER/,
      );
      expect(inserted).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hasEvents costs a page of one", async () => {
    const { db, limits } = timelineDb([eventRow()]);
    expect(await hasEvents(db as never, GUILD, null)).toBe(true);
    expect(limits).toEqual([1]);

    const empty = timelineDb([]);
    expect(await hasEvents(empty.db as never, GUILD, USER)).toBe(false);
    expect(empty.limits).toEqual([1]);
  });
});
