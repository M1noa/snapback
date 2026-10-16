import { describe, expect, test } from "bun:test";
import { ImageInputError, prepareImage, readImageDimensions } from "../../src/setup/image.ts";

// ---- real bytes, built here ------------------------------------------------

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

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
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
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

// an 8-bit rgb png. each row is [filter=0, then width * 3 bytes].
function rgbPng(width: number, rows: number[][]): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, rows.length);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type rgb
  const raw = new Uint8Array(rows.length * (1 + width * 3));
  let at = 0;
  for (const row of rows) {
    raw[at] = 0;
    at += 1;
    raw.set(row, at);
    at += row.length;
  }
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Bun.deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function gifBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // GIF89a
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    0x00,
    0x00,
    0x00, // packed, bg index, aspect
    0x3b, // trailer
  ]);
}

function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // length 17
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // component count
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9, // EOI
  ]);
}

// the output of a crop uses filter type 0 on every row, so decode is direct.
function decodeRgb(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = Bun.inflateSync(concat(parts));
  const stride = width * 3;
  const pixels = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    expect(raw[pos]).toBe(0); // filter none
    pos += 1;
    pixels.set(raw.subarray(pos, pos + stride), y * stride);
    pos += stride;
  }
  return { width, height, pixels };
}

function fromDataUri(uri: string): Uint8Array {
  return new Uint8Array(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
}

function pixel(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 3;
  return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
}

const LIMITS = { maxBytes: 8 * 1024 * 1024, square: true };

// row0: red, green, blue, yellow. row1: cyan, magenta, grey, dark.
const FOUR_BY_TWO = rgbPng(4, [
  [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
  [0, 255, 255, 255, 0, 255, 128, 128, 128, 10, 20, 30],
]);

describe("readImageDimensions", () => {
  test("reads a png from its ihdr", () => {
    expect(readImageDimensions(FOUR_BY_TWO)).toEqual({
      contentType: "image/png",
      width: 4,
      height: 2,
    });
  });

  test("reads a gif from its logical screen descriptor", () => {
    expect(readImageDimensions(gifBytes(4, 2))).toEqual({
      contentType: "image/gif",
      width: 4,
      height: 2,
    });
  });

  test("reads a jpeg from its start-of-frame", () => {
    expect(readImageDimensions(jpegBytes(32, 16))).toEqual({
      contentType: "image/jpeg",
      width: 32,
      height: 16,
    });
  });

  test("returns null on anything that is not an image", () => {
    expect(readImageDimensions(new TextEncoder().encode("hello world, not an image"))).toBeNull();
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
    // a text file named .png: the extension and content type are never trusted.
    expect(readImageDimensions(new TextEncoder().encode("\x89PNG not really"))).toBeNull();
  });
});

describe("prepareImage", () => {
  test("centre-crops a 4x2 png to the largest centred 2x2 square", () => {
    const prepared = prepareImage(FOUR_BY_TWO, LIMITS);
    expect(prepared.contentType).toBe("image/png");
    expect(prepared.width).toBe(2);
    expect(prepared.height).toBe(2);
    expect(prepared.cropped).toBe(true);

    const out = fromDataUri(prepared.dataUri);
    expect(readImageDimensions(out)).toEqual({ contentType: "image/png", width: 2, height: 2 });

    // columns 1 and 2, rows 0 and 1: green, blue, magenta, grey.
    const { pixels } = decodeRgb(out);
    expect(pixel(pixels, 2, 0, 0)).toEqual([0, 255, 0]);
    expect(pixel(pixels, 2, 1, 0)).toEqual([0, 0, 255]);
    expect(pixel(pixels, 2, 0, 1)).toEqual([255, 0, 255]);
    expect(pixel(pixels, 2, 1, 1)).toEqual([128, 128, 128]);
  });

  test("a square png passes through byte-identical", () => {
    const square = rgbPng(2, [
      [255, 0, 0, 0, 255, 0],
      [0, 0, 255, 255, 255, 0],
    ]);
    const prepared = prepareImage(square, LIMITS);
    expect(prepared.cropped).toBe(false);
    expect(prepared.width).toBe(2);
    expect(prepared.height).toBe(2);
    expect(fromDataUri(prepared.dataUri)).toEqual(square);
  });

  test("a gif that is already square passes through byte-identical", () => {
    const square = gifBytes(2, 2);
    const prepared = prepareImage(square, LIMITS);
    expect(prepared.cropped).toBe(false);
    expect(prepared.contentType).toBe("image/gif");
    expect(fromDataUri(prepared.dataUri)).toEqual(square);
  });

  test("an image over the ceiling is refused, naming the ceiling", () => {
    expect(() => prepareImage(FOUR_BY_TWO, { maxBytes: 4, square: true })).toThrow(ImageInputError);
    try {
      prepareImage(FOUR_BY_TWO, { maxBytes: 4, square: true });
    } catch (error) {
      const input = error as ImageInputError;
      expect(input.reason).toBe("too large");
      expect(input.fix).toContain("4 bytes");
    }
  });

  test("a text file named .png is refused on the magic bytes", () => {
    const fake = new TextEncoder().encode("this is not a png at all");
    expect(() => prepareImage(fake, LIMITS)).toThrow(ImageInputError);
    try {
      prepareImage(fake, LIMITS);
    } catch (error) {
      expect((error as ImageInputError).reason).toBe("not an image");
    }
  });

  test("a non-square gif is refused with the crop-it-yourself fix", () => {
    try {
      prepareImage(gifBytes(4, 2), LIMITS);
      throw new Error("expected a refusal");
    } catch (error) {
      const input = error as ImageInputError;
      expect(input.reason).toBe("not square");
      expect(input.fix).toContain("square");
      expect(input.fix).toContain("gif decoder");
    }
  });

  test("a non-square jpeg is refused and says why", () => {
    try {
      prepareImage(jpegBytes(32, 16), LIMITS);
      throw new Error("expected a refusal");
    } catch (error) {
      const input = error as ImageInputError;
      expect(input.reason).toBe("not square");
      expect(input.fix).toContain("jpeg decoder");
    }
  });

  test("square is not enforced when the caller says it does not matter", () => {
    const prepared = prepareImage(gifBytes(4, 2), { maxBytes: 1000, square: false });
    expect(prepared.cropped).toBe(false);
    expect(prepared.width).toBe(4);
    expect(prepared.height).toBe(2);
  });

  test("a png colour type this build does not handle is refused, not broken", () => {
    // a 4x2 palette png (colour type 3): crop cannot run.
    const ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, 4);
    writeU32(ihdr, 4, 2);
    ihdr[8] = 8;
    ihdr[9] = 3;
    const palette = concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", Bun.deflateSync(new Uint8Array(0))),
      chunk("IEND", new Uint8Array(0)),
    ]);
    try {
      prepareImage(palette, LIMITS);
      throw new Error("expected a refusal");
    } catch (error) {
      const input = error as ImageInputError;
      expect(input.reason).toBe("unsupported png");
      expect(input.fix).toContain("colour type 3");
    }
  });
});
