// scripts/preview/server.ts
//
// a dev server that draws every page the bot can draw, so the design can be
// looked at and argued about before it is pushed.
//
//   bun run scripts/preview/server.ts [port]
//
// this is not a product surface and not a way to reach the bot's data: it holds
// invented data in memory, it binds to localhost, and it reads nothing from the
// database. it exists to be looked at.

import { buildPages, type PreviewPage } from "./pages.ts";
import { renderPage } from "./render.ts";

const PORT = Number.parseInt(process.argv[2] ?? "5173", 10);

const pages = buildPages();
const byPath = new Map(pages.map((page) => [page.path, page]));

function index(): string {
  const groups = new Map<string, PreviewPage[]>();
  for (const page of pages) {
    const list = groups.get(page.surface) ?? [];
    list.push(page);
    groups.set(page.surface, list);
  }
  const sections = [...groups.entries()]
    .map(
      ([surface, list]) =>
        `<h2>${surface}</h2><ul>${list
          .map(
            (page) => `<li><a href="${page.path}">${page.title}</a> <code>${page.path}</code></li>`,
          )
          .join("")}</ul>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>snapback preview</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #313338; color: #dbdee1; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1rem; color: #949ba4; margin-top: 2rem; text-transform: uppercase; letter-spacing: 0.05em; }
ul { padding-left: 1.2rem; }
li { margin: 0.2rem 0; }
a { color: #00a8fc; }
code { color: #949ba4; font-size: 0.85em; }
p.note { color: #949ba4; max-width: 40rem; }
</style></head>
<body>
<h1>snapback preview</h1>
<p class="note">every page the bot can draw, with invented data. the layout is the real one; the content is not. this server is a dev tool and reaches nothing.</p>
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
      return new Response("<h1>not found</h1><p><a href='/'>index</a></p>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(renderPage(page.tree, page.title), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.info(`the preview is at http://${server.hostname}:${server.port} — ${pages.length} pages`);
