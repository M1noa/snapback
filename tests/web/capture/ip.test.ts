import { describe, expect, test } from "bun:test";
import {
  captureIp,
  decryptAddress,
  encryptAddress,
  hashAddress,
  type IpCaptureOptions,
  isPublicAddress,
} from "../../../src/web/capture/ip.ts";

// no network and no server: the headers are built by hand and the socket
// address is a string the test owns.
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const PEPPER = "a-pepper-for-tests";

function options(overrides: Partial<IpCaptureOptions> = {}): IpCaptureOptions {
  return {
    behindCloudflareTunnel: false,
    trustedProxyDepth: 0,
    storage: "hash",
    hashPepper: PEPPER,
    encryptionKey: KEY,
    ...overrides,
  };
}

describe("captureIp", () => {
  test("takes cf-connecting-ip in cloudflare mode and ignores x-forwarded-for", () => {
    const captured = captureIp(
      new Headers({
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.4",
      }),
      "127.0.0.1",
      options({ behindCloudflareTunnel: true }),
    );
    expect(captured.address).toBe("203.0.113.7");
  });

  test("ignores x-forwarded-for in cloudflare mode even with no cf header", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "198.51.100.4" }),
      "127.0.0.1",
      options({ behindCloudflareTunnel: true }),
    );
    expect(captured.address).toBe("127.0.0.1");
  });

  test("takes the entry left of the last proxy when a proxy depth is configured", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.4" }),
      "10.0.0.1",
      options({ trustedProxyDepth: 1 }),
    );
    expect(captured.address).toBe("203.0.113.7");
  });

  test("takes the right-most non-proxy entry of a longer chain", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.7, 10.0.0.1" }),
      "10.0.0.1",
      options({ trustedProxyDepth: 1 }),
    );
    expect(captured.address).toBe("203.0.113.7");
  });

  test("skips every trusted hop when the depth is larger", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2, 10.0.0.1" }),
      "10.0.0.1",
      options({ trustedProxyDepth: 2 }),
    );
    expect(captured.address).toBe("203.0.113.7");
  });

  test("ignores x-forwarded-for when no proxy is trusted", () => {
    // D4PLAN 14.1: with no trusted proxy the chain is not consulted at all,
    // because any client can write it.
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "198.51.100.4" }),
      "203.0.113.9",
      options({ trustedProxyDepth: 0 }),
    );
    expect(captured.address).toBe("203.0.113.9");
  });

  test("discards a candidate that is not an address and uses the next one", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "203.0.113.7, not-an-address, 10.0.0.1" }),
      "10.0.0.1",
      options({ trustedProxyDepth: 1 }),
    );
    expect(captured.address).toBe("203.0.113.7");
  });

  test("discards an address that is out of range", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "999.1.1.1, 203.0.113.7, 10.0.0.1" }),
      "10.0.0.1",
      options({ trustedProxyDepth: 1 }),
    );
    expect(captured.address).toBe("203.0.113.7");
  });

  test("uses the socket address when there is no header", () => {
    const captured = captureIp(new Headers(), "203.0.113.9", options({ trustedProxyDepth: 1 }));
    expect(captured.address).toBe("203.0.113.9");
  });

  test("uses the socket address when the chain holds no valid address", () => {
    const captured = captureIp(
      new Headers({ "x-forwarded-for": "nonsense, 999.1.1.1" }),
      "203.0.113.9",
      options({ trustedProxyDepth: 1 }),
    );
    expect(captured.address).toBe("203.0.113.9");
  });

  test("captures nothing when there is no header and no socket", () => {
    const captured = captureIp(new Headers(), null, options());
    expect(captured.address).toBeNull();
    expect(captured.stored).toBeNull();
    expect(captured.mode).toBe("hash");
  });

  test("strips the ipv4-mapped ipv6 form", () => {
    const captured = captureIp(new Headers(), "::ffff:203.0.113.7", options());
    expect(captured.address).toBe("203.0.113.7");
  });

  test("canonicalises an ipv6 so one address has one spelling", () => {
    const captured = captureIp(new Headers(), "2001:0db8:0000:0000:0000:0000:0000:0001", options());
    expect(captured.address).toBe("2001:db8::1");
  });

  test("keeps the address out of the row in hash mode", () => {
    const captured = captureIp(new Headers(), "203.0.113.7", options({ storage: "hash" }));
    expect(captured.stored).not.toBe("203.0.113.7");
    expect(captured.stored).not.toContain("203.0.113.7");
    expect(captured.mode).toBe("hash");
  });

  test("stores the address as it is in plaintext mode", () => {
    const captured = captureIp(new Headers(), "203.0.113.7", options({ storage: "plaintext" }));
    expect(captured.stored).toBe("203.0.113.7");
    expect(captured.mode).toBe("plaintext");
  });

  test("stores ciphertext in encrypted mode", () => {
    const captured = captureIp(new Headers(), "203.0.113.7", options({ storage: "encrypted" }));
    expect(captured.stored).not.toBe("203.0.113.7");
    expect(captured.stored).not.toContain("203.0.113.7");
    expect(decryptAddress(captured.stored ?? "", KEY)).toBe("203.0.113.7");
  });

  test("gives two visits the same stored value in hash mode", () => {
    const first = captureIp(new Headers(), "203.0.113.7", options({ storage: "hash" }));
    const second = captureIp(new Headers(), "203.0.113.7", options({ storage: "hash" }));
    expect(first.stored).toBe(second.stored);
  });
});

describe("hashAddress", () => {
  test("is the same value for the same address and pepper", () => {
    expect(hashAddress("203.0.113.7", PEPPER)).toBe(hashAddress("203.0.113.7", PEPPER));
  });

  test("changes with the pepper", () => {
    expect(hashAddress("203.0.113.7", PEPPER)).not.toBe(hashAddress("203.0.113.7", "other"));
  });

  test("changes with the address", () => {
    expect(hashAddress("203.0.113.7", PEPPER)).not.toBe(hashAddress("203.0.113.8", PEPPER));
  });

  test("does not contain the address", () => {
    expect(hashAddress("203.0.113.7", PEPPER)).not.toContain("203.0.113.7");
  });
});

describe("encryptAddress", () => {
  test("round trips the address", () => {
    const ciphertext = encryptAddress("203.0.113.7", KEY);
    expect(decryptAddress(ciphertext, KEY)).toBe("203.0.113.7");
  });

  test("does not contain the address", () => {
    expect(encryptAddress("203.0.113.7", KEY)).not.toContain("203.0.113.7");
  });

  test("uses a fresh iv every time", () => {
    expect(encryptAddress("203.0.113.7", KEY)).not.toBe(encryptAddress("203.0.113.7", KEY));
  });

  test("returns null when the key does not match", () => {
    const ciphertext = encryptAddress("203.0.113.7", KEY);
    expect(decryptAddress(ciphertext, OTHER_KEY)).toBeNull();
  });

  test("returns null for a value that is not a ciphertext", () => {
    expect(decryptAddress("203.0.113.7", KEY)).toBeNull();
    expect(decryptAddress("v1.aa.bb.cc", KEY)).toBeNull();
  });
});

describe("isPublicAddress", () => {
  test("calls a routable address public", () => {
    expect(isPublicAddress("203.0.113.7")).toBe(true);
    expect(isPublicAddress("2001:db8::1")).toBe(true);
  });

  test("calls loopback, private and link-local addresses private", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
    expect(isPublicAddress("172.16.0.1")).toBe(false);
    expect(isPublicAddress("169.254.0.1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
  });

  test("calls nothing that is not an address private", () => {
    expect(isPublicAddress("999.1.1.1")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});
