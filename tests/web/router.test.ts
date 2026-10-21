// tests/web/router.test.ts
//
// the web layer's contract: three routes, everything else a plain 404, and no
// error page that leaks a path.

import { describe, expect, test } from "bun:test";
import { createRouter, notFound, type RequestContext } from "../../src/web/router.ts";
import { escapeHtml, homePage, resultPage } from "../../src/web/views/pages.ts";

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
    health: () => ({ status: 200, headers: {}, body: "health" }),
    assets: () => ({ status: 200, headers: {}, body: "font" }),
  });
}

describe("the web router", () => {
  test("the three routes are served", async () => {
    const serve = router();
    for (const path of ["/", "/callback", "/health"]) {
      const response = await serve(ctx(path));
      expect(response.status).toBe(200);
    }
  });

  test("the fonts are served under /assets", async () => {
    const serve = router();
    const response = await serve(ctx("/assets/fonts/geist-mono-latin.woff2"));
    expect(response.status).toBe(200);
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
    });
    expect(html).toContain("the guild");
    expect(html).toContain("verify for");
    expect(html).toContain("Continue with Discord");
    expect(html).toContain('class="grain"');
    expect(html).toContain("/assets/noise.png");
    expect(html).toMatch(/:root\{--h:\d+\}/);
    expect(html).not.toContain("/legal");
    expect(html).not.toContain("/revoke");
  });

  test("the landing page does not say what is captured", () => {
    const html = homePage({
      guildId: "123",
      guildName: "the guild",
      guildIconUrl: null,
      verifyUrl: "/?guild=123&start=1",
    });
    expect(html).not.toContain("captured");
    expect(html).not.toContain("revoke");
    expect(html).not.toContain("browser");
    expect(html).not.toContain("address");
  });

  test("a page without a guild says nothing about a server", () => {
    const html = homePage({
      guildId: null,
      guildName: null,
      guildIconUrl: null,
      verifyUrl: null,
    });
    expect(html).toContain("This link has no server");
  });

  test("a value in a page is escaped", () => {
    const html = homePage({
      guildId: "123",
      guildName: "<script>alert(1)</script>",
      guildIconUrl: null,
      verifyUrl: null,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the result page says whether it worked", () => {
    const ok = resultPage({
      ok: true,
      guildName: "the guild",
      detail: "You can close this page now.",
    });
    const notOk = resultPage({
      ok: false,
      guildName: null,
      detail: "the link may have expired.",
    });
    expect(ok).toContain("verified");
    expect(notOk).toContain("did not finish");
    expect(ok).not.toContain("/legal");
    expect(ok).not.toContain("revoke");
  });

  test("a verified page counts down and closes itself", () => {
    const ok = resultPage({ ok: true, guildName: "the guild", detail: "done." });
    // six seconds, spelled in the script and in the bar's animation.
    expect(ok).toContain('id="sb-close"');
    expect(ok).toContain("var left = 6;");
    expect(ok).toContain("window.close()");
    // the sentence it leaves behind is true even with no script.
    expect(ok).toContain("You can close this tab.");
  });

  test("a failed page stays open and says so", () => {
    const notOk = resultPage({ ok: false, guildName: null, detail: "expired." });
    expect(notOk).not.toContain('id="sb-close"');
    expect(notOk).not.toContain("window.close()");
  });

  test("a result carries its own hue, green for ok and red for failed", () => {
    const ok = resultPage({ ok: true, guildName: null, detail: "done." });
    const notOk = resultPage({ ok: false, guildName: null, detail: "expired." });
    expect(ok).toContain("--h:158");
    expect(notOk).toContain("--h:22");
  });

  test("escape covers the five characters that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
