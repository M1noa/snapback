import { describe, expect, test } from "bun:test";
import { redactText, redactValue } from "../../src/lib/redact.ts";

// real-shaped fixtures, not toys.
const TOKEN = "MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs";
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz";
const EMAIL = "someone@example.com";
const IPV4 = "203.0.113.7";
const IPV6 = "2001:db8::1";

describe("redactText", () => {
  test("redacts a bot token", () => {
    const out = redactText(`auth failed with ${TOKEN} today`);
    expect(out).toContain("sk_***");
    expect(out).not.toContain(TOKEN);
  });

  test("keeps the scheme word on an auth header", () => {
    expect(redactText(`Bot ${TOKEN}`)).toBe("Bot sk_***");
    expect(redactText("Bearer opaque-value-123")).toBe("Bearer sk_***");
    expect(redactText(`authorization: Bot ${TOKEN}`)).toBe("authorization: Bot sk_***");
  });

  test("leaves prose that only looks like a scheme alone", () => {
    // a route segment named /bot and a capitalised "Bot" in running text are
    // not auth headers. the earlier \b(Bot|Bearer)\s+\S+ rule ate the next word.
    expect(redactText("discord rejected GET /gateway/bot with 401")).toBe(
      "discord rejected GET /gateway/bot with 401",
    );
    expect(redactText("regenerate it in the Developer Panel (Bot tab)")).toBe(
      "regenerate it in the Developer Panel (Bot tab)",
    );
  });

  test("redacts the webhook token but keeps host and id", () => {
    const out = redactText(`posting to ${WEBHOOK}`);
    expect(out).toBe("posting to https://discord.com/api/webhooks/123456789012345678/sk_***");
  });

  test("redacts a key=value secret and keeps the key", () => {
    expect(redactText("ENCRYPTION_KEY=abc123deadbeef")).toBe("ENCRYPTION_KEY=sk_***");
    expect(redactText(`token: "${"hunter2"}"`)).toBe('token: "sk_***"');
  });

  test("redacts an email", () => {
    const out = redactText(`verify ${EMAIL} done`);
    expect(out).toContain("<email>");
    expect(out).not.toContain(EMAIL);
  });

  test("redacts a full ipv4 and ipv6", () => {
    expect(redactText(`from ${IPV4}`)).toBe("from <ip>");
    expect(redactText(`from ${IPV6}`)).toBe("from <ip>");
  });

  test("leaves a truncated ip and a clock alone", () => {
    expect(redactText("hash bucket 1.2.3.x")).toBe("hash bucket 1.2.3.x");
    expect(redactText("at 12:34:56 the job ran")).toBe("at 12:34:56 the job ran");
  });
});

describe("redactValue", () => {
  test("recurses through objects and arrays", () => {
    const out = redactValue({
      user: EMAIL,
      meta: { ip: IPV4 },
      tags: [IPV6],
      count: 3,
    });
    expect(out).toEqual({ user: "<email>", meta: { ip: "<ip>" }, tags: ["<ip>"], count: 3 });
  });

  test("reduces an Error to its redacted message", () => {
    const out = redactValue(new Error(`failed with ${TOKEN} and ${EMAIL}`));
    expect(out).toContain("sk_***");
    expect(out).toContain("<email>");
    expect(out).not.toContain(TOKEN);
  });
});
