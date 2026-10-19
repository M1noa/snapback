// the network metadata (D4PLAN 14.4). the ipverse as-metadata file is one row
// per autonomous system: the number, the registry handle, the organisation, and
// the country it is registered in.
//
// the file is parsed once and kept in memory. the caller decides when to
// reload it, so a deploy can refresh the file without a restart. a row that
// does not parse is skipped, because one broken line in a hundred thousand
// must not cost the other ninety-nine thousand.
//
// the address is not in this file. the asn comes from the country database or
// from the ipverse lookup, and this file gives the network behind it.

import { readFileSync } from "node:fs";

export type AsMetadataErrorCode = "SB_INTEL_AS_CSV_MISSING" | "SB_INTEL_AS_CSV_INVALID";

const MESSAGES: Record<AsMetadataErrorCode, string> = {
  SB_INTEL_AS_CSV_MISSING: "the as metadata file is not there",
  SB_INTEL_AS_CSV_INVALID: "the as metadata file has no usable asn column",
};

export class AsMetadataError extends Error {
  readonly code: AsMetadataErrorCode;
  constructor(code: AsMetadataErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "AsMetadataError";
    this.code = code;
  }
}

/** one network, as the file describes it. */
export interface AsNetwork {
  /** the number only, "15169". */
  readonly asn: string;
  /** the organisation, or null when the row had no name. */
  readonly name: string | null;
  /** the country the network is registered in, two letters, or null. */
  readonly country: string | null;
  /** the registry handle, or null. */
  readonly registry: string | null;
}

export interface AsMetadata {
  /** how many networks the file holds. */
  readonly count: number;
  /** the network behind an asn, or null when the file does not have it. */
  lookup(asn: string): AsNetwork | null;
}

// the columns the file may carry, under every name it is published with. the
// order after the asn is the order of the older four column file.
const COLUMN_NAMES = {
  asn: ["asn"],
  name: ["description", "name", "org", "organization", "as_org", "as-name", "as_name"],
  country: ["country-code", "country_code", "countrycode", "country"],
  registry: ["registry", "handle", "rir"],
} as const;

type ColumnName = keyof typeof COLUMN_NAMES;

interface Layout {
  readonly asn: number;
  readonly name: number;
  readonly country: number;
  readonly registry: number;
}

const DEFAULT_LAYOUT: Layout = { asn: 0, name: 1, country: 2, registry: 3 };

/** the asn as digits, or null when the field is not a number. */
function normaliseAsn(value: string): string | null {
  let text = value.trim();
  if (text === "") return null;
  if (text.toLowerCase().startsWith("as")) text = text.slice(2);
  if (!/^\d+$/.test(text)) return null;
  return text;
}

/** one csv line into its fields, quotes included. */
function splitLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quoted) {
      if (character !== '"') {
        current += character;
      } else if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

/** where each column is, from the header line. */
function layoutFrom(header: readonly string[]): Layout {
  const lowered = header.map((field) => field.trim().toLowerCase());
  const find = (name: ColumnName): number => {
    for (const alias of COLUMN_NAMES[name]) {
      const at = lowered.indexOf(alias);
      if (at !== -1) return at;
    }
    return -1;
  };
  const asn = find("asn");
  if (asn === -1) return DEFAULT_LAYOUT;
  return {
    asn,
    name: find("name"),
    country: find("country"),
    registry: find("registry"),
  };
}

function fieldAt(fields: readonly string[], index: number): string | null {
  if (index < 0) return null;
  const value = fields[index];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** parses the csv into a map of networks. */
export function parseAsMetadataCsv(text: string): AsMetadata {
  const lines = text.split("\n");
  const networks = new Map<string, AsNetwork>();
  let layout: Layout | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;

    if (line.startsWith("#")) {
      // a comment. it may carry the column names, and then it is the header.
      const comment = splitLine(line.slice(1));
      if (layout === null && comment.some((field) => field.trim().toLowerCase() === "asn")) {
        layout = layoutFrom(comment);
      }
      continue;
    }

    const fields = splitLine(line);
    if (layout === null) {
      // the first row that is not a comment is the header, when it names the
      // asn column. otherwise the file has no header and the columns are in
      // the published order.
      if (fields[0]?.trim().toLowerCase() === "asn") {
        layout = layoutFrom(fields);
        continue;
      }
      layout = DEFAULT_LAYOUT;
    }

    const asn = normaliseAsn(fieldAt(fields, layout.asn) ?? "");
    if (asn === null) continue;
    const country = fieldAt(fields, layout.country);
    networks.set(asn, {
      asn,
      name: fieldAt(fields, layout.name),
      country: country === null ? null : country.toLowerCase(),
      registry: fieldAt(fields, layout.registry),
    });
  }

  return {
    count: networks.size,
    lookup(asn: string): AsNetwork | null {
      const key = normaliseAsn(asn);
      if (key === null) return null;
      return networks.get(key) ?? null;
    },
  };
}

/** reads and parses the file. the result keeps everything in memory. */
export function loadAsMetadata(path: string): AsMetadata {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new AsMetadataError(
      code === "ENOENT" ? "SB_INTEL_AS_CSV_MISSING" : "SB_INTEL_AS_CSV_INVALID",
    );
  }
  return parseAsMetadataCsv(text);
}
