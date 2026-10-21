// tests/services/intel/classify.test.ts. the verdict: what the category says,
// what the name says, and what it does not say. the flags are a likelihood, so
// the words matter more than the booleans.

import { describe, expect, test } from "bun:test";
import { classify } from "../../../src/services/intel/classify.ts";

describe("the verdict", () => {
  test("a vpn network is flagged and is a proxy", () => {
    const verdict = classify({ asOrg: "NordVPN", countryCode: "us" });

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

  test("the exit list settles it, whatever the name says", () => {
    const verdict = classify({ asOrg: "Example Networks", isTorExit: true });

    expect(verdict.isTor).toBe(true);
    expect(verdict.isProxy).toBe(true);
    expect(verdict.evidence).toContain("tor exit list");
  });

  test("a hosting network is hosting", () => {
    const verdict = classify({ asOrg: "Example Datacenter", isp: "Example Hosting LLC" });

    expect(verdict.ipType).toBe("hosting");
    expect(verdict.isHosting).toBe(true);
    expect(verdict.isVpn).toBe(false);
    expect(verdict.isProxy).toBe(false);
    expect(verdict.isTor).toBe(false);
  });

  test("the publisher's category wins over the name", () => {
    const verdict = classify({ asOrg: "Example Datacenter", category: "isp" });

    // the file says it is an access network, so it is one.
    expect(verdict.ipType).toBe("residential");
    expect(verdict.isHosting).toBe(false);
  });

  test("every category has its own type", () => {
    expect(classify({ category: "hosting" }).ipType).toBe("hosting");
    expect(classify({ category: "business" }).ipType).toBe("business");
    expect(classify({ category: "education_research" }).ipType).toBe("education");
    expect(classify({ category: "government_admin" }).ipType).toBe("government");
    expect(classify({ category: "isp" }).ipType).toBe("residential");
  });

  test("a mobile network is mobile", () => {
    const verdict = classify({ asOrg: "T-Mobile Austria", countryCode: "at" });

    expect(verdict.ipType).toBe("mobile");
    expect(verdict.isVpn).toBe(false);
  });

  test("a mobile network that the publisher calls an isp is still mobile", () => {
    const verdict = classify({ asOrg: "T-Mobile Austria", category: "isp" });

    expect(verdict.ipType).toBe("mobile");
  });

  test("an ordinary network is residential", () => {
    const verdict = classify({ asOrg: "Comcast Cable Communications, LLC", countryCode: "us" });

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

  test("the country goes in the slot it belongs to", () => {
    expect(classify({ countryCode: "us" }).countryCode).toBe("us");
    expect(classify({ countryCode: "us" }).countryName).toBeNull();
    expect(classify({ countryName: "United States" }).countryName).toBe("United States");
    expect(classify({ countryName: "United States" }).countryCode).toBeNull();
  });

  test("a city called tor is not a tor exit", () => {
    const verdict = classify({ asOrg: "Example Networks", isp: "Example Toronto Broadband" });

    expect(verdict.isTor).toBe(false);
    expect(verdict.ipType).toBe("residential");
  });

  test("the evidence says what the verdict was made from", () => {
    const verdict = classify({ asOrg: "Example Hosting", category: "hosting" });

    expect(verdict.evidence).toContain("hosting");
    expect(verdict.evidence).toContain("Example Hosting");
  });
});
