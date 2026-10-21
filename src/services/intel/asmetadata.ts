// the network metadata (D4PLAN 14.4). the ipverse as-metadata file is one
// entry per autonomous system: the number, the registry handle, the
// organisation, the country it is registered in, and the category the file
// puts the network in.
//
// the category is the reason this file is worth fetching. it says what the
// network's primary function is, so "hosting" is a fact about the network
// rather than a guess read out of its name. the publisher says it is a
// useful default and not gospel, and it is used that way here.
//
// the file is published as json and as csv. the csv has no category, so the
// json is what this reader reads. the file is big because every entry also
// carries route statistics; only the metadata is kept, and the rest of the
// entry is walked over rather than parsed.
//
// the address is not in this file. the asn comes from the country database or
// from the ip-to-asn table, and this file gives the network behind it.

export type AsMetadataErrorCode = "SB_INTEL_AS_JSON_MISSING" | "SB_INTEL_AS_JSON_INVALID";

const MESSAGES: Record<AsMetadataErrorCode, string> = {
  SB_INTEL_AS_JSON_MISSING: "the as metadata file is not there",
  SB_INTEL_AS_JSON_INVALID: "the as metadata file has no usable entries",
};

export class AsMetadataError extends Error {
  readonly code: AsMetadataErrorCode;
  constructor(code: AsMetadataErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "AsMetadataError";
    this.code = code;
  }
}

/** what a network is for, as the file says. */
export type AsCategory = "isp" | "hosting" | "business" | "education_research" | "government_admin";

const CATEGORIES: readonly AsCategory[] = [
  "isp",
  "hosting",
  "business",
  "education_research",
  "government_admin",
];

/** one network, as the file describes it. */
export interface AsRecord {
  /** the number only, "15169". */
  readonly asn: string;
  /** the registry handle, or null. */
  readonly handle: string | null;
  /** the organisation, or null when the entry had no name. */
  readonly description: string | null;
  /** the country the network is registered in, two lowercase letters, or null. */
  readonly country: string | null;
  /** what the network's primary function is, or null when it is unclassified. */
  readonly category: AsCategory | null;
  /** the network's role in the routing, or null. */
  readonly networkRole: string | null;
}

export interface AsMetadata {
  /** how many networks the file holds. */
  readonly count: number;
  /** the network behind an asn, or null when the file does not have it. */
  lookup(asn: string): AsRecord | null;
}

/** the start of an entry: the asn and the metadata object that follows it. */
const ENTRY = /\{\s*"asn":\s*(\d+)\s*,\s*"metadata":\s*\{/g;

/** the fields of the metadata object, as they are read. */
interface Fields {
  readonly handle: string | null;
  readonly description: string | null;
  readonly country: string | null;
  readonly category: AsCategory | null;
  readonly networkRole: string | null;
}

/** the end of a json string, or null when the buffer ends inside it. */
function endOfString(text: string, start: number): number | null {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  return null;
}

/** the end of a json value that is not a string, or null when it runs out. */
function endOfValue(text: string, start: number): number | null {
  let index = start;
  let depth = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const end = endOfString(text, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (character === "," && depth === 0) return index;
    index += 1;
  }
  return null;
}

/**
 * reads the metadata object.
 *
 * the object holds strings and nulls only, but it is walked as json anyway,
 * so a value that changes shape later is skipped rather than misread.
 */
function readMetadata(text: string, start: number): { fields: Fields; end: number } | null {
  let index = start;
  const fields: Record<string, string | null> = {};

  while (index < text.length) {
    while (index < text.length && /[\s,]/.test(text[index] ?? "")) index += 1;
    const character = text[index];
    if (character === undefined) return null;
    if (character === "}") {
      return {
        fields: {
          handle: fields.handle ?? null,
          description: fields.description ?? null,
          country: fields.country ?? null,
          category: categoryOf(fields.category ?? null),
          networkRole: fields.networkRole ?? null,
        },
        end: index + 1,
      };
    }
    if (character !== '"') return null;

    const keyEnd = endOfString(text, index);
    if (keyEnd === null) return null;
    const key = text.slice(index + 1, keyEnd - 1);
    index = keyEnd;
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
    if (text[index] !== ":") return null;
    index += 1;
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;

    const valueStart = index;
    if (text[valueStart] === '"') {
      const valueEnd = endOfString(text, valueStart);
      if (valueEnd === null) return null;
      fields[key] = text.slice(valueStart + 1, valueEnd - 1);
      index = valueEnd;
    } else {
      const valueEnd = endOfValue(text, valueStart);
      if (valueEnd === null) return null;
      fields[key] = null;
      index = valueEnd;
    }
  }
  return null;
}

/** the category cell. the file writes null for a network it cannot place. */
function categoryOf(value: string | null): AsCategory | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return CATEGORIES.find((category) => category === trimmed) ?? null;
}

/** the country cell. */
function countryOf(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return null;
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * parses the file.
 *
 * the file is read in chunks and the entries are taken out of it as they
 * complete, so the whole seventy megabytes is never held at once.
 */
export async function parseAsMetadataFile(path: string): Promise<AsMetadata> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new AsMetadataError("SB_INTEL_AS_JSON_MISSING");

  const networks = new Map<string, AsRecord>();
  const decoder = new TextDecoder();
  let buffer = "";

  /** takes the entries out of the buffer. it answers where the unread part
   *  starts, so the caller can drop what was read and keep the rest. */
  const consume = (chunk: string): number => {
    ENTRY.lastIndex = 0;
    let match = ENTRY.exec(chunk);
    while (match !== null) {
      const asn = match[1] ?? "";
      const objectStart = match.index + match[0].length;
      const read = readMetadata(chunk, objectStart);
      // the entry is cut in half: it waits for the next chunk.
      if (read === null) return match.index;
      const fields = read.fields;
      networks.set(asn, {
        asn,
        handle: fields.handle,
        description: fields.description,
        country: countryOf(fields.country),
        category: fields.category,
        networkRole: fields.networkRole,
      });
      ENTRY.lastIndex = read.end;
      match = ENTRY.exec(chunk);
    }
    return chunk.length;
  };

  try {
    const stream = file.stream();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.slice(consume(buffer));
    }
    buffer += decoder.decode();
    consume(buffer);
  } catch {
    throw new AsMetadataError("SB_INTEL_AS_JSON_INVALID");
  }

  if (networks.size === 0) throw new AsMetadataError("SB_INTEL_AS_JSON_INVALID");

  return {
    count: networks.size,
    lookup(asn: string): AsRecord | null {
      const key = asn.trim().replace(/^AS/i, "");
      if (!/^\d+$/.test(key)) return null;
      return networks.get(key) ?? null;
    },
  };
}
