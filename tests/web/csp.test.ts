// tests/web/csp.test.ts
//
// every inline script a page renders must be named in the policy by its own
// hash. the browser drops an unnamed script without a word, so a page that
// grows a script and forgets the policy fails here instead of in the tab.

import { describe, expect, test } from "bun:test";
import { WEB_CSP } from "../../src/web/capture/fingerprint-script.ts";
import { homePage, resultPage } from "../../src/web/views/pages.ts";

/** the body of every <script> tag in the html. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}

const PAGES: ReadonlyArray<readonly [string, string]> = [
  [
    "home",
    homePage({
      guildId: "1234567890",
      guildName: "the server",
      guildIconUrl: null,
      verifyUrl: "https://discord.com/oauth2/authorize?client_id=1",
    }),
  ],
  ["result ok", resultPage({ ok: true, guildName: "the server", detail: "you are in" })],
  ["result failed", resultPage({ ok: false, guildName: null, detail: "that link expired" })],
];

describe("the content security policy", () => {
  for (const [name, html] of PAGES) {
    test(`allows every script the ${name} page renders`, () => {
      const scripts = inlineScripts(html);
      if (name === "result failed") expect(scripts).toHaveLength(0);
      else expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        const hash = new Bun.CryptoHasher("sha256").update(script).digest("base64");
        expect(WEB_CSP).toContain(`'sha256-${hash}'`);
      }
    });
  }
});
