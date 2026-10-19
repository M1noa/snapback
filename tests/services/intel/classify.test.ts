// tests/services/intel/classify.test.ts. the verdict: what the network name
// says, and what it does not say. the flags are a likelihood, so the words
// matter more than the booleans.

import { describe, expect, test } from "bun:test";
import { classify } from "../../../src/services/intel/classify.ts";

describe("the verdict", () => {
  test("a vpn network is flagged and is a proxy", () => {
    const verdict = classify({ asOrg: "NordVPN", country: "us" });

    expect(verdict.isVpn).toBe(true);
    expect(verdict.isProxy).toBe(true);
    expect(verdict.isTor).toBe(false);
    // a vpn exit is not a residential line.
    expect(verdict.ipType).toBe("hosting");
  });

  test("a proxy network is a proxy", () => {
    const verdict = classify({ asOrg: "Some Anonymous Proxy Service" });

    expect(verdict.isProxy).toBe(true);
    expect(verdict.isVpn).toBe(false);
  });

  test("a tor exit is a proxy and a tor exit", () => {
    const verdict = classify({ asOrg: "TOR Exit Node" });

    expect(verdict.isTor).toBe(true);
    expect(verdict.isProxy).toBe(true);
  });

  test("a hosting network is hosting", () => {
    const verdict = classify({ asOrg: "Example Datacenter", isp: "Example Hosting LLC" });

    expect(verdict.ipType).toBe("hosting");
    expect(verdict.isVpn).toBe(false);
    expect(verdict.isProxy).toBe(false);
    expect(verdict.isTor).toBe(false);
  });

  test("a mobile network is mobile", () => {
    const verdict = classify({ asOrg: "T-Mobile Austria", country: "at" });

    expect(verdict.ipType).toBe("mobile");
    expect(verdict.isVpn).toBe(false);
  });

  test("an ordinary network is residential", () => {
    const verdict = classify({ asOrg: "Comcast Cable Communications, LLC", country: "us" });

    expect(verdict.ipType).toBe("residential");
    expect(verdict.isVpn).toBe(false);
    expect(verdict.isProxy).toBe(false);
    expect(verdict.isTor).toBe(false);
  });

  test("nothing known is unknown, never residential", () => {
    const verdict = classify({});

    expect(verdict.ipType).toBe("unknown");
    expect(verdict.countryCode).toBeNull();
    expect(verdict.countryName).toBeNull();
    expect(verdict.asOrg).toBeNull();
    expect(verdict.isp).toBeNull();
    expect(verdict.asn).toBeNull();
    expect(verdict.isVpn).toBe(false);
  });

  test("the country goes in the slot its shape asks for", () => {
    expect(classify({ country: "us" }).countryCode).toBe("us");
    expect(classify({ country: "us" }).countryName).toBeNull();
    expect(classify({ country: "United States" }).countryName).toBe("United States");
    expect(classify({ country: "United States" }).countryCode).toBeNull();
  });

  test("a city called tor is not a tor exit", () => {
    const verdict = classify({ asOrg: "Example Networks", isp: "Example Toronto Broadband" });

    expect(verdict.isTor).toBe(false);
    expect(verdict.ipType).toBe("residential");
  });
});
