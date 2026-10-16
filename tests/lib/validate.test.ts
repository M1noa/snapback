import { describe, expect, test } from "bun:test";
import {
  boundedText,
  clampInt,
  hexToInt,
  normaliseHex,
  oneOf,
  snowflake,
} from "../../src/lib/validate.ts";

describe("clampInt", () => {
  test("clamps inside the range and passes a value through", () => {
    const range = { min: 1, max: 10 };
    expect(clampInt(5, range)).toBe(5);
    expect(clampInt(0, range)).toBe(1);
    expect(clampInt(999, range)).toBe(10);
  });

  test("reads a string as a number, which is what a modal sends", () => {
    expect(clampInt("7", { min: 1, max: 10 })).toBe(7);
    expect(clampInt("7.9", { min: 1, max: 10 })).toBe(7);
  });

  test("null for anything that is not a number, so the caller decides", () => {
    expect(clampInt("", { min: 1, max: 10 })).toBeNull();
    expect(clampInt("abc", { min: 1, max: 10 })).toBeNull();
    expect(clampInt(Number.NaN, { min: 1, max: 10 })).toBeNull();
    expect(clampInt(Infinity, { min: 1, max: 10 })).toBeNull();
  });
});

describe("normaliseHex", () => {
  test("accepts the three shapes a person types", () => {
    expect(normaliseHex("#AABBCC")).toBe("#aabbcc");
    expect(normaliseHex("aabbcc")).toBe("#aabbcc");
    expect(normaliseHex("0xAABBCC")).toBe("#aabbcc");
    expect(normaliseHex("  #aabbcc  ")).toBe("#aabbcc");
  });

  test("null on anything that is not a six-digit colour", () => {
    expect(normaliseHex("#abc")).toBeNull();
    expect(normaliseHex("#aabbccdd")).toBeNull();
    expect(normaliseHex("blurple")).toBeNull();
    expect(normaliseHex(0x5865f2)).toBeNull();
    expect(normaliseHex(null)).toBeNull();
  });
});

describe("hexToInt", () => {
  test("the stored string crosses to the wire integer in one place", () => {
    expect(hexToInt("#5865f2")).toBe(0x5865f2);
    expect(hexToInt("ED4245")).toBe(0xed4245);
  });

  test("throws rather than sending a colour discord rejects", () => {
    expect(() => hexToInt("nope")).toThrow(/bad hex colour/);
  });
});

describe("oneOf", () => {
  test("keeps an allowed value and refuses the rest", () => {
    const modes = ["hash", "encrypted", "plaintext"] as const;
    expect(oneOf("hash", modes)).toBe("hash");
    expect(oneOf("plaintext", modes)).toBe("plaintext");
    expect(oneOf("cleartext", modes)).toBeNull();
    expect(oneOf(7, modes)).toBeNull();
  });
});

describe("boundedText", () => {
  test("trims, bounds, and treats empty as missing", () => {
    expect(boundedText("  verify  ", 20)).toBe("verify");
    expect(boundedText("abcdef", 3)).toBe("abc");
    expect(boundedText("   ", 20)).toBeNull();
    expect(boundedText("", 20)).toBeNull();
    expect(boundedText(42, 20)).toBeNull();
  });
});

describe("snowflake", () => {
  test("a plausible id stays a string", () => {
    const id = "123456789012345678";
    expect(snowflake(id)).toBe(id);
    expect(typeof snowflake(id)).toBe("string");
  });

  test("refuses a number or a bigint rather than stringifying it", () => {
    expect(snowflake(123456789012345678n)).toBeNull();
    expect(snowflake(42)).toBeNull();
    expect(snowflake("abc")).toBeNull();
    expect(snowflake("<@123456789012345678>")).toBeNull();
  });
});
