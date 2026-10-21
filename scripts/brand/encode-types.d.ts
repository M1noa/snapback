// gifenc and pngjs ship no declared types; this is the slice the render uses
declare module "pngjs" {
  export interface PNGData {
    width: number;
    height: number;
    data: Buffer & { readonly [index: number]: number };
  }
  export interface PNGOptions {
    readonly filterType?: number | number[];
  }
  export class PNG {
    static sync: {
      read(buffer: Buffer, options?: PNGOptions): PNGData;
      write(png: PNGData, options?: PNGOptions): Buffer;
    };
    width: number;
    height: number;
    data: Buffer;
  }
}

declare module "gifenc" {
  export interface Palette {
    readonly [index: number]: readonly number[];
    readonly length: number;
  }
  export interface GifFrameOptions {
    readonly palette?: Palette;
    readonly delay?: number;
    readonly repeat?: number;
    readonly transparent?: boolean;
    readonly transparentIndex?: number;
    readonly first?: boolean;
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(options?: {
    readonly auto?: boolean;
    readonly initialCapacity?: number;
  }): Encoder;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      readonly format?: "rgb565" | "rgb444" | "rgba4444";
      readonly oneBitAlpha?: boolean | number;
      readonly clearAlpha?: boolean;
    },
  ): Palette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;
}
