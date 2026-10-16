// a pure image pass for the branding uploads (D4PLAN 10.2). no dependency, no io.
//
// the format is sniffed from the magic bytes, never from the filename or a
// declared content type, because both are attacker-controlled. anything we
// cannot handle is refused with a reason and a fix rather than uploaded broken.
//
// the one transform is a centre-crop to a square, and it only runs for 8-bit
// non-interlaced rgb/rgba pngs: undoing a png's row filters is small enough to
// do by hand, whereas jpeg and gif are left to the operator. zlib is bun's own
// inflate/deflate, so no dependency is pulled in.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_SIGNATURES = ["GIF87a", "GIF89a"];

/** a rejected upload. `reason` is the short cause, `fix` the one actionable next
 *  step, so a caller can surface both without a second lookup. */
export class ImageInputError extends Error {
  readonly reason: string;
  readonly fix: string;

  constructor(reason: string, fix: string) {
    super(`${reason}: ${fix}`);
    this.name = "ImageInputError";
    this.reason = reason;
    this.fix = fix;
  }
}

export interface ImageLimits {
  readonly maxBytes: number;
  /** crop a non-square image to its largest centred square. */
  readonly square: boolean;
}

export interface PreparedImage {
  readonly dataUri: string;
  readonly contentType: string;
  /** the byte length of the output, after any crop. */
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly cropped: boolean;
}

/** the sniffed format and its pixel size, or null when the bytes are not an
 *  image this build recognises. never reads a declared content type. */
export function readImageDimensions(
  bytes: Uint8Array,
): { contentType: string; width: number; height: number } | null {
  if (isPng(bytes)) return readPngDimensions(bytes);
  if (isGif(bytes)) return readGifDimensions(bytes);
  if (isJpeg(bytes)) return readJpegDimensions(bytes);
  return null;
}

/** validate, and centre-crop a non-square png to a square. `limits.square`
 *  turns the crop on; a caller that accepts any aspect passes square: false. */
export function prepareImage(bytes: Uint8Array, limits: ImageLimits): PreparedImage {
  if (bytes.byteLength > limits.maxBytes) {
    const mib = limits.maxBytes / (1024 * 1024);
    const ceiling = Number.isInteger(mib) ? `${mib} MiB` : `${limits.maxBytes} bytes`;
    throw new ImageInputError("too large", `the ceiling is ${ceiling}. upload a smaller image.`);
  }

  const sniffed = readImageDimensions(bytes);
  if (sniffed === null) {
    throw new ImageInputError("not an image", "upload a png, jpeg, or gif.");
  }
  const { contentType, width, height } = sniffed;

  if (width === height || !limits.square) {
    return build(bytes, contentType, width, height, false);
  }

  // a non-square image and square required. only png can be cropped here.
  if (contentType !== "image/png") {
    const name = contentType === "image/gif" ? "gif" : "jpeg";
    throw new ImageInputError(
      "not square",
      `crop it to a square and re-upload. this build has no ${name} decoder, so a non-square image cannot be cropped for you.`,
    );
  }

  const size = Math.min(width, height);
  const cropped = cropPng(bytes, width, height);
  return build(cropped, "image/png", size, size, true);
}

// ---- format sniffing -------------------------------------------------------

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  return GIF_SIGNATURES.includes(latin1(bytes, 0, 6));
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function readPngDimensions(
  bytes: Uint8Array,
): { contentType: string; width: number; height: number } | null {
  // signature(8) + length(4) + type(4) + ihdr width+height(8).
  if (bytes.length < 24) return null;
  if (latin1(bytes, 12, 4) !== "IHDR") return null;
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { contentType: "image/png", width, height };
}

function readGifDimensions(
  bytes: Uint8Array,
): { contentType: string; width: number; height: number } | null {
  // the logical screen descriptor holds little-endian width then height.
  if (bytes.length < 10) return null;
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  if (width <= 0 || height <= 0) return null;
  return { contentType: "image/gif", width, height };
}

function readJpegDimensions(
  bytes: Uint8Array,
): { contentType: string; width: number; height: number } | null {
  let offset = 2; // past SOI
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1]!;
    // a run of 0xff fill bytes precedes the real marker.
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1]!;
    }
    offset += 2;
    // standalone markers carry no length segment.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (width <= 0 || height <= 0) return null;
      return { contentType: "image/jpeg", width, height };
    }
    offset += length;
  }
  return null;
}

// ---- the png centre-crop ---------------------------------------------------

