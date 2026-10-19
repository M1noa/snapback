// the country database (D4PLAN 14.4). a maxmind database is three parts: a
// binary search tree over the address bits, a data section holding the
// records, and a metadata block at the end of the file.
//
// the reader is small on purpose and strict on purpose. it answers one
// question: which country is this address in, and which network is it in when
// the file carries one. a file that is not a maxmind database is refused with
// one error code, because a wrong country is worse than no country.
//
// everything here is local. the file belongs to the operator, the address is
// read and dropped, and nothing about it is written down.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export type DbIpErrorCode = "SB_INTEL_MMDB_MISSING" | "SB_INTEL_MMDB_INVALID";

const MESSAGES: Record<DbIpErrorCode, string> = {
  SB_INTEL_MMDB_MISSING: "the country database file is not there",
  SB_INTEL_MMDB_INVALID: "the file is not a readable maxmind database",
};

export class DbIpError extends Error {
  readonly code: DbIpErrorCode;
  constructor(code: DbIpErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "DbIpError";
    this.code = code;
  }
}

/** what one address turned out to be. the address itself is not in here. */
export interface CountryRecord {
  /** two lowercase letters, or null when the file does not say. */
  readonly countryCode: string | null;
  readonly countryName: string | null;
  /** the number only, "15169", or null. */
  readonly asn: string | null;
  readonly isp: string | null;
  readonly asOrg: string | null;
  /** the file calls the address an anonymous proxy rather than a country. */
  readonly isAnonymousProxy: boolean;
}

export interface CountryDatabase {
  /** what the file says about one address, or null when it says nothing. */
  lookup(address: string): CountryRecord | null;
}

// the marker in front of the metadata block. the last occurrence of it in the
// file is the start of the metadata.
const MARKER = new Uint8Array([
  0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d,
]);
// null bytes between the search tree and the data section.
const DATA_SEPARATOR_SIZE = 16;
// the record sizes the format allows: 24, 28, or 32 bits.
const RECORD_SIZES = [24, 28, 32];
// the format itself sets no limits, so the reader sets its own. a data entry
// that decodes into more than this is not a real database.
const MAX_DEPTH = 64;
const MAX_VALUES = 65_536;

interface Metadata {
  readonly nodeCount: number;
  readonly recordSize: number;
  readonly ipVersion: number;
  readonly searchTreeSize: number;
  readonly databaseType: string;
}

interface Budget {
  values: number;
}

interface Decoded {
  readonly value: unknown;
  readonly next: number;
}

