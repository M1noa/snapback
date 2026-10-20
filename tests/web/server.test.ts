// tests/web/server.test.ts
//
// the security headers. every response gets them, whatever the route said: a
// policy that some route can forget is not a policy.

import { describe, expect, test } from "bun:test";
import { WEB_CSP } from "../../src/web/capture/fingerprint-script.ts";
import { createServer, type ServerDeps } from "../../src/web/server.ts";

const ROUTES: ServerDeps["routes"] = {
  home: () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "home",
  }),
  callback: () => ({ status: 200, headers: {}, body: "callback" }),
  revoke: () => ({ status: 200, headers: {}, body: "revoke" }),
  health: () => ({ status: 200, headers: { "x-worker": "one" }, body: "{}" }),
  legal: () => ({ status: 200, headers: {}, body: "legal" }),
};

function deps(): ServerDeps {
  return {
    db: new Map() as never,
    log: {
      level: "error",
      debug() {},
      info() {},
      warn() {},
      error() {},
      async flush() {},
    } as never,
    ip: {
      behindCloudflareTunnel: false,
      trustedProxyDepth: 0,
      storage: "hash",
      hashPepper: "p",
      encryptionKey: "k",
    },
    routes: ROUTES,
    port: 0,
  };
}

describe("the web server", () => {
  const server = createServer(deps());
  const base = `http://127.0.0.1:${server.port}`;

  test("every response carries the security headers", async () => {
    for (const path of ["/", "/health", "/nowhere"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get("content-security-policy")).toBe(WEB_CSP);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      );
    }
  });

  test("the csp allows only our script, by hash, and nobody's forms", () => {
    expect(WEB_CSP).toContain("default-src 'none'");
    expect(WEB_CSP).toContain("script-src 'sha256-");
    expect(WEB_CSP).toContain("form-action 'none'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_CSP).not.toContain("script-src 'unsafe-inline'");
  });

  test("a route's own header survives the merge", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.headers.get("x-worker")).toBe("one");
  });

  test("the server closes", () => {
    server.stop();
  });
});
