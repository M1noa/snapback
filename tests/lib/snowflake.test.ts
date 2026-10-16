import { describe, expect, test } from "bun:test";
import {
  compareSnowflakes,
  formatRelative,
  isSnowflake,
  snowflakeToDate,
} from "../../src/lib/snowflake.ts";

// 1s past the discord epoch: (1420070400000+1000) ms cast to a snowflake.
const ONE_SECOND = "4194304000";
// a real-shaped 18-digit guild id.
const REAL = "100000000000000001";

describe("isSnowflake", () => {
  test("accepts real ids", () => {
    expect(isSnowflake(REAL)).toBe(true);
    expect(isSnowflake(ONE_SECOND)).toBe(true);
  });

  test("rejects what is not a snowflake", () => {
    for (const bad of ["", "abc", "0", "-1", "1.5", "0123", "123456789012345678901"]) {
      expect(isSnowflake(bad)).toBe(false);
    }
  });
});

describe("snowflakeToDate", () => {
  test("reads the timestamp back out", () => {
    expect(snowflakeToDate(ONE_SECOND).getTime()).toBe(1_420_070_401_000);
  });

  test("a real id lands in the past", () => {
    const date = snowflakeToDate(REAL);
    expect(Number.isFinite(date.getTime())).toBe(true);
    expect(date.getTime()).toBeLessThan(Date.now());
  });

  test("throws on a non-snowflake", () => {
    expect(() => snowflakeToDate("nope")).toThrow("not a snowflake");
  });
});

describe("formatRelative", () => {
  test("renders a discord relative timestamp in seconds", () => {
    expect(formatRelative(ONE_SECOND)).toBe("<t:1420070401:R>");
  });
});

describe("compareSnowflakes", () => {
  test("orders without coercion", () => {
    expect(compareSnowflakes("2", "1")).toBe(1);
    expect(compareSnowflakes("1", "2")).toBe(-1);
    expect(compareSnowflakes(REAL, REAL)).toBe(0);
  });

  test("ids past 2^53 do not collapse to equal", () => {
    // Number("9007199254740993") === Number("9007199254740992"); BigInt is not.
    expect(compareSnowflakes("9007199254740993", "9007199254740992")).toBe(1);
  });

  test("throws on a non-snowflake", () => {
    expect(() => compareSnowflakes("x", "1")).toThrow("not a snowflake");
  });
});