function invalid(): DbIpError {
  return new DbIpError("SB_INTEL_MMDB_INVALID");
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isAnonymousProxyName(value: string | null): boolean {
  return value !== null && value.toLowerCase() === "anonymous proxy";
}

/** the country, the network, and the flags the file carries for one address. */
function recordFrom(value: unknown): CountryRecord {
  const empty: CountryRecord = {
    countryCode: null,
    countryName: null,
    asn: null,
    isp: null,
    asOrg: null,
    isAnonymousProxy: false,
  };
  if (typeof value === "string") {
    const name = asText(value);
    return { ...empty, countryName: name, isAnonymousProxy: isAnonymousProxyName(name) };
  }
  const map = asObject(value);
  if (map === null) return empty;

  const country = asObject(map.country) ?? asObject(map.registered_country);
  const countryText = country === null ? asText(map.country) : null;
  const code = asText(country?.iso_code);
  const names = asObject(country?.names);
  let name = country === null ? countryText : asText(names?.en);
  if (name === null && names !== null) {
    for (const candidate of Object.values(names)) {
      const text = asText(candidate);
      if (text !== null) {
        name = text;
        break;
      }
    }
  }
  const rawAsn = map.autonomous_system_number;
  const asn =
    typeof rawAsn === "number" && Number.isFinite(rawAsn) ? String(rawAsn) : asText(rawAsn);
  const isp = asText(map.isp);
  return {
    countryCode: code !== null && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null,
    countryName: name,
    asn,
    isp,
    asOrg: asText(map.autonomous_system_organization),
    isAnonymousProxy: isAnonymousProxyName(name) || isAnonymousProxyName(isp),
  };
}

/** decodes the data section format: a control byte, then a payload. */
class DataReader {
  readonly bytes: Uint8Array;
  /** where this section starts. pointers count from here, not from the file. */
  readonly sectionStart: number;

  constructor(bytes: Uint8Array, sectionStart: number) {
    this.bytes = bytes;
    this.sectionStart = sectionStart;
  }

  /** a big-endian unsigned integer of the given byte length. */
  uint(offset: number, length: number): number {
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      value = value * 256 + (this.bytes[offset + index] ?? 0);
    }
    return value;
  }

  /** the size of a payload, or the number of entries for a map or an array. */
  size(sizeBits: number, cursor: number): { length: number; next: number } {
    if (sizeBits < 29) return { length: sizeBits, next: cursor };
    if (sizeBits === 29) return { length: 29 + (this.bytes[cursor] ?? 0), next: cursor + 1 };
    if (sizeBits === 30) return { length: 285 + this.uint(cursor, 2), next: cursor + 2 };
    return { length: 65_821 + this.uint(cursor, 3), next: cursor + 3 };
  }

  /** the value at an offset, and the offset just after it. */
  decode(offset: number, depth: number, budget: Budget): Decoded {
    if (depth > MAX_DEPTH) throw invalid();
    budget.values += 1;
    if (budget.values > MAX_VALUES) throw invalid();

    const control = this.bytes[offset];
    if (control === undefined) throw invalid();
    let type = control >> 5;
    let cursor = offset + 1;
    if (type === 0) {
      type = (this.bytes[cursor] ?? 0) + 7;
      cursor += 1;
    }
    const sizeBits = control & 0x1f;

    if (type === 1) return this.decodePointer(control, cursor, depth, budget);

    if (type === 7) {
      const { length: count, next } = this.size(sizeBits, cursor);
      const map: Record<string, unknown> = {};
      let at = next;
      for (let index = 0; index < count; index += 1) {
        const key = this.decode(at, depth + 1, budget);
        const value = this.decode(key.next, depth + 1, budget);
        const name = asText(key.value);
        if (name !== null) map[name] = value.value;
        at = value.next;
      }
      return { value: map, next: at };
    }

    if (type === 11) {
      const { length: count, next } = this.size(sizeBits, cursor);
      const items: unknown[] = [];
      let at = next;
      for (let index = 0; index < count; index += 1) {
        const item = this.decode(at, depth + 1, budget);
        items.push(item.value);
        at = item.next;
      }
      return { value: items, next: at };
    }

    const { length, next } = this.size(sizeBits, cursor);
    if (type === 2) {
      const text = new TextDecoder().decode(this.bytes.subarray(next, next + length));
      return { value: text, next: next + length };
    }
    if (type === 4) {
      return { value: this.bytes.slice(next, next + length), next: next + length };
    }
    if (type === 14) {
      return { value: length !== 0, next };
    }
    if (type === 5 || type === 6 || type === 8 || type === 9) {
      const value = this.uint(next, length);
      if (type === 8 && length === 4) {
        // a signed 32 bit int, in two's complement.
        return { value: value > 0x7fffffff ? value - 0x1_0000_0000 : value, next: next + length };
      }
      return { value, next: next + length };
    }
    if (type === 10) {
      // a 128 bit int does not fit a number, so it is kept as digits.
      let digits = "0";
      for (let index = 0; index < length; index += 1) {
        digits = (BigInt(digits) * 256n + BigInt(this.bytes[next + index] ?? 0)).toString();
      }
      return { value: digits, next: next + length };
    }
    if (type === 3 || type === 15) {
      const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      const value = type === 3 ? view.getFloat64(next, false) : view.getFloat32(next, false);
      return { value, next: next + length };
    }
    throw invalid();
  }

  /** a pointer to another field in the same section. */
  decodePointer(control: number, cursor: number, depth: number, budget: Budget): Decoded {
    const size = (control >> 3) & 0x03;
    let target = 0;
    let next = cursor;
    if (size === 0) {
      target = ((control & 0x07) << 8) | (this.bytes[cursor] ?? 0);
      next = cursor + 1;
    } else if (size === 1) {
      target = (((control & 0x07) << 16) | this.uint(cursor, 2)) + 2048;
      next = cursor + 2;
    } else if (size === 2) {
      target = (((control & 0x07) << 24) | this.uint(cursor, 3)) + 526_336;
      next = cursor + 3;
    } else {
      target = this.uint(cursor, 4);
      next = cursor + 4;
    }
    const resolved = this.decode(this.sectionStart + target, depth + 1, budget);
    return { value: resolved.value, next };
  }
}

/** the address bits, in the order the tree walks them. */
function addressBits(address: string): Uint8Array | null {
  const value = address.trim();
  const kind = isIP(value);
  if (kind === 4) {
    const bytes = new Uint8Array(4);
    for (let index = 0; index < 4; index += 1) {
      bytes[index] = Number(value.split(".")[index] ?? 0);
    }
    return bytes;
  }
  if (kind !== 6) return null;
  const bytes = expandIpv6(value);
  if (bytes === null) return null;
  // an ipv4-mapped address is the same address as the ipv4 (D4PLAN 14.1).
  const mapped =
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (!mapped) return bytes;
  return bytes.slice(12);
}

