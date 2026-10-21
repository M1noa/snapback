// the only static files the site serves: three font files and the grain tile.
// sora, geist mono and rubik 80s fade stay in assets/fonts for the brand
// renders; the site no longer serves them.
//
// the paths are an allowlist, not a join: a request can name one of these and
// nothing else, so there is no traversal to get wrong. a file is read once, on
// the first request that needs it, and kept in memory after that.

import { notFound, type Route } from "./router.ts";

interface Asset {
  /** the path under the repo root. fixed, never built from the request. */
  readonly file: string;
  readonly type: string;
}

const FILES: Readonly<Record<string, Asset>> = {
  "/assets/fonts/manrope-latin.woff2": {
    file: "assets/fonts/manrope-latin.woff2",
    type: "font/woff2",
  },
  "/assets/fonts/syne-latin.woff2": { file: "assets/fonts/syne-latin.woff2", type: "font/woff2" },
  "/assets/fonts/syne-mono-latin.woff2": {
    file: "assets/fonts/syne-mono-latin.woff2",
    type: "font/woff2",
  },
  "/assets/noise.png": { file: "assets/noise.png", type: "image/png" },
};

const loaded = new Map<string, Uint8Array>();

async function bodyOf(path: string): Promise<Uint8Array | null> {
  const cached = loaded.get(path);
  if (cached !== undefined) return cached;
  const asset = FILES[path];
  if (asset === undefined) return null;
  try {
    const bytes = new Uint8Array(
      await Bun.file(new URL(`../../${asset.file}`, import.meta.url)).arrayBuffer(),
    );
    loaded.set(path, bytes);
    return bytes;
  } catch {
    // a missing file is not an error page: the page falls back to a system
    // face and no grain and still reads. the stylesheet asks by name either way.
    return null;
  }
}

/** serves the fonts and the grain. anything else under /assets is the 404. */
export function assetRoute(): Route {
  return async (ctx) => {
    const asset = FILES[ctx.path];
    if (asset === undefined) return notFound();
    const body = await bodyOf(ctx.path);
    if (body === null) return notFound();
    return {
      status: 200,
      headers: {
        "content-type": asset.type,
        "cache-control": "public, max-age=31536000, immutable",
      },
      body,
    };
  };
}
