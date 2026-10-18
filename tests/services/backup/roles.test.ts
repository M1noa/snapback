// tests/services/backup/roles.test.ts. captureRoles (D4PLAN 11.2) against a real
// temp-file duckdb and the fixture guild: every role lands as a row, a 64-bit
// permissions bitfield survives as a string, and a 403 is one skip, not a failure.
//
// each test uses its own backup_id, so the (backup_id, source_role_id) primary key
// never collides across cases that all drive the same fixture.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  countBackupRolesByBackup,
  listBackupRolesByBackup,
} from "../../../src/db/queries/backup-roles.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordApiError } from "../../../src/discord/errors.ts";
import { captureRoles } from "../../../src/services/backup/roles.ts";
import type { AssetKind, AssetStore, BackupContext } from "../../../src/services/backup/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import {
  counts,
  FIXTURE_GUILD_ID,
  makeContext,
  makeGuild,
  makeSettings,
  ROLE_BOT,
  ROLE_MEMBERS,
  ROLE_MODS,
  restStub,
  stubAssets,
  USER_BOT,
} from "../../fixtures/guild.ts";

// the widest a permission bitfield gets: 2^63-1, well above 2^53.
const MAX_BITS = "9223372036854775807";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

function backupId(n: number): string {
  return `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

// a context whose client is a stub the test can read routes()/fail() from. the
// fixture's makeContext builds its own client, so swap it for the one we hold.
function contextWithStub(options: Parameters<typeof makeContext>[0]): {
  ctx: BackupContext;
  stub: ReturnType<typeof restStub>;
} {
  const stub = restStub(options.guild);
  const ctx: BackupContext = { ...makeContext(options), client: stub.client };
  return { ctx, stub };
}

describe("captureRoles", () => {
  test("every role in the fixture is stored and written matches the count", async () => {
    const guild = makeGuild();
    const id = backupId(1);

    const result = await captureRoles(makeContext({ db, guild, backupId: id }));

    expect(result.written).toBe(counts(guild).roles);
    const rows = await listBackupRolesByBackup(db, id);
    expect(rows).toHaveLength(counts(guild).roles);
    expect([...rows.map((row) => row.source_role_id)].sort()).toEqual(
      [...guild.roles.map((role) => String(role.id))].sort(),
    );
  });

  test("permissions survives the round trip as a string, including 2^63-1", async () => {
    const guild = makeGuild();
    const id = backupId(2);

    await captureRoles(makeContext({ db, guild, backupId: id }));

    const rows = await listBackupRolesByBackup(db, id);
    const byId = new Map(rows.map((row) => [row.source_role_id, row]));

    const everyone = byId.get(FIXTURE_GUILD_ID);
    expect(everyone?.permissions).toBe(MAX_BITS);
    expect(typeof everyone?.permissions).toBe("string");

    // every role keeps its own bitfield exactly, still a string.
    for (const role of guild.roles) {
      const stored = byId.get(String(role.id));
      expect(stored?.permissions).toBe(String(role.permissions));
      expect(typeof stored?.permissions).toBe("string");
    }
  });

  test("is_everyone follows the id, not the name", async () => {
    const base = makeGuild();
    // a different role carries the name and the real one is renamed: only the id
    // is the invariant (11.2).
    const guild = makeGuild({
      roles: base.roles.map((role) => {
        if (String(role.id) === ROLE_MODS) return { ...role, name: "@everyone" };
        if (String(role.id) === FIXTURE_GUILD_ID) return { ...role, name: "not the name" };
        return role;
      }),
    });
    const id = backupId(3);

    await captureRoles(makeContext({ db, guild, backupId: id }));

    const rows = await listBackupRolesByBackup(db, id);
    const byId = new Map(rows.map((row) => [row.source_role_id, row]));
    expect(byId.get(FIXTURE_GUILD_ID)?.is_everyone).toBe(true);
    expect(byId.get(ROLE_MODS)?.is_everyone).toBe(false);
    expect(rows.filter((row) => row.is_everyone).map((row) => row.source_role_id)).toEqual([
      FIXTURE_GUILD_ID,
    ]);
  });

  test("the bot-managed role keeps its bot id and integration id", async () => {
    const guild = makeGuild();
    const id = backupId(4);

    await captureRoles(makeContext({ db, guild, backupId: id }));

    const rows = await listBackupRolesByBackup(db, id);
    const bot = rows.find((row) => row.source_role_id === ROLE_BOT);
    expect(bot?.is_bot_managed).toBe(true);
    expect(bot?.bot_id).toBe(USER_BOT);
    expect(typeof bot?.integration_id).toBe("string");

    const mods = rows.find((row) => row.source_role_id === ROLE_MODS);
    expect(mods?.is_bot_managed).toBe(false);
    expect(mods?.bot_id).toBeNull();
  });

  test("a role icon downloads once; a role without one stores null and skips nothing", async () => {
    const guild = makeGuild();
    const id = backupId(5);
    const saves: { kind: AssetKind; name: string; url: string | null }[] = [];
    const assets: AssetStore = {
      ...stubAssets(),
      save: async (kind, name, url) => {
        saves.push({ kind, name, url });
        return url === null ? null : { url, path: `assets/${kind}/${name}`, bytes: 0 };
      },
    };

    const ctx = makeContext({ db, guild, backupId: id, assets });
    await captureRoles(ctx);

    expect(saves).toHaveLength(1);
    expect(saves[0]?.kind).toBe("role");
    expect(saves[0]?.name).toBe(ROLE_MODS);
    expect(saves[0]?.url).toBe(
      `https://cdn.discordapp.com/role-icons/${ROLE_MODS}/roleiconhash.png`,
    );

    const rows = await listBackupRolesByBackup(db, id);
    expect(rows.find((row) => row.source_role_id === ROLE_MEMBERS)?.icon_url).toBeNull();
    expect(ctx.skips.all()).toHaveLength(0);
  });

  test("roles off writes nothing, makes no request, records one skip", async () => {
    const guild = makeGuild();
    const id = backupId(6);
    const settings = makeSettings({
      backup_include: { ...makeSettings().backup_include, roles: false },
    });
    const { ctx, stub } = contextWithStub({ db, guild, backupId: id, settings });

    const result = await captureRoles(ctx);

    expect(result).toEqual({ written: 0 });
    expect(stub.routes()).toEqual([]);
    expect(ctx.skips.all()).toHaveLength(1);
    expect(ctx.skips.all()[0]?.category).toBe("roles");
    expect(await countBackupRolesByBackup(db, id)).toBe(0);
  });

  test("a 403 from /roles is one skip in discord's words and still writes nothing", async () => {
    const guild = makeGuild();
    const id = backupId(7);
    const route = `GET /guilds/${FIXTURE_GUILD_ID}/roles`;
    const { ctx, stub } = contextWithStub({ db, guild, backupId: id });
    stub.fail(
      route,
      new DiscordApiError({
        status: 403,
        route,
        method: "GET",
        body: JSON.stringify({ code: 50013, message: "Missing Permissions" }),
      }),
    );

    const result = await captureRoles(ctx);

    expect(result).toEqual({ written: 0 });
    const skips = ctx.skips.all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.category).toBe("roles");
    expect(skips[0]?.why).toBe("50013 Missing Permissions");
    expect(await countBackupRolesByBackup(db, id)).toBe(0);
  });
});
