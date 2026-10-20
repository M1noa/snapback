// tests/services/export/records.test.ts
// the records export is a privacy contract, not a formatting exercise: the
// tokens are absent by construction, the ip comes out in the form the storage
// mode produced, and the csv says how to read it.
//
// a real temp-file duckdb and the real query modules, so the export is proved
// against the rows the database actually holds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertRecord } from "../../../src/db/queries/verify-records.ts";
import type { Database, VerifyRecordRow } from "../../../src/db/types.ts";
import {
  buildRecordsExport,
  recordsToCsv,
  recordsToJson,
} from "../../../src/services/export/records.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";

const GUILD = "1000000000000000001";
const OTHER_GUILD = "1000000000000000002";
const HASH_GUILD = "1000000000000000003";
const ENCRYPTED_GUILD = "1000000000000000004";
const PLAINTEXT_GUILD = "1000000000000000005";

const NOW = "2024-06-01T00:00:00.000Z";
const ISO = "2024-01-01T00:00:00.000Z";

// token values that cannot be mistaken for anything else in a row.
const ACCESS_TOKEN = "access-token-secret-value-0001";
const REFRESH_TOKEN = "refresh-token-secret-value-0002";

// a key that names a token is a leak. token_status is the state of the token,
// not the token, so it is the one key the rule lets through.
const TOKEN_KEY = /token/i;
const ALLOWED_KEYS = new Set(["token_status"]);
// the shape of an oauth token, for the value side of the same rule.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,}[.][A-Za-z0-9_-]{6}[.][A-Za-z0-9_-]{27,}$/;

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();

  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000a1",
      user_id: "1000000000000000100",
      username: "someone",
      email: "someone@example.test",
      connections_json: [{ id: "1", name: "octocat", type: "github", verified: true }],
      guilds_json: [{ id: "222222222222222222", name: "another guild" }],
      oauth_scopes_json: ["identify", "email"],
      country_code: "SE",
      country_name: "Sweden",
      isp: "an isp",
      as_org: "an as org",
      ip_type: "residential",
      fingerprint_json: { user_agent: "a browser" },
    }),
  );

  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000a2",
      user_id: "1000000000000000101",
      username: 'na,me"quoted"',
      email: null,
      email_verified: null,
      oauth_scopes_json: [],
      connections_json: [],
      guilds_json: [],
      fingerprint_json: null,
    }),
  );

  // a record of another guild: the export of one guild must not carry it.
  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000a3",
      guild_id: OTHER_GUILD,
      user_id: "1000000000000000102",
      username: "elsewhere",
    }),
  );

  // one record per mode, each holding the column that mode fills.
  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000b1",
      guild_id: HASH_GUILD,
      user_id: "1000000000000000200",
      last_ip_hash: "hashed-address-0001",
    }),
  );
  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000b2",
      guild_id: ENCRYPTED_GUILD,
      user_id: "1000000000000000201",
      last_ip_enc: "enc:v1:ciphertext-0002",
    }),
  );
  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000b3",
      guild_id: PLAINTEXT_GUILD,
      user_id: "1000000000000000202",
      last_ip_enc: "203.0.113.9",
    }),
  );

  // a record whose tokens are set: the export must not carry them.
  await upsertRecord(
    db,
    makeRecord({
      record_id: "0190a000-0000-7000-8000-0000000000c1",
      user_id: "1000000000000000300",
      username: "holder",
      access_token_enc: ACCESS_TOKEN,
      refresh_token_enc: REFRESH_TOKEN,
      token_expires_at: "2024-01-02T00:00:00.000Z",
      token_status: "valid",
    }),
  );
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function makeRecord(overrides: Partial<VerifyRecordRow> = {}): VerifyRecordRow {
  return {
    record_id: "0190a000-0000-7000-8000-0000000000a1",
    guild_id: GUILD,
    user_id: "1000000000000000100",
    username: "someone",
    global_name: "Some One",
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
    oauth_scopes_json: [],
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
    referrer: null,
    user_agent: null,
    revoked_at: null,
    notes: null,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
}

// visit every key and value of a parsed bundle.
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

// a csv reader for the test: a quoted cell may hold a comma, so a split is
// not enough. the comment line is not a row.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      if (!isComment(row)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (!isComment(row)) rows.push(row);
  }
  return rows;
}

function isComment(row: readonly string[]): boolean {
  return row[0]?.startsWith("#") ?? false;
}

