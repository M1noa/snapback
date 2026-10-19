// tests/services/backup/round-trip.test.ts
//
// the round trip (D4TODO phase 12): a capture, then a restore, and a comparison
// of what came out with what went in.
//
// the differences are the point. a restore cannot bring back the message ids, the
// timestamps or the author's identity, and the test says so by name rather than
// by leaving a reader to guess which difference is a bug.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listBackupChannelsByBackup } from "../../../src/db/queries/backup-channels.ts";
import { listBackupMessagesByBackup } from "../../../src/db/queries/backup-messages.ts";
import { listBackupRolesByBackup } from "../../../src/db/queries/backup-roles.ts";
import type { Database } from "../../../src/db/types.ts";
import { captureChannels } from "../../../src/services/backup/channels.ts";
import { captureMembers } from "../../../src/services/backup/members.ts";
import { captureMessages } from "../../../src/services/backup/messages.ts";
import { captureRoles } from "../../../src/services/backup/roles.ts";
import { createSkipList } from "../../../src/services/backup/types.ts";
import { restoreCategories, restoreChannels } from "../../../src/services/restore/channels.ts";
import { restoreMembers } from "../../../src/services/restore/members.ts";
import { restoreMessages } from "../../../src/services/restore/messages.ts";
import { restoreRoles } from "../../../src/services/restore/roles.ts";
import {
  createRestoreMaps,
  DEFAULT_RESTORE_OPTIONS,
  type RestoreContext,
} from "../../../src/services/restore/types.ts";
import { closeFixtureDb, openFixtureDb } from "../../fixtures/db.ts";
import { makeGuild, makeSettings, restStub } from "../../fixtures/guild.ts";

const SOURCE_GUILD = "1000000000000000001";
const TARGET_GUILD = "2000000000000000001";
const BACKUP = "round-trip";

let db: Database;

beforeAll(async () => {
  db = await openFixtureDb();
});

afterAll(async () => {
  await closeFixtureDb(db);
});

const log = {
  level: "error" as const,
  debug() {},
  info() {},
  warn() {},
  error() {},
  async flush() {},
};

/** what the target guild ended up holding, recorded from the calls the restore made. */
interface TargetState {
  readonly roles: { name: string; position: number; permissions: string }[];
  readonly channels: { name: string; type: number; parent: string | null }[];
  readonly overwrites: { channel: string; target: string; allow: string }[];
  readonly memberRoles: Map<string, string[]>;
  readonly messages: { channel: string; content: string; username: string }[];
  readonly bans: string[];
}

function recordingClient(): { client: RestoreContext["client"]; state: TargetState } {
  const state: TargetState = {
    roles: [],
    channels: [],
    overwrites: [],
    memberRoles: new Map(),
    messages: [],
    bans: [],
  };
  let nextId = 900;
  const id = (): string => `9${String(nextId++).padStart(17, "0")}`;

  const client = {
    async request(options: { method: string; route: string; body?: unknown }): Promise<unknown> {
      const { method, route, body } = options;
      const path = route.split("?")[0] ?? route;

      if (method === "GET" && path === `/guilds/${TARGET_GUILD}/roles`) return [];
      if (method === "GET" && path === `/guilds/${TARGET_GUILD}`) {
        return { id: TARGET_GUILD, features: ["ROLE_ICONS"], premium_tier: 0 };
      }
      if (method === "GET" && path === `/guilds/${TARGET_GUILD}/channels`) return [];
      if (method === "GET" && path === `/guilds/${TARGET_GUILD}/members`) return [];
      if (method === "POST" && path === `/guilds/${TARGET_GUILD}/roles`) {
        const sent = body as { name: string; position?: number; permissions: string };
        state.roles.push({
          name: sent.name,
          position: sent.position ?? 0,
          permissions: sent.permissions,
        });
        return {
          id: id(),
          name: sent.name,
          position: sent.position ?? 0,
          permissions: sent.permissions,
        };
      }
      if (method === "PATCH" && path === `/guilds/${TARGET_GUILD}/roles`) {
        for (const entry of body as { id: string; position: number }[]) {
          const found = state.roles.find((role) => role.name === entry.id);
          if (found !== undefined) found.position = entry.position;
        }
        return [];
      }
      if (method === "POST" && path === `/guilds/${TARGET_GUILD}/channels`) {
        const sent = body as { name: string; type: number; parent_id?: string | null };
        state.channels.push({
          name: sent.name,
          type: sent.type,
          parent: sent.parent_id ?? null,
        });
        return { id: id(), name: sent.name, type: sent.type, parent_id: sent.parent_id ?? null };
      }
      if (method === "PUT" && path.includes("/permissions/")) {
        const parts = path.split("/");
        state.overwrites.push({
          channel: parts[4] ?? "",
          target: parts[6] ?? "",
          allow: (body as { allow: string }).allow,
        });
        return {};
      }
      if (method === "GET" && path === `/guilds/${TARGET_GUILD}/members`) {
        return [];
      }
      if (method === "PATCH" && path.startsWith(`/guilds/${TARGET_GUILD}/members/`)) {
        state.memberRoles.set(
          path.split("/").pop() ?? "",
          (body as { roles?: string[] }).roles ?? [],
        );
        return {};
      }
      if (method === "PUT" && path.startsWith(`/guilds/${TARGET_GUILD}/bans/`)) {
        state.bans.push(path.split("/").pop() ?? "");
        return {};
      }
      if (method === "POST" && path.endsWith("/webhooks")) {
        return { id: id(), token: "a-webhook-token" };
      }
      if (method === "POST" && path.startsWith("/webhooks/")) {
        const sent = body as { content: string; username?: string };
        state.messages.push({
          channel: "unknown",
          content: sent.content,
          username: sent.username ?? "",
        });
        return { id: id() };
      }
      if (method === "DELETE" && path.startsWith("/webhooks/")) return {};
      return {};
    },
  };

  return { client: client as unknown as RestoreContext["client"], state };
}

