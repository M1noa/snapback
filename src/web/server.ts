// the web server (D4PLAN 13.1). one process, bun.serve, five routes.
//
// the server holds no state of its own: the state and the tokens live in the
// stores the services own, so a second worker behaves the same.

import type { Database } from "../db/types.ts";
import type { Logger } from "../lib/log.ts";
import type { IpCaptureOptions } from "./capture/ip.ts";
import { createRouter, type RequestContext, type Route, type WebResponse } from "./router.ts";

export interface ServerDeps {
  readonly db: Database;
  readonly log: Logger;
  /** the ip capture's configuration: the mode, the pepper and the key. */
  readonly ip: IpCaptureOptions;
  /** the five routes, built by the caller. */
  readonly routes: {
    readonly home: Route;
    readonly callback: Route;
    readonly revoke: Route;
    readonly health: Route;
    readonly legal: Route;
  };
  readonly port: number;
  readonly hostname?: string;
}

export interface WebServer {
  readonly port: number;
  readonly url: string;
  stop(): void;
}

export function createServer(deps: ServerDeps): WebServer {
  const router = createRouter({
    home: deps.routes.home,
    callback: deps.routes.callback,
    revoke: deps.routes.revoke,
    health: deps.routes.health,
    legal: deps.routes.legal,
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
          body: "<!doctype html><html><body><h1>something went wrong</h1></body></html>",
        };
      }

      return new Response(response.body, { status: response.status, headers: response.headers });
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
