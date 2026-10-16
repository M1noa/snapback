import { describe, expect, test } from "bun:test";
import type { DiscordClient } from "../../src/discord/client.ts";
import { createCommandsRest, syncCommands } from "../../src/discord/commands/register.ts";
import type { CommandDefinition } from "../../src/discord/registry.ts";
import type { LogFields, Logger, LogLevel } from "../../src/lib/log.ts";

const APPLICATION_ID = "400000000000000004";
const GUILD = "200000000000000002";

interface Call {
  method: string;
  route: string;
  body: unknown;
}

// a stand-in for DiscordClient: the route and method are what this adapter owes
// the rest of the app (AGENTS.md rule 6), so they are what the test asserts.
function fakeClient(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = {
    async request<T>(options: { method: string; route: string; body?: unknown }): Promise<T> {
      const call: Call = { method: options.method, route: options.route, body: options.body };
      calls.push(call);
      return reply(call) as T;
    },
  };
  return { client: client as unknown as DiscordClient, calls };
}

function recordingLogger(): Logger & { records: { msg: string; fields: LogFields }[] } {
  const records: { msg: string; fields: LogFields }[] = [];
  const log = {
    level: "debug" as LogLevel,
    debug: () => {},
    info: (msg: string, fields: LogFields = {}) => records.push({ msg, fields }),
    warn: () => {},
    error: () => {},
    async flush() {},
  };
  return Object.assign(log, { records });
}

const DEFINITIONS: CommandDefinition[] = [
  {
    name: "snapback",
    description: "snapback bot status, diagnostics, and version",
    options: [{ name: "status", description: "status", type: 1 }],
  },
];

describe("createCommandsRest", () => {
  test("global scope lists application commands", async () => {
    const { client, calls } = fakeClient(() => []);
    await createCommandsRest(client, APPLICATION_ID).list({ kind: "global" });

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.route).toBe(`/applications/${APPLICATION_ID}/commands`);
  });

  test("guild scope is scoped to the dev guild", async () => {
    const { client, calls } = fakeClient(() => []);
    await createCommandsRest(client, APPLICATION_ID).list({ kind: "guild", guildId: GUILD });

    expect(calls[0]?.route).toBe(`/applications/${APPLICATION_ID}/guilds/${GUILD}/commands`);
  });

  test("guild scope without a guild id is a bug, not a global put", () => {
    const { client } = fakeClient(() => []);
    expect(() => createCommandsRest(client, APPLICATION_ID).list({ kind: "guild" })).toThrow();
  });

  test("put sends the definitions as the body", async () => {
    const { client, calls } = fakeClient(() => []);
    await createCommandsRest(client, APPLICATION_ID).put({ kind: "global" }, DEFINITIONS);

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toEqual(DEFINITIONS);
  });

  test("ids come back as strings, never numbers", async () => {
    const { client } = fakeClient(() => [
      { id: "500000000000000005", name: "snapback", description: "d" },
    ]);
    const registered = await createCommandsRest(client, APPLICATION_ID).list({ kind: "global" });

    expect(registered[0]?.id).toBe("500000000000000005");
    expect(typeof registered[0]?.id).toBe("string");
  });
});

describe("syncCommands", () => {
  test("does not put when nothing changed", async () => {
    const { client, calls } = fakeClient(() => [
      {
        id: "5",
        name: "snapback",
        description: DEFINITIONS[0]!.description,
        options: DEFINITIONS[0]!.options,
      },
    ]);
    const log = recordingLogger();
    await syncCommands(
      createCommandsRest(client, APPLICATION_ID),
      DEFINITIONS,
      { kind: "global" },
      log,
    );

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    expect(log.records[0]?.msg).toBe("slash commands are in sync");
  });

  test("puts when a command is new, and names it", async () => {
    const { client, calls } = fakeClient(() => []);
    const log = recordingLogger();
    await syncCommands(
      createCommandsRest(client, APPLICATION_ID),
      DEFINITIONS,
      { kind: "global" },
      log,
    );

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(log.records[0]?.fields.added).toEqual(["snapback"]);
  });

  test("puts when a command was deleted from this build", async () => {
    const { client, calls } = fakeClient(() => [{ id: "5", name: "old", description: "gone" }]);
    const log = recordingLogger();
    await syncCommands(
      createCommandsRest(client, APPLICATION_ID),
      DEFINITIONS,
      { kind: "global" },
      log,
    );

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(log.records[0]?.fields.removed).toEqual(["old"]);
  });

  test("a changed option is reported as one field line", async () => {
    const { client } = fakeClient(() => [
      {
        id: "5",
        name: "snapback",
        description: DEFINITIONS[0]!.description,
        options: [{ name: "status", description: "something else", type: 1 }],
      },
    ]);
    const log = recordingLogger();
    await syncCommands(
      createCommandsRest(client, APPLICATION_ID),
      DEFINITIONS,
      { kind: "global" },
      log,
    );

    const changed = log.records[0]?.fields.changed as string[];
    expect(changed).toEqual(["snapback.options.status.description: status -> something else"]);
  });

  test("guild scope reports instant propagation", async () => {
    const { client } = fakeClient(() => []);
    const log = recordingLogger();
    await syncCommands(
      createCommandsRest(client, APPLICATION_ID),
      DEFINITIONS,
      { kind: "guild", guildId: GUILD },
      log,
    );

    expect(log.records[1]?.fields.propagation).toBe("instant");
  });
});
