import { describe, expect, test } from "bun:test";
import type { Client } from "oceanic.js";
import { attachHandlers } from "../../../src/services/tracking/attach.ts";
import type { TrackInput, TrackingService } from "../../../src/services/tracking/index.ts";

type Handler = (...args: unknown[]) => unknown;

function harness() {
  const rows: TrackInput[] = [];
  const failures: { handler: string; error: unknown }[] = [];
  const handlers = new Map<string, Handler>();

  const tracking = {
    record: async (input: TrackInput) => {
      rows.push(input);
      return true;
    },
    recordAll: async (inputs: readonly TrackInput[]) => {
      rows.push(...inputs);
    },
    reportFailure: (handler: string, error: unknown) => {
      failures.push({ handler, error });
    },
  } as unknown as TrackingService;

  const client = {
    on: (event: string, listener: Handler) => handlers.set(event, listener),
  } as unknown as Client;

  attachHandlers(client, tracking);

  // the guard detaches the promise, so give the microtask queue a turn.
  const fire = async (event: string, ...args: unknown[]): Promise<void> => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no listener for ${event}`);
    handler(...args);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const emitted = () => [...handlers.keys()].sort();

  return { rows, failures, fire, emitted };
}

const member = (over: Record<string, unknown> = {}) => ({
  guildID: "1",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  roles: [],
  user: { id: "9", username: "mina", bot: false },
  ...over,
});

const voice = (over: Record<string, unknown> = {}) => ({
  channelID: "c1",
  selfMute: false,
  selfDeaf: false,
  selfStream: false,
  selfVideo: false,
  mute: false,
  deaf: false,
  suppress: false,
  ...over,
});

describe("attach wires every listener", () => {
  test("all nineteen events are registered", () => {
    const { emitted } = harness();
    expect(emitted()).toEqual(
      [
        "channelCreate",
        "channelDelete",
        "channelUpdate",
        "guildBanAdd",
        "guildBanRemove",
        "guildEmojisUpdate",
        "guildMemberAdd",
        "guildMemberRemove",
        "guildMemberUpdate",
        "guildRoleCreate",
        "guildRoleDelete",
        "guildRoleUpdate",
        "guildStickersUpdate",
        "guildUpdate",
        "messageDelete",
        "messageUpdate",
        "threadCreate",
        "threadDelete",
        "voiceStateUpdate",
      ].sort(),
    );
  });
});

describe("members", () => {
  test("a join takes discord's join time and separates bots", async () => {
    const { rows, fire } = harness();
    await fire("guildMemberAdd", member());
    await fire("guildMemberAdd", member({ user: { id: "8", username: "b", bot: true } }));
    expect(rows.map((row) => row.kind)).toEqual(["member_join", "bot_join"]);
    expect(rows[0]?.at).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[0]?.subjectId).toBe("9");
  });

  test("a profile edit fans out into one row per changed field", async () => {
    const { rows, fire } = harness();
    const before = member({ nick: "old", roles: ["a"] });
    const after = member({ nick: "new", roles: ["a", "b"] });
    await fire("guildMemberUpdate", after, before);
    expect(rows.map((row) => row.kind)).toEqual(["member_nickname", "member_roles"]);
    expect(rows[1]?.detail).toEqual({ added: ["b"], removed: [] });
  });

  test("a leave keeps the last known state and survives an uncached member", async () => {
    const { rows, fire } = harness();
    await fire("guildMemberRemove", member({ nick: "gone" }), { id: "1" });
    await fire("guildMemberRemove", { guildID: "1", id: "7" }, { id: "1" });
    expect(rows.map((row) => row.kind)).toEqual(["member_leave", "member_leave"]);
    expect(rows[0]?.before).toMatchObject({ nickname: "gone" });
    expect(rows[1]?.subjectId).toBe("7");
  });
});

describe("voice", () => {
  test("join, move and leave read as distinct kinds", async () => {
    const { rows, fire } = harness();
    await fire("voiceStateUpdate", member({ voiceState: voice() }), null);
    await fire("voiceStateUpdate", member({ voiceState: voice({ channelID: "c2" }) }), voice());
    const idle = member({ voiceState: voice({ channelID: null }) });
    await fire("voiceStateUpdate", idle, voice({ channelID: "c2" }));
    expect(rows.map((row) => row.kind)).toEqual(["voice_join", "voice_move", "voice_leave"]);
    expect(rows[1]?.before).toEqual({ channelID: "c1" });
    expect(rows[1]?.after).toEqual({ channelID: "c2" });
    expect(rows[2]?.channelId).toBe("c2");
  });

  test("a flag change records only the flags that moved", async () => {
    const { rows, fire } = harness();
    const before = voice({ selfMute: false, selfStream: false });
    const after = voice({ selfMute: true, selfStream: true });
    await fire("voiceStateUpdate", member({ voiceState: after }), before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("voice_state");
    expect(rows[0]?.before).toEqual({ selfMute: false, selfStream: false });
    expect(rows[0]?.after).toEqual({ selfMute: true, selfStream: true });
  });

  test("an unchanged state writes nothing", async () => {
    const { rows, fire } = harness();
    await fire("voiceStateUpdate", member({ voiceState: voice() }), voice());
    expect(rows).toEqual([]);
  });
});

describe("messages never carry content", () => {
  test("a delete stores a length, never the text", async () => {
    const { rows, fire } = harness();
    await fire("messageDelete", {
      id: "m1",
      guildID: "1",
      channelID: "c1",
      content: "the secret plan",
      author: { id: "9", bot: false },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("secret");
    expect(rows[0]?.detail).toEqual({
      message_id: "m1",
      author_id: "9",
      bot: false,
      content_length: 15,
    });
    expect(rows[0]?.kind).toBe("message_delete");
  });

  test("an embed refresh is not an edit", async () => {
    const { rows, fire } = harness();
    const edited = new Date("2026-02-01T00:00:00.000Z");
    await fire(
      "messageUpdate",
      { id: "m1", guildID: "1", channelID: "c1", content: "hi", editedTimestamp: edited },
      { id: "m1", guildID: "1", channelID: "c1", content: "hi", editedTimestamp: edited },
    );
    await fire(
      "messageUpdate",
      { id: "m1", guildID: "1", channelID: "c1", content: "hi" },
      { id: "m1", guildID: "1", channelID: "c1", content: "hi" },
    );
    expect(rows).toEqual([]);
  });

  test("a real edit uses discord's edit time", async () => {
    const { rows, fire } = harness();
    const edited = new Date("2026-02-01T00:00:00.000Z");
    await fire(
      "messageUpdate",
      { id: "m1", guildID: "1", channelID: "c1", content: "hi", editedTimestamp: edited },
      { id: "m1", guildID: "1", channelID: "c1", content: "ho" },
    );
    expect(rows[0]?.kind).toBe("message_edit");
    expect(rows[0]?.at).toBe("2026-02-01T00:00:00.000Z");
    expect(rows[0]?.detail).toMatchObject({ message_id: "m1" });
  });
});

describe("guild objects", () => {
  test("a role rename keeps the role id in the detail", async () => {
    const { rows, fire } = harness();
    const before = { guildID: "1", id: "r1", name: "old", permissions: "0" };
    const after = { guildID: "1", id: "r1", name: "new", permissions: "0" };
    await fire("guildRoleUpdate", after, before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("role_update");
    expect(rows[0]?.detail).toEqual({ fields: ["name"], role_id: "r1" });
  });

  test("a ban lands on the user, not the guild", async () => {
    const { rows, fire } = harness();
    await fire("guildBanAdd", { id: "1" }, { id: "9", username: "mina", bot: false });
    expect(rows[0]).toMatchObject({
      kind: "ban_add",
      subjectKind: "user",
      subjectId: "9",
      before: { banned: false },
      after: { banned: true },
    });
  });

  test("a thread delete keeps the parent channel id", async () => {
    const { rows, fire } = harness();
    await fire("threadDelete", { id: "t1", guildID: "1", parentID: "c1", name: "t" });
    expect(rows[0]?.kind).toBe("thread_delete");
    expect(rows[0]?.detail).toEqual({ thread_id: "t1", parent_id: "c1" });
  });
});

describe("the guard", () => {
  test("a throwing handler is logged, never thrown at the emitter", async () => {
    const handlers = new Map<string, Handler>();
    const failures: unknown[] = [];
    const tracking = {
      record: () => {
        throw new Error("boom");
      },
      recordAll: async () => undefined,
      reportFailure: (_handler: string, error: unknown) => failures.push(error),
    } as unknown as TrackingService;
    const client = {
      on: (event: string, listener: Handler) => handlers.set(event, listener),
    } as unknown as Client;
    attachHandlers(client, tracking);

    expect(() => handlers.get("guildMemberAdd")?.(member())).not.toThrow();
    expect(failures).toHaveLength(1);
  });

  test("a rejected record is reported too", async () => {
    const handlers = new Map<string, Handler>();
    const failures: unknown[] = [];
    const tracking = {
      record: () => Promise.reject(new Error("db down")),
      recordAll: async () => undefined,
      reportFailure: (_handler: string, error: unknown) => failures.push(error),
    } as unknown as TrackingService;
    const client = {
      on: (event: string, listener: Handler) => handlers.set(event, listener),
    } as unknown as Client;
    attachHandlers(client, tracking);

    handlers.get("guildMemberAdd")?.(member());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toHaveLength(1);
  });
});
