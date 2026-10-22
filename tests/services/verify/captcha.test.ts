// tests/services/verify/captcha.test.ts
//
// the gate itself. three endpoints, two body shapes, and one rule that matters:
// anything short of an explicit success is a refusal.

import { describe, expect, test } from "bun:test";
import {
  CAPTCHA_FIELDS,
  type CaptchaConfig,
  captchaEndpoint,
  verifyCaptcha,
} from "../../../src/services/verify/captcha.ts";

function config(provider: CaptchaConfig["provider"], baseUrl = ""): CaptchaConfig {
  return { provider, siteKey: "site-key", secret: "secret-key", baseUrl };
}

interface Seen {
  url: string;
  contentType: string | null;
  body: string;
}

function stub(answer: () => Promise<Response>): { fetcher: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      contentType: new Headers(init?.headers).get("content-type"),
      body: String(init?.body ?? ""),
    });
    return answer();
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const json = (payload: unknown, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("the field the widget writes", () => {
  test("each provider has its own hidden input name", () => {
    expect(CAPTCHA_FIELDS.turnstile).toBe("cf-turnstile-response");
    expect(CAPTCHA_FIELDS.recaptcha).toBe("g-recaptcha-response");
    expect(CAPTCHA_FIELDS.cap).toBe("cap-token");
    // none has no widget, so it has no field to read.
    expect(CAPTCHA_FIELDS.none).toBe("");
  });
});

describe("where a token is checked", () => {
  test("turnstile and recaptcha live at fixed addresses", () => {
    expect(captchaEndpoint(config("turnstile"))).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(captchaEndpoint(config("recaptcha"))).toBe(
      "https://www.google.com/recaptcha/api/siteverify",
    );
  });

  test("cap serves the verifier from the operator's own instance", () => {
    expect(captchaEndpoint(config("cap", "https://cap.example.com"))).toBe(
      "https://cap.example.com/site-key/siteverify",
    );
  });
});

describe("the verdict", () => {
  test("none needs no request and always passes", async () => {
    const { fetcher, seen } = stub(() => json({ success: false }));
    const verdict = await verifyCaptcha(config("none"), "", null, fetcher);
    expect(verdict).toEqual({ ok: true, codes: [], unanswered: false });
    expect(seen).toHaveLength(0);
  });

  test("an empty token never costs a request", async () => {
    const { fetcher, seen } = stub(() => json({ success: true }));
    const verdict = await verifyCaptcha(config("turnstile"), "", null, fetcher);
    expect(verdict.ok).toBe(false);
    expect(verdict.unanswered).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("success is the only thing that counts as ok", async () => {
    const yes = stub(() => json({ success: true }));
    expect((await verifyCaptcha(config("turnstile"), "t", null, yes.fetcher)).ok).toBe(true);

    const no = stub(() => json({ success: false }));
    expect((await verifyCaptcha(config("turnstile"), "t", null, no.fetcher)).ok).toBe(false);
  });

  test("the provider's own error codes come back verbatim", async () => {
    const { fetcher } = stub(() =>
      json({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    const verdict = await verifyCaptcha(config("recaptcha"), "t", null, fetcher);
    expect(verdict.codes).toEqual(["invalid-input-response"]);
    expect(verdict.unanswered).toBe(false);
  });

  test("a socket that never opened is unanswered, not a pass", async () => {
    const fetcher = (() => Promise.reject(new Error("reset"))) as unknown as typeof fetch;
    const verdict = await verifyCaptcha(config("turnstile"), "t", null, fetcher);
    expect(verdict).toEqual({ ok: false, codes: [], unanswered: true });
  });

  test("a non-2xx answer is unanswered, not a pass", async () => {
    const { fetcher } = stub(() => json({ success: true }, 500));
    const verdict = await verifyCaptcha(config("turnstile"), "t", null, fetcher);
    expect(verdict.unanswered).toBe(true);
    expect(verdict.ok).toBe(false);
  });

  test("a body that is not json is unanswered, not a pass", async () => {
    const { fetcher } = stub(() => Promise.resolve(new Response("<html>", { status: 200 })));
    expect(
      (await verifyCaptcha(config("cap", "https://c.example"), "t", null, fetcher)).unanswered,
    ).toBe(true);
  });
});

describe("what the request carries", () => {
  test("cap takes json, the secret, and the token", async () => {
    const { fetcher, seen } = stub(() => json({ success: true }));
    await verifyCaptcha(config("cap", "https://c.example"), "the-token", null, fetcher);
    expect(seen[0]?.url).toBe("https://c.example/site-key/siteverify");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      secret: "secret-key",
      response: "the-token",
    });
  });

  test("turnstile takes a form and passes the address when there is one", async () => {
    const { fetcher, seen } = stub(() => json({ success: true }));
    await verifyCaptcha(config("turnstile"), "the-token", "203.0.113.9", fetcher);
    expect(seen[0]?.contentType).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(seen[0]?.body ?? "");
    expect(form.get("secret")).toBe("secret-key");
    expect(form.get("response")).toBe("the-token");
    expect(form.get("remoteip")).toBe("203.0.113.9");
  });

  test("no address means no remoteip field, never an empty one", async () => {
    const { fetcher, seen } = stub(() => json({ success: true }));
    await verifyCaptcha(config("recaptcha"), "the-token", null, fetcher);
    expect(new URLSearchParams(seen[0]?.body ?? "").has("remoteip")).toBe(false);
  });
});
