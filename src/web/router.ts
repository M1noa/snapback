// the web router (D4PLAN 13.1). three routes, one process, no framework, plus
// the font files under /assets.
//
// everything that is not one of them is a 404 with a plain page. there is no
// directory listing, and no error page that leaks a path.
//
// the site is deliberately just the verification: a landing page and the
// result. no disclosure page, no revoke page.

import { page } from "./views/pages.ts";

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** the socket's remote address, when the server has one. */
  readonly remoteAddress: string | null;
  /** the posted form's body. lazy: a route that never asks reads nothing. */
  readonly text: () => Promise<string>;
}

export interface WebResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** bytes for the font files, a string for every page. */
  readonly body: string | Uint8Array;
}

export type Route = (ctx: RequestContext) => Promise<WebResponse> | WebResponse;

export interface RouterOptions {
  readonly home: Route;
  readonly callback: Route;
  readonly health: Route;
  /** the font files. the one path that is a prefix rather than an exact match. */
  readonly assets: Route;
}

/** the 404 body. the same shell every page uses, and no path in it: a 404 that
 *  echoes the path is its own bug. */
export function notFound(): WebResponse {
  return {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: page({
      title: "not found",
      body: `<p class="eyebrow">404</p><h1>This page does not exist</h1><p class="lede">The verification link a server generates is the one to use.</p>`,
    }),
  };
}

/** the router. the paths are exact: a trailing slash is a different path. */
export function createRouter(
  options: RouterOptions,
): (ctx: RequestContext) => Promise<WebResponse> {
  return async (ctx) => {
    switch (ctx.path) {
      case "/":
        return await options.home(ctx);
      case "/callback":
        return await options.callback(ctx);
      case "/health":
        return await options.health(ctx);
      default:
        if (ctx.path.startsWith("/assets/")) return await options.assets(ctx);
        return notFound();
    }
  };
}
