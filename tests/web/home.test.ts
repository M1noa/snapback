// tests/web/home.test.ts
//
// the landing route holds the one thing that matters about the challenge: a
// provider is configured, so no state is minted until a token comes back
// accepted. a plain get is a page, never a redirect.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CaptchaConfig } from "../../src/services/verify/captcha.ts";
import type { RequestContext } from "../../src/web/router.ts";
import { type HomeDeps, homeRoute } from "../../src/web/routes/home.ts";

const GUILD = "144102483157850112";

function ctx(method: string, query: string, body = ""): RequestContext {
  return {
    method,
    path: "/",
    query: new URLSearchParams(query),
    headers: new Headers(),
    remoteAddress: "203.0.113.9",
    text: async () => body,
  };
}

function captcha(provider: CaptchaConfig["provider"]): CaptchaConfig {
  return {
    provider,
    siteKey: "site-key",
    secret: "secret-key",
    baseUrl: provider === "cap" ? "https://cap.example" : "",
  };
}

let authorized: string[] = [];

function route(provider: CaptchaConfig["provider"]): ReturnType<typeof homeRoute> {
  const deps: HomeDeps = {
    // no guild row and no settings: the page renders with the fallback name.
    db: {
      kind: "duckdb",
      query: async () => [],
      run: async () => {},
      exec: async () => {},
      close: async () => {},
    },
    captcha: captcha(provider),
    authorizeUrl: async (guildId: string) => {
      authorized.push(guildId);
      return `https://discord.com/oauth2/authorize?guild=${guildId}`;
    },
  };
  return homeRoute(deps);
}

beforeEach(() => {
  authorized = [];
});

describe("a page with no challenge", () => {
  test("the verify button starts the flow on a get", async () => {
    const response = await route("none")(ctx("GET", `guild=${GUILD}&start=1`));
    expect(response.status).toBe(302);
    expect(authorized).toEqual([GUILD]);
    expect(response.headers.location).toContain("discord.com/oauth2/authorize");
  });

  test("the page carries no widget and no form", async () => {
    const response = await route("none")(ctx("GET", `guild=${GUILD}`));
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("cf-turnstile");
    expect(response.body).not.toContain("g-recaptcha");
    expect(response.body).not.toContain("cap-widget");
    expect(response.body).not.toContain("<form");
  });

  test("no server named is no button, and nothing starts", async () => {
    const response = await route("none")(ctx("GET", "start=1"));
    expect(response.status).toBe(200);
    expect(authorized).toEqual([]);
  });
});

describe("a page with a challenge", () => {
  test("a get renders the widget and mints no state", async () => {
    const response = await route("turnstile")(ctx("GET", `guild=${GUILD}&start=1`));
    expect(response.status).toBe(200);
    expect(authorized).toEqual([]);
    expect(response.body).toContain("cf-turnstile");
    expect(response.body).toContain('method="post"');
    expect(response.body).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
  });

  test("recaptcha and cap render their own widget", async () => {
    const google = await route("recaptcha")(ctx("GET", `guild=${GUILD}`));
    expect(google.body).toContain("g-recaptcha");
    expect(google.body).toContain("www.google.com/recaptcha/api.js");

    const selfHosted = await route("cap")(ctx("GET", `guild=${GUILD}`));
    expect(selfHosted.body).toContain("cap-widget");
    expect(selfHosted.body).toContain("https://cap.example/assets/widget.js");
  });

  describe("the token coming back", () => {
    const real = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = real;
    });

    test("an accepted token starts the flow", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(Response.json({ success: true }))) as unknown as typeof fetch;
      const response = await route("turnstile")(
        ctx("POST", `guild=${GUILD}&start=1`, "cf-turnstile-response=good"),
      );
      expect(response.status).toBe(302);
      expect(authorized).toEqual([GUILD]);
    });

    test("a refused token shows the refusal and mints nothing", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({
            success: false,
            "error-codes": ["invalid-input-response"],
          }),
        )) as unknown as typeof fetch;
      const response = await route("turnstile")(
        ctx("POST", `guild=${GUILD}&start=1`, "cf-turnstile-response=bad"),
      );
      expect(response.status).toBe(400);
      expect(authorized).toEqual([]);
      expect(response.body).toContain("invalid-input-response");
    });

    test("a missing token is a refusal without asking anyone", async () => {
      let asked = 0;
      globalThis.fetch = (() => {
        asked += 1;
        return Promise.resolve(Response.json({ success: true }));
      }) as unknown as typeof fetch;
      const response = await route("turnstile")(ctx("POST", `guild=${GUILD}&start=1`, ""));
      expect(response.status).toBe(400);
      expect(asked).toBe(0);
      expect(authorized).toEqual([]);
    });

    test("an unreachable verifier refuses rather than passes", async () => {
      globalThis.fetch = (() => Promise.reject(new Error("reset"))) as unknown as typeof fetch;
      const response = await route("cap")(ctx("POST", `guild=${GUILD}&start=1`, "cap-token=good"));
      expect(response.status).toBe(400);
      expect(response.body).toContain("could not be checked");
      expect(authorized).toEqual([]);
    });

    test("the token field is read by provider, not by guess", async () => {
      let seen = "";
      globalThis.fetch = ((_: string, init?: RequestInit) => {
        seen = String(init?.body ?? "");
        return Promise.resolve(Response.json({ success: true }));
      }) as unknown as typeof fetch;
      await route("cap")(ctx("POST", `guild=${GUILD}&start=1`, "cap-token=mine"));
      expect(JSON.parse(seen).response).toBe("mine");
    });
  });
});
