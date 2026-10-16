import { describe, expect, test } from "bun:test";
import { DiscordApiError, formatDiscordError } from "../../src/discord/errors.ts";

function make(status: number, body: unknown, retryAfterMs: number | null = null): DiscordApiError {
  return new DiscordApiError({
    status,
    route: "/channels/1/messages",
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    retryAfterMs,
  });
}

describe("DiscordApiError", () => {
  test("keeps discord's code and message verbatim", () => {
    const error = make(403, { code: 50013, message: "Missing Permissions" });
    expect(error.code).toBe(50013);
    expect(error.message).toBe("Missing Permissions");
    expect(error.status).toBe(403);
  });

  test("message is discord's own words, not a rewrite", () => {
    const error = make(404, { code: 10003, message: "Unknown Channel" });
    // the exact string, character for character
    expect(error.message).toBe("Unknown Channel");
    expect(error.message).not.toContain("SB_");
  });

  test("preserves route and method so an unknown code is traceable", () => {
    const error = make(418, { code: 99999, message: "I am a teapot" });
    expect(error.route).toBe("/channels/1/messages");
    expect(error.method).toBe("POST");
    expect(error.body).toBe(JSON.stringify({ code: 99999, message: "I am a teapot" }));
  });

  test("flattens 50035 field errors into dotted paths", () => {
    const error = make(400, {
      code: 50035,
      message: "Invalid Form Body",
      errors: {
        content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer" }] },
        embeds: {
          "0": { title: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "Required" }] } },
        },
      },
    });
    const paths = error.errors.map((field) => field.path).sort();
    expect(paths).toEqual(["content", "embeds.0.title"]);
    expect(error.errors.find((f) => f.path === "content")?.code).toBe("BASE_TYPE_MAX_LENGTH");
    expect(error.errors.find((f) => f.path === "embeds.0.title")?.message).toBe("Required");
  });

  test("a body-level error path falls back to _", () => {
    const error = make(400, {
      code: 50035,
      message: "Invalid Form Body",
      errors: { _errors: [{ code: "X", message: "bad body" }] },
    });
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]?.path).toBe("_");
  });

  test("a non-json body is kept and labelled, not thrown away", () => {
    const error = make(502, "<html><body>502 Bad Gateway</body></html>");
    expect(error.nonJson).toBe(true);
    expect(error.code).toBeNull();
    expect(error.message).toContain("non-JSON response");
    expect(error.body).toContain("502 Bad Gateway");
  });

  test("an empty body does not crash the parser", () => {
    const error = make(500, "");
    expect(error.code).toBeNull();
    expect(error.nonJson).toBe(false);
    expect(error.message).toBe("500 with no message from discord");
  });

  test("retry_after in the body becomes milliseconds", () => {
    const error = make(429, { code: 0, message: "You are being rate limited.", retry_after: 1.5 });
    expect(error.retryAfterMs).toBe(1500);
  });

  test("the header retry_after wins over the body", () => {
    const error = make(429, { code: 0, message: "limited", retry_after: 1.5 }, 2000);
    expect(error.retryAfterMs).toBe(2000);
  });

  test("toWire produces the snake_case body shape", () => {
    const error = make(429, { code: 0, message: "limited", retry_after: 2 });
    const wire = error.toWire();
    expect(wire.retry_after).toBe(2);
    expect(wire.status).toBe(429);
    expect(wire.method).toBe("POST");
  });
});

describe("formatDiscordError", () => {
  test("a known code gets a fix appended, never a replaced message", () => {
    const report = formatDiscordError(make(403, { code: 50013, message: "Missing Permissions" }));
    expect(report.said).toBe("50013 Missing Permissions");
    expect(report.fix).not.toBeNull();
    expect(report.fix).toContain("permission");
    // the fix is separate from what discord said, not spliced into it
    expect(report.said).not.toContain(report.fix ?? "");
  });

  test("an unknown code is shown raw with no invented fix", () => {
    const report = formatDiscordError(make(400, { code: 123456, message: "Something New" }));
    expect(report.said).toBe("123456 Something New");
    expect(report.fix).toBeNull();
  });

  test("the headline names the method and route", () => {
    const report = formatDiscordError(make(404, { code: 10003, message: "Unknown Channel" }));
    expect(report.headline).toContain("POST");
    expect(report.headline).toContain("/channels/1/messages");
    expect(report.headline).toContain("404");
  });

  test("field errors ride along for a 50035", () => {
    const report = formatDiscordError(
      make(400, {
        code: 50035,
        message: "Invalid Form Body",
        errors: { name: { _errors: [{ code: "X", message: "too long" }] } },
      }),
    );
    expect(report.fields.map((f) => f.path)).toEqual(["name"]);
    expect(report.fix).toContain("fields");
  });
});
