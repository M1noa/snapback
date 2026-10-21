// scripts/brand/index.ts
//
// renders the app icon and the profile banner in the site's own language, as
// png and as animated gif. the frames are chrome screenshots of
// scripts/brand/render.html — real fonts, the grain tile, the house pastel at
// one fixed hue on a black page. both surfaces are the wordmark: "sb" on the
// icon, "snapback" on the banner. what moves is what is periodic in the frame
// count: the grain steps its ten offsets, the glow breathes, the letters ride
// a low wave. frame frame_count lands back on frame 0's values, so the gif
// wraps clean.
//
//   bun run scripts/brand/index.ts
//
// output: assets/brand/app-icon.png, app-icon.gif, app-banner.png, app-banner.gif

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { PNG } from "pngjs";

const root = new URL("../..", import.meta.url).pathname;
const render = new URL("./render.html", import.meta.url).href;
const outDir = `${root}assets/brand`;
const framesDir = `${mkdtempSync(`${os.tmpdir()}/snapback-brand-`)}`;

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// the surfaces: which renderer surface to shoot, at discord's own sizes
const surfaces = [
  { name: "icon", width: 512, height: 512 },
  { name: "banner", width: 1024, height: 576 },
] as const;

// the loop: 10 frames, 70ms each, no end. ten matches the grain's offset
// count (render.html), so frame FRAME_COUNT repeats frame 0 exactly
const FRAME_COUNT = 10;
const FRAME_MS = 70;

// one fresh chrome profile per shot: a shared one makes the second instance
// wait on the first's profile lock. chrome sometimes lingers after it has
// written the file, so the shoot is done on file presence with a deadline,
// not on the process exiting
let shotCount = 0;
async function shot(href: string, out: string, width: number, height: number): Promise<void> {
  shotCount += 1;
  const proc = Bun.spawn([
    CHROME,
    "--headless",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${framesDir}/p${shotCount}`,
    "--virtual-time-budget=4000",
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    href,
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await Bun.file(out).exists())) await Bun.sleep(150);
  if (!(await Bun.file(out).exists())) {
    proc.kill();
    throw new Error(`chrome wrote nothing for ${href}`);
  }
  await Bun.sleep(300); // let the buffer land before the process goes away
  proc.kill();
  await proc.exited;
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // rgba, one byte per channel
}

async function decode(path: string): Promise<Frame> {
  const png = PNG.sync.read(Buffer.from(await Bun.file(path).arrayBuffer()));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

// the 8x8 bayer matrix, threshold scale 0..63
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

// bayer dithering across rgb before quantising, so soft glows do not band in
// the 256-colour gif. spread is in 8-bit steps
function dither(frame: Frame, spread: number): Uint8Array {
  const out = new Uint8Array(frame.data.length);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const threshold = BAYER[(y % 8) * 8 + (x % 8)] ?? 0;
      const t = (threshold / 64 - 0.5) * spread;
      const i = (y * frame.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.min(255, Math.max(0, (frame.data[i + c] ?? 0) + t));
      }
      out[i + 3] = 255;
    }
  }
  return out;
}

async function gif(frames: Frame[], out: string): Promise<void> {
  const enc = GIFEncoder();
  // a palette per frame: the glow breathes and the grain steps between
  // frames, so a shared palette would still miss on the softer frames
  for (const frame of frames) {
    const palette = quantize(dither(frame, 20), 256, { format: "rgb565" });
    enc.writeFrame(applyPalette(dither(frame, 20), palette, "rgb565"), frame.width, frame.height, {
      palette,
      delay: FRAME_MS,
      repeat: 0,
    });
  }
  enc.finish();
  await Bun.write(out, enc.bytes());
}

async function build(surface: (typeof surfaces)[number]): Promise<void> {
  const { name, width, height } = surface;
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const frames: Frame[] = [];
  for (let f = 0; f <= FRAME_COUNT; f++) {
    const file = `${framesDir}/${f}.png`;
    await shot(`${render}?surface=${name}&frame=${f}`, file, width, height);
    if (f < FRAME_COUNT) frames.push(await decode(file));
  }

  // the static png is the settled poster frame, not a mid-animation one
  await Bun.write(`${outDir}/app-${name}.png`, Bun.file(`${framesDir}/${FRAME_COUNT}.png`));
  await gif(frames, `${outDir}/app-${name}.gif`);
  console.log(
    `app-${name}: png + gif (${frames.length} frames, ${Math.round((await Bun.file(`${outDir}/app-${name}.gif`)).size / 1024)} KiB)`,
  );
}

for (const surface of surfaces) await build(surface);
rmSync(framesDir, { recursive: true, force: true });
