// the only static files the site serves: two font files.
//
// the paths are an allowlist, not a join: a request can name one of these two
// and nothing else, so there is no traversal to get wrong. the files are read
// once, on the first request that needs one, and kept in memory after that.

import { notFound, type Route } from "./router.ts";

const FILES: Readonly<Record<string, string>> = {
  "/assets/fonts/geist-latin.woff2": "assets/fonts/geist-latin.woff2",
  "/assets/fonts/geist-mono-latin.woff2": "assets/fonts/geist-mono-latin.woff2",
};

const loaded = new Map<string, Uint8Array>();

async function bodyOf(path: string): Promise<Uint8Array | null> {
  const cached = loaded.get(path);
  if (cached !== undefined) return cached;
  const file = FILES[path];
  if (file === undefined) return null;
  try {
    const bytes = new Uint8Array(
      await Bun.file(new URL(`../../${file}`, import.meta.url)).arrayBuffer(),
    );
    loaded.set(path, bytes);
    return bytes;
  } catch {
    // a missing font is not an error page: the page falls back to a system
    // face and still reads. the stylesheet asks for it by name either way.
    return null;
  }
}

/** serves the fonts. anything else under /assets falls through to the 404. */
export function assetRoute(): Route {
  return async (ctx) => {
    const body = await bodyOf(ctx.path);
    if (body === null) return notFound();
    return {
      status: 200,
      headers: {
        "content-type": "font/woff2",
        "cache-control": "public, max-age=31536000, immutable",
      },
      body,
    };
  };
}
