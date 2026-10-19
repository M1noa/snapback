import { describe, expect, test } from "bun:test";
import { fingerprintSummary, readFingerprint } from "../../../src/web/capture/fingerprint.ts";

// no browser: the payload is a plain object, exactly as the page would post it.
const LONG = "x".repeat(400);

describe("readFingerprint", () => {
  test("keeps a well formed payload", () => {
    const fingerprint = readFingerprint({
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      lang: "en-GB",
      tz: "Europe/London",
      screen: "1920x1080",
      colorDepth: 24,
      viewport: "1280x720",
      touch: false,
      platform: "MacIntel",
      cookies: true,
      doNotTrack: "1",
      canvas: "9f2c",
      webgl: "1a3b",
      audio: "77c0",
      fonts: 12,
      battery: true,
    });
    expect(fingerprint.ua).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(fingerprint.lang).toBe("en-GB");
    expect(fingerprint.tz).toBe("Europe/London");
    expect(fingerprint.screen).toBe("1920x1080");
    expect(fingerprint.colorDepth).toBe(24);
    expect(fingerprint.viewport).toBe("1280x720");
    expect(fingerprint.touch).toBe(false);
    expect(fingerprint.platform).toBe("MacIntel");
    expect(fingerprint.cookies).toBe(true);
    expect(fingerprint.doNotTrack).toBe("1");
    expect(fingerprint.canvas).toBe("9f2c");
    expect(fingerprint.webgl).toBe("1a3b");
    expect(fingerprint.audio).toBe("77c0");
    expect(fingerprint.fonts).toBe(12);
    expect(fingerprint.battery).toBe(true);
  });

  test("drops a field of the wrong type instead of coercing it", () => {
    const fingerprint = readFingerprint({
      ua: 12345,
      colorDepth: "24",
      fonts: "12",
      touch: "yes",
      cookies: 1,
      battery: "true",
    });
    expect(fingerprint.ua).toBeNull();
    expect(fingerprint.colorDepth).toBeNull();
    expect(fingerprint.fonts).toBeNull();
    expect(fingerprint.touch).toBeNull();
    expect(fingerprint.cookies).toBeNull();
    expect(fingerprint.battery).toBeNull();
  });

  test("drops a number that is not a measurement", () => {
    expect(readFingerprint({ colorDepth: 0 }).colorDepth).toBeNull();
    expect(readFingerprint({ colorDepth: 999 }).colorDepth).toBeNull();
    expect(readFingerprint({ fonts: -1 }).fonts).toBeNull();
    expect(readFingerprint({ fonts: 24.5 }).fonts).toBeNull();
  });

  test("caps a long string", () => {
    const fingerprint = readFingerprint({ ua: LONG, platform: LONG });
    expect(fingerprint.ua?.length).toBe(256);
    expect(fingerprint.platform?.length).toBe(256);
  });

  test("ignores a field it does not know", () => {
    const fingerprint = readFingerprint({ ua: "a", password: "hunter2", canvasHash: "9f2c" });
    expect(fingerprint.ua).toBe("a");
    expect(Object.keys(fingerprint)).not.toContain("password");
    expect(Object.keys(fingerprint)).not.toContain("canvasHash");
  });

  test("reads a missing field as null", () => {
    const fingerprint = readFingerprint({});
    expect(fingerprint.ua).toBeNull();
    expect(fingerprint.touch).toBeNull();
    expect(fingerprint.fonts).toBeNull();
  });

  test("reads a payload that is not an object as all null", () => {
    for (const payload of [null, undefined, 42, "not json", []]) {
      const fingerprint = readFingerprint(payload);
      expect(fingerprint.ua).toBeNull();
      expect(fingerprint.touch).toBeNull();
    }
  });

  test("reads a json string payload", () => {
    const fingerprint = readFingerprint(JSON.stringify({ ua: "a", touch: true }));
    expect(fingerprint.ua).toBe("a");
    expect(fingerprint.touch).toBe(true);
  });

  test("reads a base64 json payload", () => {
    const encoded = Buffer.from(JSON.stringify({ ua: "a", fonts: 3 }), "utf8").toString("base64");
    const fingerprint = readFingerprint(encoded);
    expect(fingerprint.ua).toBe("a");
    expect(fingerprint.fonts).toBe(3);
  });
});

describe("fingerprintSummary", () => {
  test("is one line", () => {
    const summary = fingerprintSummary(
      readFingerprint({ platform: "MacIntel", lang: "en-GB", screen: "1920x1080" }),
    );
    expect(summary).not.toContain("\n");
    expect(summary).toContain("MacIntel");
    expect(summary).toContain("en-GB");
  });

  test("does not carry a raw value longer than the cap", () => {
    const summary = fingerprintSummary(readFingerprint({ ua: LONG, platform: LONG }));
    expect(summary).not.toContain(LONG);
    expect(summary).not.toContain("\n");
  });

  test("does not break the line on a value that carries one", () => {
    const summary = fingerprintSummary(readFingerprint({ platform: "Mac\nIntel" }));
    expect(summary).not.toContain("\n");
    expect(summary).toContain("Mac Intel");
  });

  test("says something when there is nothing to say", () => {
    expect(fingerprintSummary(readFingerprint({}))).toBe("no fingerprint captured");
  });
});