/** the sixteen bytes of an ipv6 address, from its written form. */
function expandIpv6(value: string): Uint8Array | null {
  let text = value;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const parts = tail.split(".").map((part) => Number(part));
    const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + rest.length > 8) return null;
  const groups =
    halves.length === 2
      ? [...head, ...new Array<string>(8 - head.length - rest.length).fill("0"), ...rest]
      : head;
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] ?? "";
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const number = Number.parseInt(group, 16);
    bytes[index * 2] = (number >> 8) & 0xff;
    bytes[index * 2 + 1] = number & 0xff;
  }
  return bytes;
}

/** the file, opened and checked. */
class Database implements CountryDatabase {
  readonly bytes: Uint8Array;
  readonly metadata: Metadata;
  readonly nodeByteSize: number;

  constructor(bytes: Uint8Array, metadata: Metadata) {
    this.bytes = bytes;
    this.metadata = metadata;
    this.nodeByteSize = (metadata.recordSize * 2) / 8;
  }

  /** one record of the search tree. */
  record(node: number, index: number): number {
    const base = node * this.nodeByteSize;
    if (this.metadata.recordSize === 24) {
      const at = base + index * 3;
      return this.uint(at, 3);
    }
    if (this.metadata.recordSize === 28) {
      const middle = this.bytes[base + 3] ?? 0;
      if (index === 0) {
        return ((middle >> 4) << 24) | this.uint(base, 3);
      }
      return ((middle & 0x0f) << 24) | this.uint(base + 4, 3);
    }
    return this.uint(base + index * 4, 4);
  }

  uint(offset: number, length: number): number {
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      value = value * 256 + (this.bytes[offset + index] ?? 0);
    }
    return value;
  }

  lookup(address: string): CountryRecord | null {
    const bytes = addressBits(address);
    if (bytes === null) return null;
    const ipv4 = bytes.length === 4;
    if (this.metadata.ipVersion === 4 && !ipv4) return null;

    // an ipv4 address inside an ipv6 tree sits under 96 zero bits.
    const bitLength = this.metadata.ipVersion === 6 && ipv4 ? 128 : bytes.length * 8;
    const bits = new Uint8Array(bitLength);
    const bitOffset = this.metadata.ipVersion === 6 && ipv4 ? 96 : 0;
    for (let index = 0; index < bytes.length * 8; index += 1) {
      bits[bitOffset + index] = ((bytes[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;
    }
    let node = 0;
    let value = -1;
    for (let bit = 0; bit < bitLength; bit += 1) {
      value = this.record(node, bits[bit] ?? 0);
      if (value === this.metadata.nodeCount) return null;
      if (value > this.metadata.nodeCount) break;
      node = value;
    }
    if (value <= this.metadata.nodeCount) return null;

    const dataStart = this.metadata.searchTreeSize + DATA_SEPARATOR_SIZE;
    const dataOffset = value - this.metadata.nodeCount - DATA_SEPARATOR_SIZE;
    const reader = new DataReader(this.bytes, dataStart);
    const decoded = reader.decode(dataStart + dataOffset, 0, { values: 0 });
    return recordFrom(decoded.value);
  }
}

/** the metadata block at the end of the file. */
function readMetadata(bytes: Uint8Array, markerAt: number): Metadata {
  const reader = new DataReader(bytes, markerAt + MARKER.length);
  const decoded = reader.decode(markerAt + MARKER.length, 0, { values: 0 });
  const map = asObject(decoded.value);
  if (map === null) throw invalid();
  const nodeCount = map.node_count;
  const recordSize = map.record_size;
  const ipVersion = map.ip_version;
  if (
    typeof nodeCount !== "number" ||
    !Number.isInteger(nodeCount) ||
    nodeCount <= 0 ||
    typeof recordSize !== "number" ||
    !RECORD_SIZES.includes(recordSize) ||
    (ipVersion !== 4 && ipVersion !== 6)
  ) {
    throw invalid();
  }
  const major = map.binary_format_major_version;
  if (major !== undefined && major !== 2) throw invalid();
  // the size of the search tree is worked out from the nodes and the record
  // size. a file that states it must state it right.
  const searchTreeSize = nodeCount * ((recordSize * 2) / 8);
  const stated = map.search_tree_size;
  if (stated !== undefined && stated !== searchTreeSize) throw invalid();
  return {
    nodeCount,
    recordSize,
    ipVersion,
    searchTreeSize,
    databaseType: asText(map.database_type) ?? "",
  };
}

/** opens the country database. a file that is not a maxmind database is an
 *  error, never a wrong answer. */
export function openCountryDatabase(path: string): CountryDatabase {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DbIpError(code === "ENOENT" ? "SB_INTEL_MMDB_MISSING" : "SB_INTEL_MMDB_INVALID");
  }
  if (bytes.length < MARKER.length) throw invalid();
  const markerAt = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).lastIndexOf(
    Buffer.from(MARKER),
  );
  if (markerAt < 0) throw invalid();
  return new Database(bytes, readMetadata(bytes, markerAt));
}
