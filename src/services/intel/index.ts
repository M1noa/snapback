// the intel entry (D4PLAN 14.4). one address in, one answer out: the country
// and the network from the operator's own files, and the city and the region
// from the one outbound call the plan allows.
//
// the address is personal data. it is read here, used to look things up, and
// dropped. nothing here stores it and nothing here logs it.
//
// the call to ipverse is optional and best effort. when it fails the local
// answer stands on its own and the operator sees a warning, never a broken
// capture.

import type { Logger } from "../../lib/log.ts";
import { type AsMetadata, loadAsMetadata } from "./asmetadata.ts";
import { type Classification, classify } from "./classify.ts";
import { type CountryDatabase, type CountryRecord, openCountryDatabase } from "./dbip.ts";

// the only third party this module talks to. it answers where the address is,
// and nothing about it is sent anywhere else.
const IPVERSE_GEO = "https://api.ipverse.org/ip/geo/";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface IntelOptions {
  /** the operator turned the intel off. then there is no answer at all. */
  readonly enabled: boolean;
  /** the db-ip country database. */
  readonly countryMmdb: string;
  /** the ipverse as metadata csv. */
  readonly asCsv: string;
}

/** the answer, with the two columns the local files cannot give. */
export interface IntelResult extends Classification {
  readonly city: string | null;
  readonly region: string | null;
}

/** the outbound call, narrowed so a test can hand in its own. */
export type IntelFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface IntelDeps {
  readonly log?: Logger;
  readonly fetch?: IntelFetch;
  /** how long the ipverse call may take. */
  readonly timeoutMs?: number;
}

export interface IntelService {
  /** what the files and the one call say about an address. */
  lookup(address: string): Promise<IntelResult | null>;
  /** reads the two files again. the caller decides when. */
  reload(): void;
}

interface LoadedFiles {
  readonly database: CountryDatabase | null;
  readonly metadata: AsMetadata | null;
}

// the parsed files, kept per path so a verify does not read them again.
const files = new Map<string, LoadedFiles>();

function openDatabase(path: string, log: Logger | undefined): CountryDatabase | null {
  try {
    return openCountryDatabase(path);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "SB_INTEL_MMDB_INVALID";
    log?.warn("the country database is not usable, the country is left empty", { code, path });
    return null;
  }
}

function openMetadata(path: string, log: Logger | undefined): AsMetadata | null {
  try {
    return loadAsMetadata(path);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "SB_INTEL_AS_CSV_INVALID";
    log?.warn("the as metadata file is not usable, the network is left empty", { code, path });
    return null;
  }
}

function loadFiles(options: IntelOptions, log: Logger | undefined): LoadedFiles {
  const key = `${options.countryMmdb}\u0000${options.asCsv}`;
  const hit = files.get(key);
  if (hit !== undefined) return hit;
  const loaded: LoadedFiles = {
    database: openDatabase(options.countryMmdb, log),
    metadata: openMetadata(options.asCsv, log),
  };
  files.set(key, loaded);
  return loaded;
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

/** what the ipverse call answered about one address. */
interface Geo {
  readonly countryCode: string | null;
  readonly countryName: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly asn: string | null;
  readonly asOrg: string | null;
}

const EMPTY_GEO: Geo = {
  countryCode: null,
  countryName: null,
  city: null,
  region: null,
  asn: null,
  asOrg: null,
};

function readGeo(payload: unknown): Geo {
  const map = asObject(payload);
  if (map === null) return EMPTY_GEO;
  const code = asText(map.country_code);
  const rawAsn = map.asn;
  return {
    countryCode: code !== null && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null,
    countryName: asText(map.country),
    city: asText(map.city),
    region: asText(map.region),
    asn:
      typeof rawAsn === "number" && Number.isFinite(rawAsn)
        ? String(rawAsn)
        : (asText(rawAsn)?.replace(/^AS/i, "") ?? null),
    asOrg: asText(map.as_org),
  };
}

/** the one outbound call. a failure leaves the local answer alone. */
async function lookupIpverse(address: string, deps: IntelDeps): Promise<Geo | null> {
  const send: IntelFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const url = `${IPVERSE_GEO}${encodeURIComponent(address)}`;
  try {
    const response = await send(url, {
      method: "GET",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      deps.log?.warn("the ipverse lookup did not answer", { status: response.status });
      return null;
    }
    return readGeo(await response.json());
  } catch (error) {
    // the message may carry the address, and the logger redacts it, but the
    // line says nothing else about the address either way.
    deps.log?.warn("the ipverse lookup failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

/** the local answer, before the call that adds the city and the region. */
function localAnswer(
  record: CountryRecord | null,
  network: { readonly name: string | null } | null,
): {
  readonly countryCode: string | null;
  readonly countryName: string | null;
  readonly isp: string | null;
  readonly asn: string | null;
  readonly asOrg: string | null;
  readonly classified: Classification;
} {
  const asn = record?.asn ?? null;
  const asOrg = network?.name ?? record?.asOrg ?? null;
  const isp = record?.isp ?? network?.name ?? null;
  const countryCode = record?.countryCode ?? null;
  const countryName = record?.countryName ?? null;
  const classified = classify({
    country: countryName ?? countryCode,
    asOrg,
    isp,
  });
  return { countryCode, countryName, isp, asn, asOrg, classified };
}

/** the intel service for one configuration. */
export function createIntelService(options: IntelOptions, deps: IntelDeps = {}): IntelService {
  const key = `${options.countryMmdb}\u0000${options.asCsv}`;
  let loaded = loadFiles(options, deps.log);

  return {
    async lookup(address: string): Promise<IntelResult | null> {
      if (!options.enabled) return null;

      const record = loaded.database?.lookup(address) ?? null;
      const geo = await lookupIpverse(address, deps);

      const asn = record?.asn ?? geo?.asn ?? null;
      const network = asn === null ? null : (loaded.metadata?.lookup(asn) ?? null);
      const local = localAnswer(record, network);
      const asOrg = local.asOrg ?? geo?.asOrg ?? null;
      const isp = local.isp ?? network?.name ?? null;

      return {
        ...local.classified,
        countryCode: local.countryCode ?? geo?.countryCode ?? null,
        countryName: local.countryName ?? geo?.countryName ?? null,
        isp,
        asn,
        asOrg,
        city: geo?.city ?? null,
        region: geo?.region ?? null,
      };
    },
    reload() {
      files.delete(key);
      loaded = loadFiles(options, deps.log);
    },
  };
}

/** what the intel says about one address, or null when the intel is off. the
 *  files are read once and kept, so a verify does not pay for them again. */
export async function lookupIntel(
  address: string,
  options: IntelOptions,
  deps: IntelDeps = {},
): Promise<IntelResult | null> {
  if (!options.enabled) return null;
  return createIntelService(options, deps).lookup(address);
}
