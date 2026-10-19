// tests/services/intel/asmetadata.test.ts. the network metadata: the file is
// parsed once and kept in memory, a network is found by its asn, a network the
// file does not have is unknown, and a broken row costs nothing but itself.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAsMetadata, parseAsMetadataCsv } from "../../../src/services/intel/asmetadata.ts";

const directory = mkdtempSync(join(tmpdir(), "snapback-intel-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

// the shape the ipverse publishes: the asn, the registry handle, the
// organisation, and the country the network is registered in.
const PUBLISHED = [
  "asn,handle,description,country-code",
  "15169,GOOGLE,Google LLC,US",
  "16509,AMAZON-02,Amazon.com Inc.,US",
  "7018,ATSI,AT&T Services, Inc.,US",
  "12552,IP-ONLY,IP-Only Networks AB,SE",
  "",
].join("\n");

// the asn of the networks the sample addresses sit in.
const ADDRESS_ASN: Readonly<Record<string, string>> = {
  "8.8.8.8": "15169",
  "1.1.1.1": "13335",
  "16.0.0.1": "16509",
};

describe("the network metadata", () => {
  test("the file is parsed once and kept in memory", () => {
    const path = write("as.csv", PUBLISHED);
    const metadata = loadAsMetadata(path);

    // the file goes away, the answer does not: everything is in memory now.
    rmSync(path, { force: true });

    expect(metadata.count).toBe(4);
    expect(metadata.lookup("15169")?.name).toBe("Google LLC");
    expect(metadata.lookup("12552")?.name).toBe("IP-Only Networks AB");
  });

  test("the network of an address carries its name and its asn", () => {
    const metadata = parseAsMetadataCsv(PUBLISHED);

    const asn = ADDRESS_ASN["8.8.8.8"] ?? "";
    const network = metadata.lookup(asn);
    expect(network?.name).toBe("Google LLC");
    expect(network?.asn).toBe("15169");
    expect(network?.country).toBe("us");
    expect(network?.registry).toBe("GOOGLE");
  });

  test("a network the file does not have is unknown", () => {
    const metadata = parseAsMetadataCsv(PUBLISHED);

    expect(metadata.lookup("13335")).toBeNull();
    expect(metadata.lookup("not a number")).toBeNull();
    expect(metadata.lookup("")).toBeNull();
  });

  test("the asn is found with or without its prefix", () => {
    const metadata = parseAsMetadataCsv(PUBLISHED);

    expect(metadata.lookup("AS15169")?.name).toBe("Google LLC");
    expect(metadata.lookup(" 15169 ")?.name).toBe("Google LLC");
  });

  test("a malformed row is skipped rather than fatal", () => {
    const metadata = parseAsMetadataCsv(
      [
        "asn,handle,description,country-code",
        "15169,GOOGLE,Google LLC,US",
        "not a number,BROKEN,Broken Row,US",
        ",EMPTY,No Number,US",
        '16509,AMAZON-02,"Amazon.com Inc., Inc.",US',
        "",
      ].join("\n"),
    );

    expect(metadata.count).toBe(2);
    expect(metadata.lookup("15169")?.name).toBe("Google LLC");
    // a quoted name keeps its comma.
    expect(metadata.lookup("16509")?.name).toBe("Amazon.com Inc., Inc.");
  });

  test("a comment header names the columns", () => {
    const metadata = parseAsMetadataCsv(
      ["# asn,name,country,registry", "15169,Google LLC,US,GOOGLE", ""].join("\n"),
    );

    expect(metadata.count).toBe(1);
    expect(metadata.lookup("15169")?.name).toBe("Google LLC");
    expect(metadata.lookup("15169")?.country).toBe("us");
    expect(metadata.lookup("15169")?.registry).toBe("GOOGLE");
  });

  test("a file that is not there is missing", () => {
    expect(() => loadAsMetadata(join(directory, "absent.csv"))).toThrow("SB_INTEL_AS_CSV_MISSING");
  });
});
