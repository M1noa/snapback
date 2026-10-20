// tests/web/router.test.ts
//
// the web layer's contract: five routes, everything else a plain 404, and no
// error page that leaks a path.

import { describe, expect, test } from "bun:test";
import { createRouter, notFound, type RequestContext } from "../../src/web/router.ts";
import { escapeHtml, homePage, legalPage, resultPage } from "../../src/web/views/pages.ts";

function ctx(path: string, query = ""): RequestContext {
  return {
    method: "GET",
    path,
    query: new URLSearchParams(query),
    headers: new Headers(),
    remoteAddress: null,
  };
}

function router() {
  return createRouter({
    home: () => ({ status: 200, headers: {}, body: "home" }),
    callback: () => ({ status: 200, headers: {}, body: "callback" }),
    revoke: () => ({ status: 200, headers: {}, body: "revoke" }),
    health: () => ({ status: 200, headers: {}, body: "health" }),
    legal: () => ({ status: 200, headers: {}, body: "legal" }),
  });
}

describe("the web router", () => {
  test("the five routes are served", async () => {
    const serve = router();
    for (const path of ["/", "/callback", "/revoke", "/health", "/legal"]) {
      const response = await serve(ctx(path));
      expect(response.status).toBe(200);
    }
  });

  test("everything else is a plain 404", async () => {
    const serve = router();
    for (const path of ["/admin", "/v/anything", "/callback/extra", "/.env", "/"]) {
      if (path === "/") continue;
      const response = await serve(ctx(path));
      expect(response.status).toBe(404);
      expect(response.body).not.toContain("/Users/");
      expect(response.body).not.toContain("src/");
    }
  });

  test("the 404 body names no path of ours", () => {
    expect(notFound().body).toContain("not found");
  });
});

describe("the pages", () => {
  test("the landing page names the guild and offers a verify button", () => {
    const html = homePage({
      guildId: "123",
      guildName: "the guild",
      guildIconUrl: null,
      verifyUrl: "/?guild=123&start=1",
      disclosureUrl: "/legal",
      revokeUrl: "/revoke",
    });
    expect(html).toContain("the guild");
    expect(html).toContain("verify with discord");
    expect(html).toContain("/legal");
  });

  test("a page without a guild says nothing about a server", () => {
    const html = homePage({
      guildId: null,
      guildName: null,
      guildIconUrl: null,
      verifyUrl: null,
      disclosureUrl: "/legal",
      revokeUrl: "/revoke",
    });
    expect(html).toContain("this link has no server");
  });

  test("a value in a page is escaped", () => {
    const html = homePage({
      guildId: "123",
      guildName: "<script>alert(1)</script>",
      guildIconUrl: null,
      verifyUrl: null,
      disclosureUrl: "/legal",
      revokeUrl: "/revoke",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the result page says whether it worked", () => {
    const ok = resultPage({
      ok: true,
      guildName: "the guild",
      detail: "captured: email.",
      disclosureUrl: "/legal",
      revokeUrl: "/revoke",
    });
    const notOk = resultPage({
      ok: false,
      guildName: null,
      detail: "the link may have expired.",
      disclosureUrl: "/legal",
      revokeUrl: "/revoke",
    });
    expect(ok).toContain("verified");
    expect(notOk).toContain("did not finish");
  });

  test("the disclosure page renders the text the operator wrote", () => {
    const html = legalPage({
      disclosure: "we store the address you came from.",
      disclosureUrl: "/legal",
      revokeUrl: "/revoke",
      fingerprintFields: ["user agent", "device memory"],
    });
    expect(html).toContain("we store the address you came from.");
    expect(html).toContain("device memory");
  });

  test("escape covers the five characters that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
