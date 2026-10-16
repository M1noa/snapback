import { describe, expect, test } from "bun:test";
import { DiscordApiError } from "../../src/discord/errors.ts";
import type { SelfTestLine } from "../../src/setup/deps.ts";
import { createSelfTest, type SelfTestDeps } from "../../src/setup/selftest.ts";

const OWNER_ID = "111111111111111111";
const DEV_GUILD_ID = "222222222222222222";
const BOT_ID = "333333333333333333";
const CHANNEL_ID = "444444444444444444";

// the ten lines in the D4PLAN 7.6 order.
const NAMES: string[] = [
  "token valid",
  "owner id correct",
  "gateway connected",
  "GUILD_MEMBERS granted",
  "web port reachable",
  "public url resolves",
  "redirect registered",
  "oauth round trip",
  "history readable",
  "message content present",
];

type Client = SelfTestDeps["client"];

interface FakeClient {
  readonly client: Client;
  readonly calls: string[];
}

/** dispatch by route substring, in the map's order, and record the call order. */
function routeClient(map: ReadonlyArray<readonly [string, () => unknown]>): FakeClient {
  const calls: string[] = [];
  const client: Client = {
    async request<T>(options: { method: string; route: string; timeoutMs?: number }): Promise<T> {
      calls.push(options.route);
      for (const [key, respond] of map) {
        if (options.route.includes(key)) return respond() as T;
      }
      throw new Error(`unexpected route ${options.route}`);
    },
  };
  return { client, calls };
}

/** the happy path: every probe answers. */
function happyClient(): FakeClient {
  return routeClient([
    ["@me", () => ({ id: BOT_ID, username: "snapback" })],
    [OWNER_ID, () => ({ id: OWNER_ID })],
    ["members", () => []],
    ["/guilds/", () => [{ id: CHANNEL_ID, type: 0 }]],
    ["messages", () => [{ content: "hello" }]],
  ]);
}

function makeDeps(overrides: Partial<SelfTestDeps> = {}): SelfTestDeps {
  return {
    client: happyClient().client,
    ownerId: OWNER_ID,
    devGuildId: DEV_GUILD_ID,
    gateway: () => ({ ready: true, pingMs: 42 }),
    web: { port: 8080, publicBaseUrl: "https://snap.example", listening: async () => true },
    publicFetch: async () => ({ status: 200, body: '{"ok":true}' }),
    oauth: { authorizeStatus: async () => ({ status: 200, error: null }) },
    now: () => Date.now(),
    ...overrides,
  };
}

function line(lines: readonly SelfTestLine[], step: string): SelfTestLine {
  const found = lines.find((candidate) => candidate.step === step);
  if (found === undefined) throw new Error(`no line named ${step}`);
  return found;
}

