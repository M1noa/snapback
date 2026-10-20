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
      languages: "en-GB,en-US",
      tzOffset: 0,
      avail: "1920x1036",
      dpr: 2,
      maxTouchPoints: 0,
      hwConcurrency: 8,
      deviceMemory: 8,
      reducedMotion: false,
      colorScheme: "dark",
      connection: "4g",
      referrer: "",
      audioDevices: 2,
      capturedAt: 1750000000000,
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
    expect(fingerprint.languages).toBe("en-GB,en-US");
    expect(fingerprint.tzOffset).toBe(0);
    expect(fingerprint.avail).toBe("1920x1036");
    expect(fingerprint.dpr).toBe(2);
    expect(fingerprint.hwConcurrency).toBe(8);
    expect(fingerprint.deviceMemory).toBe(8);
    expect(fingerprint.colorScheme).toBe("dark");
    expect(fingerprint.connection).toBe("4g");
    expect(fingerprint.audioDevices).toBe(2);
    expect(fingerprint.capturedAt).toBe(1750000000000);
  });

  test("drops a field of the wrong type instead of coercing it", () => {
    const fingerprint = readFingerprint({
      ua: 12345,
      colorDepth: "24",
      tzOffset: "zero",
      touch: "yes",
      cookies: 1,
      colorScheme: "midnight",
      dpr: "2",
      deviceMemory: "8",
    });
    expect(fingerprint.ua).toBeNull();
    expect(fingerprint.colorDepth).toBeNull();
    expect(fingerprint.touch).toBeNull();
    expect(fingerprint.cookies).toBeNull();
    expect(fingerprint.colorScheme).toBeNull();
    expect(fingerprint.dpr).toBeNull();
    expect(fingerprint.deviceMemory).toBeNull();
  });

  test("drops a number that is not a measurement", () => {
    expect(readFingerprint({ colorDepth: 0 }).colorDepth).toBeNull();
    expect(readFingerprint({ colorDepth: 999 }).colorDepth).toBeNull();
    expect(readFingerprint({ hwConcurrency: 0 }).hwConcurrency).toBeNull();
    expect(readFingerprint({ hwConcurrency: 24.5 }).hwConcurrency).toBeNull();
    expect(readFingerprint({ deviceMemory: 16 }).deviceMemory).toBeNull();
    expect(readFingerprint({ dpr: 0 }).dpr).toBeNull();
    expect(readFingerprint({ audioDevices: 999 }).audioDevices).toBeNull();
    expect(readFingerprint({ capturedAt: -5 }).capturedAt).toBeNull();
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
    const encoded = Buffer.from(JSON.stringify({ ua: "a", dpr: 1.5 }), "utf8").toString("base64");
    const fingerprint = readFingerprint(encoded);
    expect(fingerprint.ua).toBe("a");
    expect(fingerprint.dpr).toBe(1.5);
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