describe("buildRecordsExport", () => {
  test("the bundle holds the guild's records and no other guild's", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    expect(bundle.guild_id).toBe(GUILD);
    expect(bundle.exported_at).toBe(NOW);
    expect(bundle.records.length).toBe(3);
    const users = bundle.records.map((row) => row.user_id);
    expect(users).toContain("1000000000000000100");
    expect(users).toContain("1000000000000000101");
    expect(users).toContain("1000000000000000300");
    expect(users).not.toContain("1000000000000000102");
  });

  test("a guild with no records is an empty list, never null", async () => {
    const bundle = await buildRecordsExport(db, "1000000000000000099", { now: () => NOW });
    expect(bundle.records).toEqual([]);
  });

  test("the header names the ip storage mode", async () => {
    const bundle = await buildRecordsExport(db, HASH_GUILD, {
      now: () => NOW,
      ipStorage: "hash",
    });
    expect(bundle.ip_storage).toBe("hash");
    expect(recordsToJson(bundle)).toContain('"ip_storage": "hash"');
  });
});

describe("the ip", () => {
  test("the hash mode exports the hash", async () => {
    const bundle = await buildRecordsExport(db, HASH_GUILD, {
      now: () => NOW,
      ipStorage: "hash",
    });
    expect(bundle.records[0]?.ip).toBe("hashed-address-0001");
  });

  test("the encrypted mode exports the ciphertext", async () => {
    const bundle = await buildRecordsExport(db, ENCRYPTED_GUILD, {
      now: () => NOW,
      ipStorage: "encrypted",
    });
    expect(bundle.records[0]?.ip).toBe("enc:v1:ciphertext-0002");
  });

  test("the plaintext mode exports the address as it was written", async () => {
    const bundle = await buildRecordsExport(db, PLAINTEXT_GUILD, {
      now: () => NOW,
      ipStorage: "plaintext",
    });
    expect(bundle.records[0]?.ip).toBe("203.0.113.9");
  });

  test("an address the mode did not sanction is not exported", async () => {
    // the plaintext address sits in the encrypted column, so the hash mode
    // reads the hash column and finds nothing. the address stays out.
    const bundle = await buildRecordsExport(db, PLAINTEXT_GUILD, {
      now: () => NOW,
      ipStorage: "hash",
    });
    expect(bundle.records[0]?.ip).toBeNull();
    expect(recordsToJson(bundle)).not.toContain("203.0.113.9");
  });
});

describe("no token", () => {
  test("neither the json nor the csv carries a token", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const json = recordsToJson(bundle);
    const csv = recordsToCsv(bundle);

    expect(json).not.toContain(ACCESS_TOKEN);
    expect(json).not.toContain(REFRESH_TOKEN);
    expect(csv).not.toContain(ACCESS_TOKEN);
    expect(csv).not.toContain(REFRESH_TOKEN);
  });

  test("no key names a token and no value looks like one", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const parsed: unknown = JSON.parse(recordsToJson(bundle));

    walk(parsed, (key, value) => {
      if (key !== null) {
        expect(ALLOWED_KEYS.has(key) || !TOKEN_KEY.test(key)).toBe(true);
      }
      if (typeof value === "string") {
        expect(TOKEN_KEY.test(value)).toBe(false);
        expect(TOKEN_SHAPE.test(value)).toBe(false);
      }
    });
  });
});

describe("the csv", () => {
  test("the header names every column of a record", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const rows = parseCsv(recordsToCsv(bundle));
    const header = rows[0] ?? [];
    const row = bundle.records[0];
    expect(row).toBeDefined();
    expect(header).toEqual(Object.keys(row ?? {}));
  });

  test("the multi-valued fields are semicolon-joined", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const rows = parseCsv(recordsToCsv(bundle));
    const header = rows[0] ?? [];
    const first = rows.slice(1).find((row) => row[header.indexOf("username")] === "someone") ?? [];
    const cell = (name: string): string => first[header.indexOf(name)] ?? "";

    expect(cell("scopes")).toBe("identify;email");
    expect(cell("connections")).toBe("github:octocat");
    expect(cell("guilds")).toBe("222222222222222222");
  });

  test("a value with a comma and a quote is quoted the csv way", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const csv = recordsToCsv(bundle);
    expect(csv).toContain('"na,me""quoted"""');

    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    const names = rows.slice(1).map((row) => row[header.indexOf("username")] ?? "");
    expect(names).toContain('na,me"quoted"');
  });

  test("a value that was never captured is an empty cell", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const rows = parseCsv(recordsToCsv(bundle));
    const header = rows[0] ?? [];
    const withoutEmail = rows
      .slice(1)
      .find((row) => row[header.indexOf("username")] === 'na,me"quoted"');
    expect(withoutEmail).toBeDefined();
    expect(withoutEmail?.[header.indexOf("email")]).toBe("");
  });

  test("the json and the csv agree on the row count", async () => {
    const bundle = await buildRecordsExport(db, GUILD, { now: () => NOW });
    const rows = parseCsv(recordsToCsv(bundle));
    // the header is one of the rows the parser sees.
    expect(rows.length - 1).toBe(bundle.records.length);
  });
});
