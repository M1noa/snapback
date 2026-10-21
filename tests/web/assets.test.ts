// tests/web/assets.test.ts
//
// the font files. an allowlist, so a path that is not one of the two is a 404
// and never a read from disk.

import { describe, expect, test } from "bun:test";
import { assetRoute } from "../../src/web/assets.ts";
import type { RequestContext } from "../../src/web/router.ts";

function ctx(path: string): RequestContext {
  return {
    method: "GET",
    path,
    query: new URLSearchParams(),
    headers: new Headers(),
    remoteAddress: null,
  };
}

describe("the font assets", () => {
  test("each allowed font is served as woff2 and cached hard", async () => {
    const serve = assetRoute();
    for (const path of [
      "/assets/fonts/geist-latin.woff2",
      "/assets/fonts/geist-mono-latin.woff2",
    ]) {
      const response = await serve(ctx(path));
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("font/woff2");
      expect(response.headers["cache-control"]).toContain("immutable");
      expect(response.body).toBeInstanceOf(Uint8Array);
      expect((response.body as Uint8Array).byteLength).toBeGreaterThan(1000);
    }
  });

  test("anything else under /assets is a 404", async () => {
    const serve = assetRoute();
    for (const path of [
      "/assets/fonts/nope.woff2",
      "/assets/fonts/../../.env",
      "/assets/logo.svg",
      "/assets/",
    ]) {
      expect((await serve(ctx(path))).status).toBe(404);
    }
  });
});
