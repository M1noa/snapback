// tests/services/intel/update.test.ts. the files the bot fetches: a missing
// one is fetched, a fresh one is left alone, a failed download keeps the file
// that was already there, and a download that is not the file it should be is
// refused.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntelOptions } from "../../../src/services/intel/update.ts";
import { intelSources, refreshIntelFiles } from "../../../src/services/intel/update.ts";

const directory = mkdtempSync(join(tmpdir(), "snapback-intel-update-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function options(): IntelOptions {
  return {
    enabled: true,
    countryMmdb: join(directory, "country.mmdb"),
    ip2asnTsv: join(directory, "ip2asn.tsv"),
    asMetadataJson: join(directory, "as-metadata.json"),
    torList: join(directory, "tor-exit-addresses.txt"),
    update: true,
  };
}

// what the sources answer with, one body per url.
const BODIES: Readonly<Record<string, string>> = {
  "https://iptoasn.com/data/ip2asn-v4.tsv.gz": "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE\n",
  "https://raw.githubusercontent.com/ipverse/as-metadata/master/as.json":
    '[{"asn":15169,"metadata":{"description":"Google LLC","category":"isp"}}]',
  "https://check.torproject.org/exit-addresses": "ExitAddress 171.25.193.25 2026-10-21 19:09:41\n",
};

/** a fetch that answers with the bodies above and counts the calls. */
function fakeFetch(calls: string[]): (url: string, init: RequestInit) => Promise<Response> {
  return async (url: string) => {
    calls.push(url);
    const body = BODIES[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

describe("the intel files", () => {
  test("a missing file is fetched and written", async () => {
    const calls: string[] = [];
    const result = await refreshIntelFiles(options(), { fetch: fakeFetch(calls) });

    expect(result.failed).toEqual([]);
    expect(result.fetched.length).toBe(3);
    expect(calls.length).toBe(3);
    expect(existsSync(join(directory, "ip2asn.tsv"))).toBe(true);
    expect(existsSync(join(directory, "as-metadata.json"))).toBe(true);
    expect(existsSync(join(directory, "tor-exit-addresses.txt"))).toBe(true);
  });

  test("a fresh file is left alone", async () => {
    const path = join(directory, "ip2asn.tsv");
    writeFileSync(path, "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE\n");
    const before = statSync(path).mtimeMs;

    const calls: string[] = [];
    const result = await refreshIntelFiles(options(), { fetch: fakeFetch(calls) });

    expect(result.skipped).toContain("ip2asn");
    expect(calls).not.toContain("https://iptoasn.com/data/ip2asn-v4.tsv.gz");
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("a failed download keeps the file that was there", async () => {
    const path = join(directory, "tor-exit-addresses.txt");
    writeFileSync(path, "ExitAddress 1.2.3.4 2026-10-21 19:09:41\n");

    const result = await refreshIntelFiles(
      options(),
      {
        fetch: async () => new Response("not found", { status: 404 }),
      },
      "any",
    );

    expect(result.failed.length).toBe(3);
    expect(result.fetched).toEqual([]);
    expect(Bun.file(path).text()).resolves.toContain("1.2.3.4");
  });

  test("a download that is not the file it should be is refused", async () => {
    const path = join(directory, "as-metadata.json");
    writeFileSync(path, '[{"asn":1,"metadata":{"description":"kept"}}]');

    const result = await refreshIntelFiles(
      options(),
      {
        fetch: async (url: string) =>
          new Response(url.includes("as-metadata") ? "not json at all" : "", { status: 200 }),
      },
      "any",
    );

    expect(result.failed.some((entry) => entry.key === "as-metadata")).toBe(true);
    expect(Bun.file(path).text()).resolves.toContain("kept");
  });

  test("the bot does not fetch anything when the update is off", async () => {
    const calls: string[] = [];
    const result = await refreshIntelFiles(
      { ...options(), update: false },
      { fetch: fakeFetch(calls) },
      "any",
    );

    expect(calls).toEqual([]);
    expect(result.fetched).toEqual([]);
  });

  test("the sources are the three keyless files", () => {
    const sources = intelSources(options());

    expect(sources.map((source) => source.key)).toEqual(["ip2asn", "as-metadata", "tor"]);
  });
});
