// tests/services/intel/tor.test.ts. the exit list: an address on it is a tor
// exit, exactly, and an address that is not on it is not.

import { describe, expect, test } from "bun:test";
import { parseTorExits } from "../../../src/services/intel/tor.ts";

// the shape the tor project publishes.
const PUBLISHED = [
  "ExitNode 64D74AAA74F30DC2CFB36343CE5D4451B9A4DBA8",
  "Published 2026-10-21 04:01:36",
  "LastStatus 2026-10-21 19:00:00",
  "ExitAddress 171.25.193.25 2026-10-21 19:09:41",
  "ExitNode 0DC16FEAA5A5E27A974009CBF7748BB6FAAE6DE1",
  "Published 2026-10-21 13:49:36",
  "LastStatus 2026-10-21 18:00:00",
  "ExitAddress 80.67.167.81 2026-10-21 18:04:30",
  "",
].join("\n");

describe("the tor exit list", () => {
  test("an address on the list is a tor exit", () => {
    const exits = parseTorExits(PUBLISHED);

    expect(exits.count).toBe(2);
    expect(exits.has("171.25.193.25")).toBe(true);
    expect(exits.has("80.67.167.81")).toBe(true);
  });

  test("an address that is not on the list is not", () => {
    const exits = parseTorExits(PUBLISHED);

    expect(exits.has("8.8.8.8")).toBe(false);
  });

  test("the address is read the same however it is written", () => {
    const exits = parseTorExits(PUBLISHED);

    expect(exits.has(" 171.25.193.25 ")).toBe(true);
  });

  test("a list with no address in it is refused", () => {
    expect(() => parseTorExits("Published 2026-10-21 04:01:36\n")).toThrow("SB_INTEL_TOR_INVALID");
  });
});
