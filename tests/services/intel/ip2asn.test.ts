// tests/services/intel/ip2asn.test.ts. the ip-to-asn table: the two published
// shapes, a lookup in the middle of a range, an address nobody announces, and
// a file with a broken row in it.

import { describe, expect, test } from "bun:test";
import { ipv4ToNumber, parseIpToAsn } from "../../../src/services/intel/ip2asn.ts";

// the shape with the addresses as text.
const TEXT = [
  "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET",
  "1.0.1.0\t1.0.3.255\t0\tNone\tNot routed",
  "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE",
  "16.0.0.0\t16.0.255.255\t16509\tUS\tAMAZON-02",
  "",
].join("\n");

// the shape with the addresses as numbers.
const NUMBERS = [
  "16777216\t16777471\t13335\tUS\tCLOUDFLARENET",
  "16777472\t16778239\t0\tNone\tNot routed",
  "134744072\t134744327\t15169\tUS\tGOOGLE",
  "268435456\t268956671\t16509\tUS\tAMAZON-02",
  "",
].join("\n");

describe("the ip to asn table", () => {
  test("an address in a range finds its network", () => {
    const table = parseIpToAsn(TEXT);

    expect(table.lookup("8.8.8.8")?.asn).toBe("15169");
    expect(table.lookup("8.8.8.8")?.name).toBe("GOOGLE");
    expect(table.lookup("8.8.8.8")?.country).toBe("us");
  });

  test("the two published shapes read the same", () => {
    const text = parseIpToAsn(TEXT);
    const numbers = parseIpToAsn(NUMBERS);

    expect(numbers.lookup("8.8.8.8")?.asn).toBe("15169");
    expect(numbers.lookup("16.0.0.1")?.name).toBe("AMAZON-02");
    expect(text.count).toBe(numbers.count);
  });

  test("a range nobody announces has no network", () => {
    const table = parseIpToAsn(TEXT);

    expect(table.lookup("1.0.2.0")).toBeNull();
  });

  test("an address outside every range has no network", () => {
    const table = parseIpToAsn(TEXT);

    expect(table.lookup("9.9.9.9")).toBeNull();
  });

  test("an address that is not an ipv4 has no network", () => {
    const table = parseIpToAsn(TEXT);

    expect(table.lookup("2001:db8::1")).toBeNull();
    expect(table.lookup("not an address")).toBeNull();
  });

  test("a broken row costs nothing but itself", () => {
    const table = parseIpToAsn(
      [
        "not an ip\talso not an ip\t13335\tUS\tCLOUDFLARENET",
        "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE",
        "",
      ].join("\n"),
    );

    expect(table.count).toBe(1);
    expect(table.lookup("8.8.8.8")?.asn).toBe("15169");
  });

  test("a file with no usable row is refused", () => {
    expect(() => parseIpToAsn("")).toThrow("SB_INTEL_IP2ASN_INVALID");
  });

  test("an unsorted file still answers", () => {
    const table = parseIpToAsn(
      [
        "16.0.0.0\t16.0.255.255\t16509\tUS\tAMAZON-02",
        "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE",
      ].join("\n"),
    );

    expect(table.lookup("8.8.8.8")?.asn).toBe("15169");
    expect(table.lookup("16.0.0.1")?.asn).toBe("16509");
  });

  test("the address becomes the number the file sorts by", () => {
    expect(ipv4ToNumber("0.0.0.0")).toBe(0);
    expect(ipv4ToNumber("1.0.0.0")).toBe(16_777_216);
    expect(ipv4ToNumber("255.255.255.255")).toBe(4_294_967_295);
    expect(ipv4ToNumber("256.0.0.0")).toBeNull();
    expect(ipv4ToNumber("1.2.3")).toBeNull();
  });
});
