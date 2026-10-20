// scripts/preview/server.ts
//
// a dev server that serves the website's real pages, so the design can be
// looked at and argued about before it is pushed.
//
//   bun run scripts/preview/server.ts [port]
//
// this is not a product surface and not a way to reach the bot's data: it holds
// invented data in memory, it binds to localhost, and it reads nothing from the
// database. it exists to be looked at.

import { buildPages } from "./pages.ts";

const PORT = Number.parseInt(process.argv[2] ?? "5173", 10);

const pages = buildPages();
const byPath = new Map(pages.map((page) => [page.path, page]));

function index(): string {
  const sections = [...new Set(pages.map((page) => page.surface))]
    .map((surface) => {
      const list = pages.filter((page) => page.surface === surface);
      return `<h2>${surface}</h2><ul>${list
        .map((page) => `<li><a href="${page.path}">${page.title}</a></li>`)
        .join("")}</ul>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>snapback preview</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: oklch(0.185 0.014 265); color: oklch(0.94 0.008 262); }
h1 { font-size: 1.3rem; }
h2 { font-size: 0.9rem; color: oklch(0.56 0.012 258); margin-top: 2rem; text-transform: lowercase; letter-spacing: 0.2em; }
ul { padding-left: 1.2rem; }
li { margin: 0.2rem 0; }
a { color: oklch(0.55 0.2 277); }
p.note { color: oklch(0.7 0.012 258); max-width: 40rem; }
</style></head>
<body>
<h1>snapback preview</h1>
<p class="note">the website, with invented data. the pages are built by the real builders; the content is not. setup and the commands live in discord, and this server is a dev tool that reaches nothing.</p>
${sections}
</body></html>`;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(index(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const page = byPath.get(url.pathname);
    if (page === undefined) {
      return new Response(`<h1>not found</h1><p><a href="/"><code>/</code></a></p>`, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(page.html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.info(`the preview is at http://${server.hostname}:${server.port} — ${pages.length} pages`);
