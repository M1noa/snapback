// tests/web/legal.test.ts
//
// the disclosure page. the text it shows is generated from the panel's own scope
// list, so it cannot claim less than the panel asks discord for.

import { describe, expect, test } from "bun:test";
import type { RequestContext } from "../../src/web/router.ts";
import { legalRoute } from "../../src/web/routes/legal.ts";

function ctx(query = ""): RequestContext {
  return {
    method: "GET",
    path: "/legal",
    query: new URLSearchParams(query),
    headers: new Headers(),
    remoteAddress: null,
  };
}

const deps = {
  db: { query: async () => [] } as never,
  log: { level: "error", debug() {}, info() {}, warn() {}, error() {}, async flush() {} } as never,
  panel: async (guildId: string) =>
    guildId === "123" ? { scopes: ["identify", "email", "guilds.join"] } : null,
  operatorText: "verification is optional.",
};

describe("the legal route", () => {
  test("the page names the scopes the panel asks for", async () => {
    const response = await legalRoute(deps)(ctx("guild=123"));
    expect(response.status).toBe(200);
    expect(response.body).toContain("identify, email, guilds.join");
    // and says what else is recorded, and that nothing happens before consent.
    expect(response.body).toContain("address your browser connects from");
    expect(response.body).toContain("Nothing is captured before you approve");
  });

  test("with no panel the page does not claim a scope list", async () => {
    const response = await legalRoute(deps)(ctx("guild=999"));
    expect(response.body).not.toContain("identify, email");
    expect(response.body).toContain("Nothing is captured before you approve");
  });

  test("with no guild the page still answers, and still says what is recorded", async () => {
    const response = await legalRoute(deps)(ctx());
    expect(response.status).toBe(200);
    expect(response.body).toContain("revoke access");
  });
});
