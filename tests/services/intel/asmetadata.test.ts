// tests/services/intel/asmetadata.test.ts. the network metadata: the file is
// parsed once and kept in memory, a network is found by its asn, a network the
// file does not have is unknown, and a broken entry costs nothing but itself.
//
// the file the publisher ships is json, and the category is the reason it is
// worth having: it says what the network is for.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsMetadataFile } from "../../../src/services/intel/asmetadata.ts";

const directory = mkdtempSync(join(tmpdir(), "snapback-intel-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

// the shape the publisher ships: the asn, the metadata with its category, and
// the route statistics this reader walks over.
const PUBLISHED = JSON.stringify(
  [
    {
      asn: 15169,
      metadata: {
        handle: "GOOGLE",
        description: "Google LLC",
        countryCode: "US",
        country: "United States",
        origin: "authoritative",
        category: "isp",
        networkRole: "access_provider",
        registered: "2000-03-30",
        lastModified: "2026-08-01",
      },
      stats: { ipv4: { prefixes: 7, prefixesAggregated: 6, largestPrefix: 22 }, ipv6: null },
      lastAnnounced: "2026-10-20",
    },
    {
      asn: 16509,
      metadata: {
        handle: "AMAZON-02",
        description: "Amazon.com Inc.",
        countryCode: "US",
        country: "United States",
        origin: "authoritative",
        category: "hosting",
        networkRole: "stub",
        registered: "1997-02-14",
        lastModified: "2026-10-01",
      },
      stats: null,
      lastAnnounced: "2026-10-20",
    },
    {
      asn: 12552,
      metadata: {
        handle: "IP-ONLY",
        description: "IP-Only Networks AB",
        countryCode: "SE",
        country: "Sweden",
        origin: "authoritative",
        category: "isp",
        networkRole: "access_provider",
        registered: "1997-03-04",
        lastModified: null,
      },
      stats: null,
      lastAnnounced: null,
    },
  ],
  null,
  2,
);

describe("the network metadata", () => {
  test("the file is read and the networks are kept", async () => {
    const path = write("as.json", PUBLISHED);
    const metadata = await parseAsMetadataFile(path);

    expect(metadata.count).toBe(3);
    expect(metadata.lookup("15169")?.description).toBe("Google LLC");
    expect(metadata.lookup("12552")?.description).toBe("IP-Only Networks AB");
  });

  test("the category says what the network is for", async () => {
    const path = write("as-category.json", PUBLISHED);
    const metadata = await parseAsMetadataFile(path);

    expect(metadata.lookup("16509")?.category).toBe("hosting");
    expect(metadata.lookup("15169")?.category).toBe("isp");
    expect(metadata.lookup("12552")?.networkRole).toBe("access_provider");
  });

  test("a network the file does not have is unknown", async () => {
    const path = write("as-missing.json", PUBLISHED);
    const metadata = await parseAsMetadataFile(path);

    expect(metadata.lookup("13335")).toBeNull();
    expect(metadata.lookup("not a number")).toBeNull();
    expect(metadata.lookup("")).toBeNull();
  });

  test("the asn is found with or without its prefix", async () => {
    const path = write("as-prefix.json", PUBLISHED);
    const metadata = await parseAsMetadataFile(path);

    expect(metadata.lookup("AS15169")?.description).toBe("Google LLC");
    expect(metadata.lookup(" 15169 ")?.description).toBe("Google LLC");
  });

  test("an entry that is cut in half is skipped rather than fatal", async () => {
    const path = write(
      "as-broken.json",
      '[{"asn": 15169, "metadata": {"handle": "GOOGLE", "description": "Google LLC", "category": "isp"}},',
    );

    const metadata = await parseAsMetadataFile(path);
    expect(metadata.count).toBe(1);
    expect(metadata.lookup("15169")?.description).toBe("Google LLC");
  });

  test("a file with no entry in it is refused", async () => {
    const path = write("as-empty.json", "[]");

    await expect(parseAsMetadataFile(path)).rejects.toThrow("SB_INTEL_AS_JSON_INVALID");
  });

  test("a file that is not there is missing", async () => {
    await expect(parseAsMetadataFile(join(directory, "absent.json"))).rejects.toThrow(
      "SB_INTEL_AS_JSON_MISSING",
    );
  });
});
