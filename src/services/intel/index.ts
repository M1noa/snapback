// the intel service (D4PLAN 14.4). one address in, one answer out: the
// country from the operator's own database, the network and its category from
// the two files the bot fetches, and the tor answer from the exit list.
//
// the address is personal data. it is read here, used to look things up, and
// dropped. nothing here stores it and nothing here logs it.
//
// there is no outbound call in this path. the plan says the intel is local
// files and no third party at request time, and every file here is one the
// operator can read.

import type { Logger } from "../../lib/log.ts";
import { type AsMetadata, parseAsMetadataFile } from "./asmetadata.ts";
import { type Classification, classify } from "./classify.ts";
import { type CountryDatabase, openCountryDatabase } from "./dbip.ts";
import { type IpToAsn, loadIpToAsn } from "./ip2asn.ts";
import { loadTorExits, type TorExits } from "./tor.ts";
import type { IntelOptions } from "./update.ts";

export type { IntelOptions } from "./update.ts";

export interface IntelResult extends Classification {
  /** the address the database calls an anonymous proxy. */
  readonly isAnonymousProxy: boolean;
}

export interface IntelDeps {
  readonly log?: Logger;
}

export interface IntelService {
  /** what the files say about one address. */
  lookup(address: string): Promise<IntelResult | null>;
  /** reads the files again. the caller decides when. */
  reload(): Promise<void>;
}

interface LoadedFiles {
  readonly database: CountryDatabase | null;
  readonly table: IpToAsn | null;
  readonly metadata: AsMetadata | null;
  readonly tor: TorExits | null;
}

const EMPTY: LoadedFiles = {
  database: null,
  table: null,
  metadata: null,
  tor: null,
};

function openDatabase(path: string, log: Logger | undefined): CountryDatabase | null {
  try {
    return openCountryDatabase(path);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "SB_INTEL_MMDB_INVALID";
    log?.warn("the country database is not usable, the country is left empty", { code, path });
    return null;
  }
}

async function openTable(path: string, log: Logger | undefined): Promise<IpToAsn | null> {
  try {
    return await loadIpToAsn(path);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "SB_INTEL_IP2ASN_INVALID";
    log?.warn("the ip to asn file is not usable, the network is left empty", { code, path });
    return null;
  }
}

async function openMetadata(path: string, log: Logger | undefined): Promise<AsMetadata | null> {
  try {
    return await parseAsMetadataFile(path);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "SB_INTEL_AS_JSON_INVALID";
    log?.warn("the as metadata file is not usable, the category is left empty", { code, path });
    return null;
  }
}

async function openTor(path: string, log: Logger | undefined): Promise<TorExits | null> {
  try {
    return await loadTorExits(path);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "SB_INTEL_TOR_INVALID";
    log?.warn("the tor exit list is not usable, the tor answer is left empty", { code, path });
    return null;
  }
}

/** the intel service for one configuration. */
export function createIntelService(options: IntelOptions, deps: IntelDeps = {}): IntelService {
  let loaded: LoadedFiles | null = null;
  let pending: Promise<LoadedFiles> | null = null;

  const load = async (): Promise<LoadedFiles> => {
    if (loaded !== null) return loaded;
    if (pending === null) {
      pending = (async () => {
        const files: LoadedFiles = {
          database: openDatabase(options.countryMmdb, deps.log),
          table: await openTable(options.ip2asnTsv, deps.log),
          metadata: await openMetadata(options.asMetadataJson, deps.log),
          tor: await openTor(options.torList, deps.log),
        };
        loaded = files;
        return files;
      })();
    }
    try {
      return await pending;
    } catch {
      return EMPTY;
    }
  };

  return {
    async lookup(address: string): Promise<IntelResult | null> {
      if (!options.enabled) return null;
      const files = await load();

      // the country and the network come from the operator's own files. the
      // address itself goes no further than these three lookups.
      const record = files.database?.lookup(address) ?? null;
      const network = files.table?.lookup(address) ?? null;
      const asn = network?.asn ?? record?.asn ?? null;
      const metadata = asn === null ? null : (files.metadata?.lookup(asn) ?? null);
      const isTorExit = files.tor?.has(address) ?? false;

      const verdict = classify({
        countryCode: record?.countryCode ?? metadata?.country ?? network?.country ?? null,
        countryName: record?.countryName ?? null,
        asOrg: metadata?.description ?? network?.name ?? record?.asOrg ?? null,
        isp: record?.isp ?? network?.name ?? null,
        asn,
        category: metadata?.category ?? null,
        isTorExit,
        isAnonymousProxy: record?.isAnonymousProxy ?? false,
      });

      return { ...verdict, isAnonymousProxy: record?.isAnonymousProxy ?? false };
    },
    async reload(): Promise<void> {
      loaded = null;
      pending = null;
      await load();
    },
  };
}
