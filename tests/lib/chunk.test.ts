import { describe, expect, test } from "bun:test";
import { chunk } from "../../src/lib/chunk.ts";

describe("chunk", () => {
  test("splits with a short final page", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("an exact multiple has no trailing empty page", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("an empty list is zero pages", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  test("size 1 is one item per page", () => {
    expect(chunk(["a", "b"], 1)).toEqual([["a"], ["b"]]);
  });

  test("a non-positive size throws", () => {
    expect(() => chunk([1], 0)).toThrow("chunk size must be >= 1");
    expect(() => chunk([1], -3)).toThrow("chunk size must be >= 1");
  });
});
