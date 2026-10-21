// the tor exit list. the tor project publishes the addresses of every exit
// node it knows about, and an address on that list is a tor exit, exactly.
//
// that is the one network fact in this build that is not a guess. everything
// else about a network is read out of a name or a category, and the refusal
// wording says so.
//
// the list is a few thousand lines and it changes every day. the bot
// downloads it (see update.ts).

export type TorListErrorCode = "SB_INTEL_TOR_MISSING" | "SB_INTEL_TOR_INVALID";

const MESSAGES: Record<TorListErrorCode, string> = {
  SB_INTEL_TOR_MISSING: "the tor exit list is not there",
  SB_INTEL_TOR_INVALID: "the tor exit list has no addresses",
};

export class TorListError extends Error {
  readonly code: TorListErrorCode;
  constructor(code: TorListErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "TorListError";
    this.code = code;
  }
}

export interface TorExits {
  /** how many exits the list holds. */
  readonly count: number;
  /** whether the address is one of the exits. */
  has(address: string): boolean;
}

/**
 * parses the list.
 *
 * the published format is one exit at a time: a fingerprint line, two dates
 * and an "ExitAddress <address> <when>" line. only the address is kept.
 */
export function parseTorExits(text: string): TorExits {
  const exits = new Set<string>();
  let index = 0;
  while (index < text.length) {
    let end = text.indexOf("\n", index);
    if (end === -1) end = text.length;
    const line = text.slice(index, end);
    index = end + 1;
    if (!line.startsWith("ExitAddress ")) continue;
    const address = line.slice("ExitAddress ".length).trim().split(/\s+/)[0] ?? "";
    if (address === "") continue;
    exits.add(address.toLowerCase());
  }
  if (exits.size === 0) throw new TorListError("SB_INTEL_TOR_INVALID");
  return {
    count: exits.size,
    has(address: string): boolean {
      return exits.has(address.trim().toLowerCase());
    },
  };
}

/** reads the file and parses it. */
export async function loadTorExits(path: string): Promise<TorExits> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new TorListError("SB_INTEL_TOR_MISSING");
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new TorListError("SB_INTEL_TOR_INVALID");
  }
  return parseTorExits(text);
}
