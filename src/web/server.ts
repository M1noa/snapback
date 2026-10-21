// the web server (D4PLAN 13.1). one process, bun.serve, three routes.
//
// the server holds no state of its own: the state and the tokens live in the
// stores the services own, so a second worker behaves the same.

import type { Database } from "../db/types.ts";
import type { Logger } from "../lib/log.ts";
import { WEB_CSP } from "./capture/fingerprint-script.ts";
import type { IpCaptureOptions } from "./capture/ip.ts";
import { createRouter, type RequestContext, type Route, type WebResponse } from "./router.ts";
import { page } from "./views/pages.ts";

export interface ServerDeps {
  readonly db: Database;
  readonly log: Logger;
  /** the ip capture's configuration: the mode, the pepper and the key. */
  readonly ip: IpCaptureOptions;
  /** the three routes, built by the caller. */
  readonly routes: {
    readonly home: Route;
    readonly callback: Route;
    readonly health: Route;
    readonly assets: Route;
  };
  readonly port: number;
  readonly hostname?: string;
}

/** the headers every response carries. the csp allows exactly one inline
 *  script (ours, allowed by hash), inline css, and discord's icon cdn. a route
 *  that sets a header replaces the default line for line, and no route does. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": WEB_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

export interface WebServer {
  readonly port: number;
  readonly url: string;
  stop(): void;
}

export function createServer(deps: ServerDeps): WebServer {
  const router = createRouter({
    home: deps.routes.home,
    callback: deps.routes.callback,
    health: deps.routes.health,
    assets: deps.routes.assets,
  });

  const server = Bun.serve({
    port: deps.port,
    hostname: deps.hostname ?? "0.0.0.0",
    async fetch(request, server_): Promise<Response> {
      const url = new URL(request.url);
      const ctx: RequestContext = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        // the socket's address, for the ip capture when there is no proxy header.
        remoteAddress: server_.requestIP(request)?.address ?? null,
      };

      let response: WebResponse;
      try {
        response = await router(ctx);
      } catch (error) {
        // a failure in a route is a 500 with a plain page. the detail goes to the
        // log, never to the person: an error page that leaks a path is its own
        // bug (13.1).
        deps.log.error("web route threw", {
          path: ctx.path,
          message: error instanceof Error ? error.message : String(error),
        });
        response = {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: page({
            title: "something went wrong",
            body: `<div class="single"><h1>Something went wrong</h1><p class="lede">Try again in a moment. If it keeps happening, tell the person who sent you here.</p></div>`,
          }),
        };
      }

      return new Response(response.body, {
        status: response.status,
        headers: { ...BASE_HEADERS, ...response.headers },
      });
    },
  });

  return {
    port: server.port ?? deps.port,
    url: `http://localhost:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}