describe("the round trip", () => {
  test("what the capture took and what the restore made back, with the differences named", async () => {
    const guild = makeGuild();
    const stub = restStub(guild);
    const skips = createSkipList();

    // the capture, into a real database.
    const captureCtx = {
      db,
      client: stub.client,
      log,
      backupId: BACKUP,
      guildId: SOURCE_GUILD,
      settings: makeSettings(),
      limits: { maxMessagesPerChannel: 1000, maxMessagesTotal: 10_000 },
      maps: createRestoreMaps(),
      sourceGuildId: SOURCE_GUILD,
      backupDir: "/tmp/snapback-round-trip",
      signal: { cancelled: false, paused: false },
      checkpoint: async () => {},
      note: () => {},
      now: () => "2024-06-01T00:00:00.000Z",
      assets: { dir: "/tmp", save: async () => null, pathFor: () => "" },
      skips,
    };
    await captureRoles(captureCtx as never);
    await captureMembers(captureCtx as never);
    await captureChannels(captureCtx as never);
    await captureMessages(captureCtx as never);

    const roles = await listBackupRolesByBackup(db, BACKUP);
    const channels = await listBackupChannelsByBackup(db, BACKUP);
    const messages = await listBackupMessagesByBackup(db, BACKUP);
    expect(roles.length).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(0);

    // the restore, into a target that records what it was told to do.
    const { client, state } = recordingClient();
    const notes: { what: string; why: string }[] = [];
    const restoreCtx: RestoreContext = {
      db,
      client,
      log,
      backupId: BACKUP,
      targetGuildId: TARGET_GUILD,
      options: DEFAULT_RESTORE_OPTIONS,
      maps: createRestoreMaps(),
      sourceGuildId: SOURCE_GUILD,
      backupDir: "/tmp/snapback-round-trip",
      signal: { cancelled: false, paused: false },
      checkpoint: async () => {},
      note: (what, why) => {
        notes.push({ what, why });
      },
      now: () => "2024-06-01T00:00:00.000Z",
    };
    await restoreRoles(restoreCtx);
    await restoreCategories(restoreCtx);
    await restoreChannels(restoreCtx);
    await restoreMembers(restoreCtx);
    await restoreMessages(restoreCtx);

    // the roles came back, with their names and their order.
    //
    // the one that did not come back is the bot-managed role, and that is a
    // known difference rather than a bug: discord will not let a bot create a
    // role an integration owns, so the restore reports it instead of trying.
    const sourceRoles = roles
      .filter((role) => !role.is_everyone && !role.is_bot_managed)
      .map((role) => role.name)
      .sort();
    const targetRoles = state.roles.map((role) => role.name).sort();
    expect(targetRoles).toEqual(sourceRoles);

    const managed = roles.filter((role) => role.is_bot_managed);
    for (const role of managed) {
      expect(state.roles.some((created) => created.name === role.name)).toBe(false);
      expect(
        notes.some((note) => note.what.includes(role.name) || note.why.includes("integration")),
      ).toBe(true);
    }

    // the channels came back, categories first.
    expect(state.channels.length).toBe(channels.length);
    const categoryIndex = state.channels.findIndex((channel) => channel.type === 4);
    const childIndex = state.channels.findIndex((channel) => channel.type === 0);
    expect(categoryIndex).toBeLessThan(childIndex);

    // the messages came back with their content.
    const posted = state.messages.map((message) => message.content).sort();
    const captured = messages.map((message) => message.content ?? "").sort();
    expect(posted).toEqual(captured);

    // the known differences, named rather than left to a reader to guess:
    //   - the message ids are new, so a reply cannot point at its parent
    //   - the timestamps are the restore's, because discord stamps them
    //   - the author is the webhook, not the person
    const ids = new Set(state.messages.map((message) => message.content));
    expect(ids.size).toBe(messages.length);
  });
});
