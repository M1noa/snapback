// tests/services/intel/dbip.test.ts. the country database reader against a
// hand built maxmind file. the file is built to the real layout, so the
// reader is exercised the way a db-ip file exercises it, and a file that is
// not a database at all is refused instead of answered.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbIpError, openCountryDatabase } from "../../../src/services/intel/dbip.ts";

const MARKER = new Uint8Array([
  0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d,
]);

const directory = mkdtempSync(join(tmpdir(), "snapback-intel-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, bytes: Uint8Array | string): string {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  return path;
}

// --- the fixture --------------------------------------------------------

function encodeString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < 29) {
    const out = new Uint8Array(1 + bytes.length);
    out[0] = 0x40 | bytes.length;
    out.set(bytes, 1);
    return out;
  }
  // a longer string takes the extended size: the control byte says 29, and
  // the next byte carries the rest of the length.
  const out = new Uint8Array(2 + bytes.length);
  out[0] = 0x40 | 29;
  out[1] = bytes.length - 29;
  out.set(bytes, 2);
  return out;
}

function encodeUint(type: number, value: number, length: number): Uint8Array {
  // an extended type takes a second byte for the type, the others do not.
  const extended = type === 9;
  const out = new Uint8Array((extended ? 2 : 1) + length);
  if (extended) {
    out[0] = length;
    out[1] = type - 7;
  } else {
    out[0] = (type << 5) | length;
  }
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[(extended ? 2 : 1) + index] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function encodeMap(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xe0 | entries.length])];
  for (const [key, value] of entries) parts.push(encodeString(key), value);
  return concat(parts);
}

function encodeArray(items: readonly Uint8Array[]): Uint8Array {
  return concat([new Uint8Array([items.length, 11 - 7]), ...items]);
}

function countryRecord(code: string, name: string): Uint8Array {
  return encodeMap([
    [
      "country",
      encodeMap([
        ["iso_code", encodeString(code)],
        ["names", encodeMap([["en", encodeString(name)]])],
      ]),
    ],
  ]);
}

function networkRecord(
  code: string,
  name: string,
  asn: number,
  isp: string,
  org: string,
): Uint8Array {
  return encodeMap([
    [
      "country",
      encodeMap([
        ["iso_code", encodeString(code)],
        ["names", encodeMap([["en", encodeString(name)]])],
      ]),
    ],
    ["autonomous_system_number", encodeUint(6, asn, 4)],
    ["autonomous_system_organization", encodeString(org)],
    ["isp", encodeString(isp)],
  ]);
}

interface Slot {
  node: TrieNode | null;
  data: number | null;
}

interface TrieNode {
  zero: Slot;
  one: Slot;
}

function emptyNode(): TrieNode {
  return { zero: { node: null, data: null }, one: { node: null, data: null } };
}

function ipv4Bits(address: string): number[] {
  const bits: number[] = [];
  for (const part of address.split(".")) {
    const value = Number(part);
    for (let index = 7; index >= 0; index -= 1) bits.push((value >> index) & 1);
  }
  return bits;
}

interface FixtureNetwork {
  readonly address: string;
  readonly length: number;
  readonly record: Uint8Array;
}

/** builds a maxmind file: a 24 bit search tree, a data section, and the
 *  metadata block that describes them. */
