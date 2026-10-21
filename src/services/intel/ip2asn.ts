// the ip-to-asn table (D4PLAN 14.4). one row per announced ipv4 range: the
// first address, the last address, the asn, the country the network is
// registered in, and the organisation's own name.
//
// two shapes are published: one with the addresses as text, one with them as
// numbers. both are read here, so a copy of either keeps working.
//
// the file is public domain and it changes every day. the bot downloads it
// (see update.ts); the operator may drop their own copy in its place.
//
// the address is personal data. it is looked up and dropped. nothing here
// stores it and nothing here logs it.

export type IpToAsnErrorCode = "SB_INTEL_IP2ASN_MISSING" | "SB_INTEL_IP2ASN_INVALID";

const MESSAGES: Record<IpToAsnErrorCode, string> = {
  SB_INTEL_IP2ASN_MISSING: "the ip to asn file is not there",
  SB_INTEL_IP2ASN_INVALID: "the ip to asn file has no usable rows",
};

export class IpToAsnError extends Error {
  readonly code: IpToAsnErrorCode;
  constructor(code: IpToAsnErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "IpToAsnError";
    this.code = code;
  }
}

/** one network, as the file describes it. */
export interface AsNetwork {
  /** the number only, "15169". */
  readonly asn: string;
  /** the organisation's own name, or null. */
  readonly name: string | null;
  /** the country the network is registered in, two lowercase letters, or null. */
  readonly country: string | null;
}

export interface IpToAsn {
  /** how many ranges the file holds. */
  readonly count: number;
  /** the network behind an address, or null when the file does not have it. */
  lookup(address: string): AsNetwork | null;
}

/** the address as the number the file sorts by. null when it is not an ipv4. */
export function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** the country cell. the file writes "None" for a network without one. */
function readCountry(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** the name cell. "Not routed" is not an organisation. */
function readName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "not routed") return null;
  return trimmed;
}

/** the asn cell. 0 means the range is announced by nobody. */
function readAsn(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  if (trimmed === "0") return null;
  return trimmed;
}

/** one row, from either file shape. */
interface Row {
  readonly start: number;
  readonly end: number;
  readonly asn: string | null;
  readonly country: string | null;
  readonly name: string | null;
}

function readRow(line: string): Row | null {
  const fields = line.split("\t");
  if (fields.length < 3) return null;
  const first = fields[0]?.trim() ?? "";
  const second = fields[1]?.trim() ?? "";
  if (first === "" || second === "") return null;

  // the two published shapes: the addresses as text, or as numbers.
  const start = /^\d+$/.test(first) ? Number(first) : ipv4ToNumber(first);
  const end = /^\d+$/.test(second) ? Number(second) : ipv4ToNumber(second);
  if (start === null || end === null) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const asn = readAsn(fields[2]);
  return {
    start,
    end,
    asn,
    country: readCountry(fields[3]),
    name: readName(fields[4]),
  };
}

/**
 * parses the table.
 *
 * the ranges are read into three typed arrays and searched with a binary
 * search, so a lookup costs the same whether the file holds ten thousand
 * ranges or half a million.
 */
export function parseIpToAsn(text: string): IpToAsn {
  const starts: number[] = [];
  const ends: number[] = [];
  const asnIndexes: number[] = [];
  const networks: AsNetwork[] = [];
  const byAsn = new Map<string, number>();

  let index = 0;
  let end = 0;
  while (index < text.length) {
    end = text.indexOf("\n", index);
    if (end === -1) end = text.length;
    const line = text.slice(index, end);
    index = end + 1;
    if (line === "") continue;
    const row = readRow(line);
    if (row === null) continue;

    let asnIndex = -1;
    if (row.asn !== null) {
      const known = byAsn.get(row.asn);
      if (known === undefined) {
        asnIndex = networks.length;
        networks.push({ asn: row.asn, name: row.name, country: row.country });
        byAsn.set(row.asn, asnIndex);
      } else {
        asnIndex = known;
      }
    }
    starts.push(row.start);
    ends.push(row.end);
    asnIndexes.push(asnIndex);
  }

  if (starts.length === 0) throw new IpToAsnError("SB_INTEL_IP2ASN_INVALID");

  // the published file is sorted by the first address. it is checked rather
  // than assumed, because a binary search over an unsorted table answers
  // wrongly and never says so.
  let sorted = true;
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i]! < starts[i - 1]!) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    const order = starts.map((_, i) => i).sort((a, b) => starts[a]! - starts[b]!);
    const sortedStarts = new Uint32Array(order.length);
    const sortedEnds = new Uint32Array(order.length);
    const sortedAsns = new Int32Array(order.length);
    for (let i = 0; i < order.length; i += 1) {
      const at = order[i]!;
      sortedStarts[i] = starts[at]!;
      sortedEnds[i] = ends[at]!;
      sortedAsns[i] = asnIndexes[at]!;
    }
    return table(sortedStarts, sortedEnds, sortedAsns, networks);
  }

  return table(
    Uint32Array.from(starts),
    Uint32Array.from(ends),
    Int32Array.from(asnIndexes),
    networks,
  );
}

function table(
  starts: Uint32Array,
  ends: Uint32Array,
  asnIndexes: Int32Array,
  networks: readonly AsNetwork[],
): IpToAsn {
  return {
    count: starts.length,
    lookup(address: string): AsNetwork | null {
      const value = ipv4ToNumber(address);
      if (value === null) return null;
      // the greatest start that is not above the address.
      let low = 0;
      let high = starts.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (starts[middle]! <= value) {
          found = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (found === -1) return null;
      if (value > ends[found]!) return null;
      const asnIndex = asnIndexes[found]!;
      if (asnIndex < 0) return null;
      return networks[asnIndex] ?? null;
    },
  };
}

/** reads the file and parses it. */
export async function loadIpToAsn(path: string): Promise<IpToAsn> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new IpToAsnError("SB_INTEL_IP2ASN_MISSING");
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new IpToAsnError("SB_INTEL_IP2ASN_INVALID");
  }
  return parseIpToAsn(text);
}