function cropPng(bytes: Uint8Array, width: number, height: number): Uint8Array {
  let header: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  for (const chunk of parsePngChunks(bytes)) {
    if (chunk.type === "IHDR") header = chunk.data;
    else if (chunk.type === "IDAT") data.push(chunk.data);
    // ancillary chunks are dropped: the crop is a new image and needs none of
    // them to decode, and carrying a stale one risks a wrong colour profile.
  }
  if (header === null || header.length < 13 || data.length === 0) {
    throw new ImageInputError("unreadable png", "re-save the image and upload it again.");
  }

  const bitDepth = header[8]!;
  const colourType = header[9]!;
  const interlace = header[12]!;
  if (bitDepth !== 8) {
    throw new ImageInputError(
      "unsupported png",
      `this build only crops 8-bit pngs; this one is ${bitDepth}-bit. re-save it as an 8-bit png.`,
    );
  }
  if (colourType !== 2 && colourType !== 6) {
    throw new ImageInputError(
      "unsupported png",
      `this build only crops rgb and rgba pngs (colour type 2 or 6); this one is colour type ${colourType}. re-save it as rgb or rgba.`,
    );
  }
  if (interlace !== 0) {
    throw new ImageInputError(
      "unsupported png",
      "this build does not crop interlaced pngs. re-save it without interlacing.",
    );
  }

  const channels = colourType === 6 ? 4 : 3;
  const inflated = Bun.inflateSync(concat(data));
  const pixels = unfilter(inflated, width, height, channels);

  const size = Math.min(width, height);
  const left = (width - size) >> 1;
  const top = (height - size) >> 1;
  const rowBytes = size * channels;

  // rebuild the scanlines with filter type 0 (none), so nothing has to predict.
  const filtered = new Uint8Array(size * (rowBytes + 1));
  let at = 0;
  for (let y = 0; y < size; y++) {
    filtered[at] = 0;
    at += 1;
    const from = ((top + y) * width + left) * channels;
    filtered.set(pixels.subarray(from, from + rowBytes), at);
    at += rowBytes;
  }

  const newHeader = new Uint8Array(13);
  writeU32(newHeader, 0, size);
  writeU32(newHeader, 4, size);
  newHeader[8] = bitDepth;
  newHeader[9] = colourType;
  // compression, filter method, interlace all stay 0.

  return concat([
    new Uint8Array(PNG_SIGNATURE),
    pngChunk("IHDR", newHeader),
    pngChunk("IDAT", Bun.deflateSync(filtered)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

interface RawChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

function parsePngChunks(bytes: Uint8Array): RawChunk[] {
  const chunks: RawChunk[] = [];
  let offset = 8; // past the signature
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = latin1(bytes, offset + 4, 4);
    const start = offset + 8;
    if (start + length + 4 > bytes.length) break; // truncated chunk
    chunks.push({ type, data: bytes.subarray(start, start + length) });
    offset = start + length + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

// undo the png per-row filters back to raw channel bytes. only used on pngs we
// have already agreed to handle.
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new ImageInputError(
      "unreadable png",
      "the image data is incomplete. re-save and upload it again.",
    );
  }
  const out = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos]!;
    pos += 1;
    const row = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos]!;
      pos += 1;
      const a = x >= channels ? out[row + x - channels]! : 0;
      const b = y > 0 ? out[prev + x]! : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels]! : 0;
      let unfiltered: number;
      switch (filter) {
        case 0:
          unfiltered = value;
          break;
        case 1:
          unfiltered = value + a;
          break;
        case 2:
          unfiltered = value + b;
          break;
        case 3:
          unfiltered = value + ((a + b) >> 1);
          break;
        case 4:
          unfiltered = value + paeth(a, b, c);
          break;
        default:
          throw new ImageInputError(
            "unreadable png",
            `row filter ${filter} is not valid. re-save the image and upload it again.`,
          );
      }
      out[row + x] = unfiltered & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---- png bytes -------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// length(4) + type(4) + data + crc(4), the crc covering type and data.
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// ---- shared helpers --------------------------------------------------------

function build(
  data: Uint8Array,
  contentType: string,
  width: number,
  height: number,
  cropped: boolean,
): PreparedImage {
  return {
    dataUri: `data:${contentType};base64,${Buffer.from(data).toString("base64")}`,
    contentType,
    bytes: data.byteLength,
    width,
    height,
    cropped,
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function latin1(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[at + i]!);
  return out;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}