function buildMmdb(networks: readonly FixtureNetwork[]): Uint8Array {
  const root = emptyNode();
  for (const [index, network] of networks.entries()) {
    const bits = ipv4Bits(network.address);
    let node = root;
    for (let bit = 0; bit < network.length - 1; bit += 1) {
      const slot = bits[bit] === 1 ? node.one : node.zero;
      if (slot.node === null) slot.node = emptyNode();
      node = slot.node;
    }
    const last = bits[network.length - 1] === 1 ? node.one : node.zero;
    if (last.node === null) last.data = index;
  }

  const nodes: TrieNode[] = [root];
  const numbers = new Map<TrieNode, number>([[root, 0]]);
  for (let at = 0; at < nodes.length; at += 1) {
    const node = nodes[at];
    if (node === undefined) continue;
    for (const slot of [node.zero, node.one]) {
      if (slot.node !== null && !numbers.has(slot.node)) {
        numbers.set(slot.node, nodes.length);
        nodes.push(slot.node);
      }
    }
  }
  const nodeCount = nodes.length;

  const dataParts: Uint8Array[] = [];
  const dataOffsets: number[] = [];
  let dataAt = 0;
  for (const network of networks) {
    dataOffsets.push(dataAt);
    dataParts.push(network.record);
    dataAt += network.record.length;
  }

  const tree = new Uint8Array(nodeCount * 6);
  const value = (slot: Slot): number => {
    if (slot.node !== null) return numbers.get(slot.node) ?? 0;
    if (slot.data !== null) return nodeCount + 16 + (dataOffsets[slot.data] ?? 0);
    return nodeCount;
  };
  for (const [index, node] of nodes.entries()) {
    const base = index * 6;
    const zero = value(node.zero);
    const one = value(node.one);
    tree[base] = (zero >> 16) & 0xff;
    tree[base + 1] = (zero >> 8) & 0xff;
    tree[base + 2] = zero & 0xff;
    tree[base + 3] = (one >> 16) & 0xff;
    tree[base + 4] = (one >> 8) & 0xff;
    tree[base + 5] = one & 0xff;
  }

  const metadata = encodeMap([
    ["binary_format_major_version", encodeUint(5, 2, 2)],
    ["binary_format_minor_version", encodeUint(5, 0, 2)],
    ["build_epoch", encodeUint(9, 1_700_000_000, 8)],
    ["database_type", encodeString("DBIP-Country-Lite")],
    ["description", encodeMap([["en", encodeString("test fixture")]])],
    ["ip_version", encodeUint(5, 4, 2)],
    ["languages", encodeArray([encodeString("en")])],
    ["node_count", encodeUint(6, nodeCount, 4)],
    ["record_size", encodeUint(5, 24, 2)],
    ["search_tree_size", encodeUint(6, nodeCount * 6, 4)],
  ]);

  return concat([tree, new Uint8Array(16), concat(dataParts), MARKER, metadata]);
}

const FIXTURE = buildMmdb([
  { address: "10.0.0.0", length: 8, record: countryRecord("US", "United States") },
  { address: "20.0.0.0", length: 8, record: countryRecord("DE", "Germany") },
  { address: "200.0.0.0", length: 8, record: countryRecord("FR", "France") },
  {
    address: "1.2.3.0",
    length: 24,
    record: networkRecord("US", "United States", 15169, "Google LLC", "GOOGLE"),
  },
  {
    address: "203.0.113.0",
    length: 24,
    record: encodeString("Anonymous Proxy"),
  },
]);

// --- the tests ----------------------------------------------------------

describe("the country database", () => {
  test("a file that is not a maxmind database is refused with the fixed code", () => {
    const path = write("notes.mmdb", "this is a text file, not a database\n");

    expect(() => openCountryDatabase(path)).toThrow(DbIpError);
    expect(() => openCountryDatabase(path)).toThrow("SB_INTEL_MMDB_INVALID");
  });

  test("a file that is not there is missing, not invalid", () => {
    expect(() => openCountryDatabase(join(directory, "absent.mmdb"))).toThrow(
      "SB_INTEL_MMDB_MISSING",
    );
  });

  test("a country is read from the database", () => {
    const database = openCountryDatabase(write("country.mmdb", FIXTURE));

    const record = database.lookup("10.1.2.3");
    expect(record?.countryCode).toBe("us");
    expect(record?.countryName).toBe("United States");
    expect(record?.isAnonymousProxy).toBe(false);
  });

  test("the country of the second network is the second country", () => {
    const database = openCountryDatabase(write("country.mmdb", FIXTURE));

    expect(database.lookup("20.5.6.7")?.countryCode).toBe("de");
    expect(database.lookup("200.5.6.7")?.countryCode).toBe("fr");
  });

  test("the network behind the address comes with it", () => {
    const database = openCountryDatabase(write("country.mmdb", FIXTURE));

    const record = database.lookup("1.2.3.4");
    expect(record?.asn).toBe("15169");
    expect(record?.isp).toBe("Google LLC");
    expect(record?.asOrg).toBe("GOOGLE");
  });

  test("an address in no range is unknown", () => {
    const database = openCountryDatabase(write("country.mmdb", FIXTURE));

    expect(database.lookup("30.1.2.3")).toBeNull();
    expect(database.lookup("not an address")).toBeNull();
  });

  test("an anonymous proxy is not a country", () => {
    const database = openCountryDatabase(write("country.mmdb", FIXTURE));

    const record = database.lookup("203.0.113.9");
    expect(record?.isAnonymousProxy).toBe(true);
    expect(record?.countryCode).toBeNull();
    expect(record?.countryName).toBe("Anonymous Proxy");
  });
});
