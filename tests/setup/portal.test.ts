import { describe, expect, test } from "bun:test";
import type { ApplicationFacts } from "../../src/setup/deps.ts";
import {
  createPortal,
  inviteUrl,
  type PortalDeps,
  type PortalFeature,
} from "../../src/setup/portal.ts";

const APP: ApplicationFacts = {
  id: "111111111111111111",
  name: "snapback",
  botUserId: "222222222222222222",
  ownerId: "333333333333333333",
  flags: 0,
  intents: 0,
};

const ALL_FEATURES: readonly PortalFeature[] = [
  "roles",
  "channels",
  "webhooks",
  "bans",
  "guild",
  "messages",
  "history",
  "emojis",
  "events",
  "moderation",
  "audit_log",
];

/** a client whose only job is answering the interactions-endpoint probe. */
function endpointClient(value: unknown): PortalDeps["client"] {
  return {
    async request<T>(): Promise<T> {
      return { interactions_endpoint_url: value } as T;
    },
  };
}

function portalDeps(overrides: Partial<PortalDeps> = {}): PortalDeps {
  return {
    client: endpointClient(null),
    application: async () => APP,
    publicBaseUrl: "https://snap.example",
    memberIntent: true,
    features: () => [],
    ...overrides,
  };
}

describe("portal items", () => {
  test("seven items, numbered 1 to 7, each with a title and a body", async () => {
    const items = await createPortal(portalDeps()).items();

    expect(items.map((item) => item.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const item of items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.body.length).toBeGreaterThan(0);
    }
  });

  test("the redirect item cannot be settled by the api: done is null, the paste string is in the body", async () => {
    const items = await createPortal(portalDeps()).items();
    const redirect = items.find((item) => item.index === 2);

    expect(redirect?.done).toBeNull();
    expect(redirect?.body).toContain("https://snap.example/callback");
    expect(redirect?.fix).toBeNull();
  });

  test("the application item is done only when the app and its bot user both exist", async () => {
    const good = await createPortal(portalDeps()).items();
    expect(good.find((item) => item.index === 1)?.done).toBe(true);

    const noBot = await createPortal(
      portalDeps({ application: async () => ({ ...APP, botUserId: null }) }),
    ).items();
    expect(noBot.find((item) => item.index === 1)?.done).toBe(false);
    expect(noBot.find((item) => item.index === 1)?.fix).not.toBeNull();
  });

  test("the privileged intents item follows the gateway handshake", async () => {
    const on = await createPortal(portalDeps({ memberIntent: true })).items();
    expect(on.find((item) => item.index === 3)?.done).toBe(true);

    const off = await createPortal(portalDeps({ memberIntent: false })).items();
    expect(off.find((item) => item.index === 3)?.done).toBe(false);
    expect(off.find((item) => item.index === 3)?.fix).toContain("Server Members Intent");
  });

  test("the interactions endpoint item fails when a stale url is set", async () => {
    const clean = await createPortal(portalDeps({ client: endpointClient(null) })).items();
    expect(clean.find((item) => item.index === 6)?.done).toBe(true);

    const stale = await createPortal(
      portalDeps({ client: endpointClient("https://old.example/interactions") }),
    ).items();
    const item = stale.find((candidate) => candidate.index === 6);
    expect(item?.done).toBe(false);
    expect(item?.fix).not.toBeNull();
    expect(item?.body).toContain("https://old.example/interactions");
  });

  test("the install link item carries the invite url built from the application id", async () => {
    const items = await createPortal(portalDeps()).items();
    const link = items.find((item) => item.index === 4);

    expect(link?.done).toBe(true);
    expect(link?.body).toContain("client_id=111111111111111111");
  });
});

describe("permissionBits", () => {
  test("matches a hand-computed decimal for a couple of features", async () => {
    // roles 1<<28 = 268435456, channels 1<<4 = 16, audit_log 1<<7 = 128.
    const portal = createPortal(portalDeps({ features: () => ["roles", "channels", "audit_log"] }));
    expect(portal.permissionBits()).toBe("268435600");

    // events 1<<33 and moderation 1<<40 need BigInt, not `<<`.
    expect(createPortal(portalDeps({ features: () => ["events"] })).permissionBits()).toBe(
      "8589934592",
    );
    expect(createPortal(portalDeps({ features: () => ["moderation"] })).permissionBits()).toBe(
      "1099511627776",
    );
  });

  test("administrator is never included", async () => {
    const portal = createPortal(portalDeps({ features: () => ALL_FEATURES }));
    const bits = BigInt(portal.permissionBits());
    expect(bits & 8n).toBe(0n);
  });

  test("no enabled features is zero", async () => {
    expect(createPortal(portalDeps({ features: () => [] })).permissionBits()).toBe("0");
  });
});

describe("inviteUrl", () => {
  test("carries the application id, the decimal permissions, and scope=bot+..., with no credentials", () => {
    const url = inviteUrl({
      applicationId: "111111111111111111",
      permissions: "268435600",
      scopes: ["identify", "email"],
    });

    expect(url.startsWith("https://discord.com/oauth2/authorize?")).toBe(true);
    expect(url).toContain("client_id=111111111111111111");
    expect(url).toContain("permissions=268435600");
    expect(url).toContain("scope=bot+identify+email");
    expect(url).not.toContain("token");
    expect(url).not.toContain("secret");
  });

  test("an unknown scope is refused rather than shipped", () => {
    expect(() => inviteUrl({ applicationId: "1", permissions: "0", scopes: ["made.up"] })).toThrow(
      /unknown oauth2 scope/,
    );
  });
});

describe("portal.invite", () => {
  test("defaults to the panel scopes once the application id is known", async () => {
    const portal = createPortal(portalDeps());
    await portal.items();

    const url = portal.invite();
    expect(url).toContain("client_id=111111111111111111");
    expect(url).toContain("scope=bot+identify+email+guilds.join");
  });

  test("throws naming what is missing when the application id is null", async () => {
    const portal = createPortal(
      portalDeps({ application: async () => ({ ...APP, id: null, botUserId: null }) }),
    );
    await portal.items();

    expect(() => portal.invite()).toThrow(/application id/);
  });
});
