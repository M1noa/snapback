import { describe, expect, test } from "bun:test";
import {
  parseJson,
  RowError,
  stringifyJson,
  toBigInt,
  toBool,
  toId,
  toNumber,
  toText,
} from "../../src/db/rows.ts";

describe("toId", () => {
  test("a bigint column becomes a string", () => {
    expect(toId(123n)).toBe("123");
    expect(toId(9007199254740993n)).toBe("9007199254740993");
  });

  test("a string column is already a string and passes through", () => {
    expect(toId("144102483157850112")).toBe("144102483157850112");
  });

  test("null and undefined pass through untouched", () => {
    expect(toId(null)).toBeNull();
    expect(toId(undefined)).toBeUndefined();
  });

  test("a snowflake that is a BigInt becomes a string that still round-trips", () => {
    const snowflake = 1234567890123456789n;
    const asString = toId(snowflake) as string;
    expect(asString).toBe("1234567890123456789");
    expect(BigInt(asString)).toBe(snowflake);
  });

  test("a numeric id is refused, not silently stringified", () => {
    expect(() => toId(123)).toThrow(/SB_ROW_EXPECTED_STRING/);
  });
});

describe("toText", () => {
  test("null and undefined pass through untouched", () => {
    expect(toText(null)).toBeNull();
    expect(toText(undefined)).toBeUndefined();
  });

  test("an ISO timestamp string is untouched", () => {
    const iso = "2024-01-02T03:04:05.678Z";
    expect(toText(iso)).toBe(iso);
  });

  test("a number where a string is required throws, not coerces", () => {
    expect(() => toText(123)).toThrow(/SB_ROW_EXPECTED_STRING/);
  });
});

describe("toBool", () => {
  test("a boolean passes through", () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(false)).toBe(false);
  });

  test("0 and 1 convert, as number or bigint", () => {
    expect(toBool(0)).toBe(false);
    expect(toBool(1)).toBe(true);
    expect(toBool(0n)).toBe(false);
    expect(toBool(1n)).toBe(true);
  });

  test("nullish passes through and a non-boolean throws", () => {
    expect(toBool(null)).toBeNull();
    expect(toBool(undefined)).toBeUndefined();
    expect(() => toBool(2)).toThrow(/SB_ROW_EXPECTED_BOOLEAN/);
  });
});

describe("toNumber", () => {
  test("a bigint count within range becomes a number", () => {
    expect(toNumber(42n)).toBe(42);
    expect(toNumber(1024)).toBe(1024);
    expect(toNumber(null)).toBeNull();
  });

  test("a bigint past the safe range throws instead of rounding", () => {
    expect(() => toNumber(9007199254740993n)).toThrow(/SB_ROW_EXPECTED_NUMBER/);
  });
});

describe("toBigInt", () => {
  test("a string id becomes a bigint for the driver", () => {
    expect(toBigInt("1234567890123456789")).toBe(1234567890123456789n);
    expect(toBigInt(null)).toBeNull();
  });

  test("a js number is refused on the way down too", () => {
    expect(() => toBigInt(123)).toThrow(/SB_ROW_EXPECTED_STRING/);
  });
});

describe("json columns", () => {
  test("json text parses back to a value", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("[1,2]")).toEqual([1, 2]);
  });

  test("nullish json stays null and bad json throws", () => {
    expect(parseJson(null)).toBeNull();
    expect(parseJson(undefined)).toBeNull();
    expect(() => parseJson("not json")).toThrow(/SB_ROW_BAD_JSON/);
  });

  test("a value stringifies, nullish becomes null", () => {
    expect(stringifyJson({ a: 1 })).toBe('{"a":1}');
    expect(stringifyJson(null)).toBeNull();
    expect(stringifyJson(undefined)).toBeNull();
  });
});

describe("RowError", () => {
  test("the message leads with the code and the code is exposed", () => {
    try {
      toId(123);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowError);
      const rowError = error as RowError;
      expect(rowError.code).toBe("SB_ROW_EXPECTED_STRING");
      expect(rowError.message).toStartWith("SB_ROW_EXPECTED_STRING");
    }
  });
});
