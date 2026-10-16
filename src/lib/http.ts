// the one fetch that is not the discord client (AGENTS.md rule 6 carve-out):
// read-only cdn downloads for icons, emojis, stickers, attachments. plain GET,
// no auth header, a hard timeout, a size ceiling. anything on the api hosts is
// a hard error, because going around discord/client.ts skips the rate-limit
// guard and the error parser.

export interface CdnOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface CdnResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly size: number;
}

// the api hosts the client owns. reaching one from here would bypass the guard.
const API_HOSTS = new Set(["discord.com", "discordapp.com", "discord.co"]);
const CDN_HOST = "cdn.discordapp.com";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchCdn(url: string, options: CdnOptions = {}): Promise<CdnResponse> {
  const target = new URL(url);
  const bare = target.hostname.replace(/^(?:ptb|canary)\./, "");
  if (API_HOSTS.has(bare)) {
    throw new Error(
      `SB_CDN_API_HOST: ${target.hostname} is a discord api host, use discord/client.ts`,
    );
  }
  if (target.hostname !== CDN_HOST) {
    throw new Error(`SB_CDN_HOST: ${target.hostname} is not the cdn (${CDN_HOST})`);
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const response = await fetch(target, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "image/*,*/*" },
  });
  if (!response.ok) throw new Error(`SB_CDN_STATUS: ${response.status} for ${target.pathname}`);
  return readBounded(response, maxBytes);
}

async function readBounded(response: Response, maxBytes: number): Promise<CdnResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  // content-length is a hint, not a promise, so the stream is counted too.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes)
    throw new Error(`SB_CDN_TOO_LARGE: ${declared} bytes exceeds ${maxBytes}`);

  const body = response.body;
  if (body === null) return { bytes: new Uint8Array(0), contentType, size: 0 };

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`SB_CDN_TOO_LARGE: exceeded ${maxBytes} bytes`);
    }
    parts.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, contentType, size };
}
