// the web router (D4PLAN 13.1). five routes, one process, no framework.
//
// everything that is not one of them is a 404 with a plain page. there is no
// directory listing, and no error page that leaks a path.

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** the socket's remote address, when the server has one. */
  readonly remoteAddress: string | null;
}

export interface WebResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type Route = (ctx: RequestContext) => Promise<WebResponse> | WebResponse;

export interface RouterOptions {
  readonly home: Route;
  readonly callback: Route;
  readonly revoke: Route;
  readonly health: Route;
  readonly legal: Route;
}

const NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>not found</title></head>
<body><h1>not found</h1><p>that page does not exist.</p></body></html>`;

export function notFound(): WebResponse {
  return {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: NOT_FOUND,
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
      case "/revoke":
        return await options.revoke(ctx);
      case "/health":
        return await options.health(ctx);
      case "/legal":
        return await options.legal(ctx);
      default:
        return notFound();
    }
  };
}
