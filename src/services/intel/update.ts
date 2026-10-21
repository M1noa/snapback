// the data files, fetched by the bot (D4PLAN 14.4). the three files that need
// no key are downloaded here, checked, and put in place.
//
// the rules:
//   - a file that is younger than its age limit is left alone
//   - a download goes to a temporary file and is renamed over the old one, so
//     a half-written file is never read
//   - a download that fails keeps the file that was already there
//   - nothing here stops the bot. a missing file means the intel says less,
//     not that the bot is down.
//
// the fourth file, the db-ip country database, is not fetched: db-ip gives
// its free downloads to a registered account, so that one is the operator's.

import { rename } from "node:fs/promises";
import type { Logger } from "../../lib/log.ts";

/** the outbound call, narrowed so a test can hand in its own. */
export type IntelFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface IntelOptions {
  /** the operator turned the intel off. then there is no answer at all. */
  readonly enabled: boolean;
  /** the db-ip country database. the operator's own file. */
  readonly countryMmdb: string;
  /** the ip-to-asn table. */
  readonly ip2asnTsv: string;
  /** the ipverse as-metadata file. */
  readonly asMetadataJson: string;
  /** the tor exit list. */
  readonly torList: string;
  /** the bot fetches the files itself. */
  readonly update: boolean;
}

export type IntelSourceKind = "tsv" | "json" | "text";

export interface IntelSource {
  readonly key: string;
  readonly url: string;
  /** where the file lands on disk. */
  readonly file: string;
  readonly kind: IntelSourceKind;
  /** how old the file may get before it is fetched again. */
  readonly maxAgeHours: number;
  /** the file is gzipped on the wire and stored plain. */
  readonly gzip: boolean;
}

const HOUR_MS = 3_600_000;

/** the sources the bot fetches. */
export function intelSources(options: IntelOptions): readonly IntelSource[] {
  return [
    {
      key: "ip2asn",
      url: "https://iptoasn.com/data/ip2asn-v4.tsv.gz",
      file: options.ip2asnTsv,
      kind: "tsv",
      maxAgeHours: 24,
      gzip: true,
    },
    {
      key: "as-metadata",
      url: "https://raw.githubusercontent.com/ipverse/as-metadata/master/as.json",
      file: options.asMetadataJson,
      kind: "json",
      maxAgeHours: 24,
      gzip: false,
    },
    {
      key: "tor",
      url: "https://check.torproject.org/exit-addresses",
      file: options.torList,
      kind: "text",
      maxAgeHours: 24,
      gzip: false,
    },
  ];
}

export interface IntelUpdateDeps {
  readonly log?: Logger;
  readonly fetch?: IntelFetch;
  /** epoch ms. injected so a test can age a file. */
  readonly now?: () => number;
  /** how long one download may take. */
  readonly timeoutMs?: number;
}

export interface IntelUpdateResult {
  readonly fetched: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { readonly key: string; readonly reason: string }[];
}

/** the cap on one download. the biggest file is seventy megabytes. */
const MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

/** which files to fetch. */
export type IntelRefresh = "missing" | "stale" | "any";

async function ageHours(path: string, now: number): Promise<number | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const stat = await file.stat();
  return (now - stat.mtimeMs) / HOUR_MS;
}

/** the file is good enough to keep. */
function validate(kind: IntelSourceKind, text: string): boolean {
  if (text.length === 0) return false;
  if (kind === "json") return text.trimStart().startsWith("[");
  if (kind === "tsv") {
    const first = text.slice(0, 512).split("\n")[0] ?? "";
    const fields = first.split("\t");
    return fields.length >= 3 && /^\d+$/.test(fields[2]?.trim() ?? "");
  }
  return text.includes("ExitAddress ");
}

/** reads the body, with a cap. */
async function readBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new Error("the download is larger than the cap");
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("the download is larger than the cap");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** the gzip magic number, the first two bytes of every gzip file. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** the bytes, uncompressed when the source is gzipped. */
async function download(source: IntelSource, deps: IntelUpdateDeps): Promise<Uint8Array> {
  const send: IntelFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const response = await send(source.url, {
    method: "GET",
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: { accept: "*/*" },
  });
  if (!response.ok) throw new Error(`the download answered ${response.status}`);

  const bytes = await readBody(response, MAX_BYTES);
  if (!source.gzip || !isGzip(bytes)) return bytes;

  // the server already decompressed it, or it never was compressed.
  const body = new Response(bytes).body;
  if (body === null) throw new Error("the download had no body");
  const inflated = body.pipeThrough(new DecompressionStream("gzip"));
  return await readBody(new Response(inflated), MAX_BYTES);
}

/**
 * fetches the files that need it.
 *
 * "missing" waits for a file that is not there, because a bot that has never
 * downloaded one would answer nothing. "stale" refreshes a file that is older
 * than its limit. "any" does both.
 */
export async function refreshIntelFiles(
  options: IntelOptions,
  deps: IntelUpdateDeps = {},
  refresh: IntelRefresh = "stale",
): Promise<IntelUpdateResult> {
  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: { key: string; reason: string }[] = [];
  if (!options.enabled || !options.update) return { fetched, skipped, failed };

  const now = deps.now?.() ?? Date.now();
  for (const source of intelSources(options)) {
    const age = await ageHours(source.file, now);
    if (refresh === "missing" && age !== null) {
      skipped.push(source.key);
      continue;
    }
    if (refresh === "stale" && age !== null && age < source.maxAgeHours) {
      skipped.push(source.key);
      continue;
    }

    try {
      const bytes = await download(source, deps);
      const text = new TextDecoder().decode(bytes);
      if (!validate(source.kind, text)) {
        throw new Error("the download does not look like the file it should be");
      }
      const temporary = `${source.file}.tmp`;
      await Bun.write(temporary, bytes);
      await rename(temporary, source.file);
      fetched.push(source.key);
      deps.log?.info("the intel file was updated", { file: source.key, bytes: bytes.byteLength });
    } catch (error) {
      // the old file stays where it is. a stale answer beats no answer.
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ key: source.key, reason });
      deps.log?.warn("the intel file was not updated", { file: source.key, reason });
    }
  }
  return { fetched, skipped, failed };
}

/** the age of a file in hours, or null when it is not there. */
export async function intelFileAgeHours(
  options: IntelOptions,
  now: number = Date.now(),
): Promise<Record<string, number | null>> {
  const ages: Record<string, number | null> = {};
  for (const source of intelSources(options)) {
    ages[source.key] = await ageHours(source.file, now);
  }
  ages["country-mmdb"] = await ageHours(options.countryMmdb, now);
  return ages;
}
