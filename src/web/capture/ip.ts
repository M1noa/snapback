// the client ip (D4PLAN 14.1, 14.5). one address per request, resolved with the
// documented precedence and stored in the mode the operator chose.
//
// the order (docs/cloudflare-tunnel.md):
//   1. behind a cloudflare tunnel: CF-Connecting-IP, validated. X-Forwarded-For
//      is ignored in this mode, because cloudflare rewrites it itself.
//   2. else with TRUSTED_PROXY_DEPTH > 0: walk X-Forwarded-For from the right,
//      skip that many hops, take the first valid address past them.
//   3. else: the socket address.
//
// an ip is personal data. it never reaches a log line and never lands in a row
// as a bare string when a mode is configured, so the address and the stored
// form are separate fields here: a caller that logs the wrong one gets it
// right.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { IpStorage } from "../../config/parse-env.ts";

export interface IpCaptureOptions {
  readonly behindCloudflareTunnel: boolean;
  readonly trustedProxyDepth: number;
  /** "hash" | "encrypted" | "plaintext". */
  readonly storage: IpStorage;
  readonly hashPepper: string;
  readonly encryptionKey: string;
}

export interface CapturedIp {
  /** the address itself, for the operator's eyes. never logged. */
  readonly address: string | null;
  /** what goes in the row: the hash, the ciphertext, or the plain address. */
  readonly stored: string | null;
  readonly mode: IpStorage;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** the address a candidate string really holds, or null when it holds nothing.
 *  a header can carry anything, so every candidate is validated before use and
 *  an invalid one is discarded rather than passed on. */
function normaliseAddress(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;
  // a proxy may bracket an ipv6, and a zone id is not part of the address.
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1).trim();
  }
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value === "") return null;
  // an ipv4-mapped ipv6 is the same address as the ipv4 (D4PLAN 14.1 step 3).
  if (value.toLowerCase().startsWith("::ffff:")) {
    const tail = value.slice(7);
    if (isIP(tail) === 4) value = tail;
  }
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind !== 6) return null;
  // one spelling per address, so the same address hashes the same way however
  // it was written.
  return canonicalIpv6(value);
}

/** the compressed, lowercase form of an ipv6. the url parser is the shortest
 *  correct implementation of that and it rejects anything malformed. */
function canonicalIpv6(value: string): string | null {
  try {
    const url = new URL(`http://[${value}]/`);
    return url.hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function privateIpv4(value: string): boolean {
  const parts = value.split(".");
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (first === 0) return true; // this network
  if (first === 10) return true;
  if (first === 127) return true; // loopback
  if (first === 169 && second === 254) return true; // link-local
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  return false;
}

function privateIpv6(value: string): boolean {
  const head = value.split(":")[0] ?? "";
  // "::" and "::1" and the mapped form all start with an empty group.
  if (head === "") return true;
  const group = Number.parseInt(head, 16);
  if (!Number.isFinite(group)) return false;
  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** whether an address is routable on the public internet. a record with a
 *  private or loopback address is the signature of a misconfigured tunnel, so
 *  the caller flags the record rather than hiding the address. */
export function isPublicAddress(address: string): boolean {
  const value = normaliseAddress(address);
  if (value === null) return false;
  const kind = isIP(value);
  if (kind === 4) return !privateIpv4(value);
  if (kind === 6) return !privateIpv6(value);
  return false;
}

/** the client address for one request, or null when nothing resolved to one.
 *  the socket is the last resort: it is the proxy's own address when a proxy
 *  is in front, and a loopback there is exactly what the operator needs to
 *  see. */
function resolveAddress(
  headers: Headers,
  socketAddress: string | null,
  options: IpCaptureOptions,
): string | null {
  if (options.behindCloudflareTunnel) {
    const header = headers.get("cf-connecting-ip");
    if (header !== null) {
      const candidate = normaliseAddress(header);
      if (candidate !== null) return candidate;
    }
    return socketCandidate(socketAddress);
  }
  if (options.trustedProxyDepth > 0) {
    const chain = headers.get("x-forwarded-for");
    if (chain !== null) {
      const candidate = fromForwardedChain(chain, options.trustedProxyDepth);
      if (candidate !== null) return candidate;
    }
    return socketCandidate(socketAddress);
  }
  return socketCandidate(socketAddress);
}

function socketCandidate(socketAddress: string | null): string | null {
  if (socketAddress === null) return null;
  return normaliseAddress(socketAddress);
}

/** the first valid address past the trusted hops. the hops are the right-most
 *  entries, so the client sits that many places to their left; a candidate
 *  that is not an address is discarded and the next one to the left is used. */
function fromForwardedChain(chain: string, depth: number): string | null {
  const entries = chain
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (let index = entries.length - depth - 1; index >= 0; index -= 1) {
    const candidate = normaliseAddress(entries[index] ?? "");
    if (candidate !== null) return candidate;
  }
  return null;
}

/** the keyed hash of an address. the same address with the same pepper always
 *  gives the same value, so two visits correlate without the address being
 *  recoverable from the row. */
export function hashAddress(address: string, pepper: string): string {
  if (pepper === "") {
    throw new Error("IP_HASH_PEPPER is not set, so the address cannot be hashed");
  }
  return createHmac("sha512", pepper).update(address).digest("hex");
}

/** the address in aes-256-gcm ciphertext, with a random iv per value. */
export function encryptAddress(address: string, key: string): string {
  const bytes = decodeKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(address, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const parts = [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ];
  return parts.join(".");
}

/** the address behind a ciphertext, or null when the key does not match. a
 *  wrong key fails the gcm tag, and that is a null rather than an error. */
export function decryptAddress(value: string, key: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  let bytes: Buffer;
  try {
    bytes = decodeKey(key);
  } catch {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", bytes, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function decodeKey(key: string): Buffer {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
  }
  return bytes;
}

/** what goes in the row, in the mode the operator chose. */
function storeAddress(address: string, options: IpCaptureOptions): string {
  if (options.storage === "hash") return hashAddress(address, options.hashPepper);
  if (options.storage === "encrypted") return encryptAddress(address, options.encryptionKey);
  // plaintext keeps the address as it is. that mode is only acceptable behind a
  // trusted local tunnel, and the operator is warned at boot.
  return address;
}

/** the captured address and the form of it that goes in the row. */
export function captureIp(
  headers: Headers,
  socketAddress: string | null,
  options: IpCaptureOptions,
): CapturedIp {
  const address = resolveAddress(headers, socketAddress, options);
  if (address === null) {
    return { address: null, stored: null, mode: options.storage };
  }
  return { address, stored: storeAddress(address, options), mode: options.storage };
}