describe("createSelfTest", () => {
  test("returns all ten lines in the plan's order, all passing", async () => {
    const fake = happyClient();
    const lines = await createSelfTest(makeDeps({ client: fake.client })).run();

    expect(lines.map((candidate) => candidate.step)).toEqual(NAMES);
    expect(lines.length).toBe(10);
    expect(lines.every((candidate) => candidate.passed)).toBe(true);
    expect(lines.every((candidate) => candidate.fix === null)).toBe(true);
  });

  test("the probes run in the reader's order: users, members, channels, messages", async () => {
    const fake = happyClient();
    await createSelfTest(makeDeps({ client: fake.client })).run();

    expect(fake.calls).toEqual([
      "/users/@me",
      `/users/${OWNER_ID}`,
      `/guilds/${DEV_GUILD_ID}/members?limit=1000`,
      `/guilds/${DEV_GUILD_ID}/channels`,
      `/channels/${CHANNEL_ID}/messages?limit=1`,
    ]);
  });

  test("a 50001 on the member fetch fails GUILD_MEMBERS with discord's own words plus a fix", async () => {
    const fake = routeClient([
      ["@me", () => ({ id: BOT_ID })],
      [OWNER_ID, () => ({ id: OWNER_ID })],
      [
        "members",
        () => {
          throw new DiscordApiError({
            status: 403,
            route: `/guilds/${DEV_GUILD_ID}/members`,
            method: "GET",
            body: JSON.stringify({ code: 50001, message: "Missing Permissions" }),
          });
        },
      ],
      ["/guilds/", () => [{ id: CHANNEL_ID, type: 0 }]],
      ["messages", () => [{ content: "hi" }]],
    ]);

    const lines = await createSelfTest(makeDeps({ client: fake.client })).run();
    const members = line(lines, "GUILD_MEMBERS granted");

    expect(members.passed).toBe(false);
    expect(members.said).toContain("50001");
    expect(members.said).toContain("Missing Permissions");
    expect(members.fix).toContain("Server Members Intent");
    // the failure is isolated: everything else still passes.
    expect(lines.filter((candidate) => !candidate.passed).length).toBe(1);
  });

  test("a non-empty content passes, an empty content fails with the permissions fix", async () => {
    const withContent = routeClient([
      ["@me", () => ({ id: BOT_ID })],
      [OWNER_ID, () => ({ id: OWNER_ID })],
      ["members", () => []],
      ["/guilds/", () => [{ id: CHANNEL_ID, type: 0 }]],
      ["messages", () => [{ content: "a real message" }]],
    ]);
    const passLines = await createSelfTest(makeDeps({ client: withContent.client })).run();
    expect(line(passLines, "message content present").passed).toBe(true);

    const empty = routeClient([
      ["@me", () => ({ id: BOT_ID })],
      [OWNER_ID, () => ({ id: OWNER_ID })],
      ["members", () => []],
      ["/guilds/", () => [{ id: CHANNEL_ID, type: 0 }]],
      ["messages", () => [{ content: "" }]],
    ]);
    const failLines = await createSelfTest(makeDeps({ client: empty.client })).run();
    const content = line(failLines, "message content present");

    expect(content.passed).toBe(false);
    expect(content.fix).toContain("check channel permissions, not the Message Content intent");
    // history itself was readable, so only the content line fails here.
    expect(line(failLines, "history readable").passed).toBe(true);
  });

  test("an unset dev guild fails exactly the three dev-guild lines, with the same fix", async () => {
    const fake = happyClient();
    const lines = await createSelfTest(
      makeDeps({ devGuildId: undefined, client: fake.client }),
    ).run();

    const failed = lines.filter((candidate) => !candidate.passed);
    expect(failed.map((candidate) => candidate.step)).toEqual([
      "GUILD_MEMBERS granted",
      "history readable",
      "message content present",
    ]);
    for (const candidate of failed) {
      expect(candidate.fix).toContain("DISCORD_DEV_GUILD_ID");
    }
    // the guild routes are never even attempted without an id.
    expect(fake.calls).toEqual(["/users/@me", `/users/${OWNER_ID}`]);
  });

  test("run() never throws when every call throws: ten failed lines", async () => {
    const allThrow: SelfTestDeps = {
      client: {
        async request<T>(): Promise<T> {
          throw new Error("network down");
        },
      },
      ownerId: OWNER_ID,
      devGuildId: DEV_GUILD_ID,
      gateway: () => {
        throw new Error("gateway down");
      },
      web: {
        port: 8080,
        publicBaseUrl: "https://snap.example",
        listening: async () => {
          throw new Error("port closed");
        },
      },
      publicFetch: async () => {
        throw new Error("dns failure");
      },
      oauth: {
        authorizeStatus: async () => {
          throw new Error("oauth down");
        },
      },
      now: () => Date.now(),
    };

    const lines = await createSelfTest(allThrow).run();

    expect(lines.length).toBe(10);
    expect(lines.map((candidate) => candidate.step)).toEqual(NAMES);
    expect(lines.every((candidate) => !candidate.passed)).toBe(true);
    expect(lines.every((candidate) => candidate.fix !== null)).toBe(true);
  });

  test("a shard that never reached ready fails the gateway line", async () => {
    const lines = await createSelfTest(
      makeDeps({ gateway: () => ({ ready: false, pingMs: null }) }),
    ).run();
    const gateway = line(lines, "gateway connected");

    expect(gateway.passed).toBe(false);
    expect(gateway.fix).not.toBeNull();
  });
});
