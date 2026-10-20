// scripts/preview/render.ts
//
// a components-v2 tree, rendered as html.
//
// this is a dev tool, not a product surface: it exists so the pages can be
// looked at and argued about before they are pushed to a real server. it is an
// approximation of what discord draws, close enough to judge a layout and not
// close enough to be a pixel-perfect reference.

const CONTAINER = 17;
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const TEXT_INPUT = 4;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const SEPARATOR = 14;
const LABEL = 18;

const STYLE_NAMES: Readonly<Record<number, string>> = {
  1: "primary",
  2: "secondary",
  3: "success",
  4: "danger",
  5: "link",
};

interface Node {
  type?: number;
  content?: string;
  components?: Node[];
  accessory?: Node;
  custom_id?: string;
  label?: string;
  style?: number;
  url?: string;
  disabled?: boolean;
  placeholder?: string;
  options?: { label: string; value: string; description?: string | null; default?: boolean }[];
  accentColor?: number;
  media?: { url: string };
  description?: string | null;
  divider?: boolean;
  value?: string;
  component?: Node;
}

/** the page as html, inside discord's own look. */
export function renderPage(tree: unknown, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #313338;
  --bg-raised: #2b2d31;
  --text: #dbdee1;
  --muted: #949ba4;
  --line: #3f4147;
  --brand: #5865f2;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: gg sans, "Noto Sans", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.375;
}
header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #232428;
  border-bottom: 1px solid var(--line);
  padding: 0.75rem 1rem;
  display: flex;
  gap: 1rem;
  align-items: baseline;
  flex-wrap: wrap;
}
header h1 { font-size: 1rem; margin: 0; font-weight: 600; }
header a { color: var(--muted); text-decoration: none; font-size: 0.85rem; }
header a:hover { color: var(--text); }
main { padding: 1.5rem 1rem 4rem; display: flex; flex-direction: column; gap: 2rem; }
.caption { color: var(--muted); font-size: 0.8rem; margin: -1.25rem 0 0; }
.container {
  background: var(--bg-raised);
  border-radius: 0.5rem;
  border-top: 4px solid var(--line);
  max-width: 40rem;
  overflow: hidden;
}
.container.has-accent { border-top-color: var(--accent); }
.container > * { padding: 0 1rem; }
.container > .text:first-child { padding-top: 0.75rem; }
.container > .text:last-child { padding-bottom: 0.75rem; }
.text { white-space: pre-wrap; }
.text h1 { font-size: 1.25rem; margin: 0.25rem 0 0; }
.text h2 { font-size: 1.1rem; margin: 0.25rem 0 0; }
.text strong { font-weight: 700; }
.text code { background: #2c2d33; padding: 0.05rem 0.25rem; border-radius: 0.25rem; font-size: 0.9em; }
.text .muted { color: var(--muted); font-size: 0.85rem; }
.text .mention { background: #5865f233; color: #c9cdfb; border-radius: 0.25rem; padding: 0 0.15rem; }
.text .timestamp { background: #5865f233; color: #c9cdfb; border-radius: 0.25rem; padding: 0 0.15rem; }
.text a { color: #00a8fc; }
.row { display: flex; gap: 0.5rem; flex-wrap: wrap; padding: 0.5rem 1rem; }
.row + .row { padding-top: 0; }
.section { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem 1rem; }
.section .text { flex: 1; }
.thumb { width: 4rem; height: 4rem; border-radius: 0.5rem; object-fit: cover; flex: none; }
.separator { height: 1px; background: var(--line); margin: 0.75rem 1rem; }
.separator.spaced { height: 1.5rem; background: none; }
button, .select {
  font: inherit;
  border: none;
  border-radius: 0.375rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  background: #4e5058;
  color: var(--text);
}
button.primary { background: var(--brand); color: #fff; }
button.success { background: #248046; color: #fff; }
button.danger { background: #da373c; color: #fff; }
button.link { background: none; color: #00a8fc; padding-left: 0; padding-right: 0; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.select { display: flex; justify-content: space-between; align-items: center; gap: 1rem; width: 100%; text-align: left; }
.select .placeholder { color: var(--muted); }
.select .options { color: var(--muted); font-size: 0.85rem; }
.label-block { padding: 0.5rem 1rem; }
.label-block .label-name { font-weight: 600; font-size: 0.85rem; }
.label-block .label-desc { color: var(--muted); font-size: 0.8rem; margin-bottom: 0.25rem; }
input.textinput { width: 100%; font: inherit; background: #1e1f22; border: 1px solid var(--line); border-radius: 0.375rem; padding: 0.5rem; color: var(--text); }
a.back { color: var(--muted); text-decoration: none; font-size: 0.85rem; }
a.back:hover { color: var(--text); }
</style>
</head>
<body>
<header>
  <h1>snapback preview</h1>
  <a href="/">index</a>
  <span class="muted">${escapeHtml(title)}</span>
</header>
<main>
${renderNode(tree as Node)}
</main>
</body>
</html>`;
}

function renderNode(node: Node): string {
  switch (node.type) {
    case CONTAINER:
      return renderContainer(node);
    case ACTION_ROW:
      return `<div class="row">${(node.components ?? []).map(renderNode).join("")}</div>`;
    case BUTTON:
      return renderButton(node);
    case STRING_SELECT:
      return renderSelect(node);
    case TEXT_DISPLAY:
      return `<div class="text">${markdown(node.content ?? "")}</div>`;
    case SECTION:
      return `<div class="section">${(node.components ?? []).map(renderNode).join("")}${node.accessory ? renderNode(node.accessory) : ""}</div>`;
    case THUMBNAIL:
      return `<img class="thumb" src="${escapeHtml(node.media?.url ?? "")}" alt="">`;
    case SEPARATOR:
      return `<div class="separator${node.divider === false ? " spaced" : ""}"></div>`;
    case LABEL:
      return `<div class="label-block"><div class="label-name">${escapeHtml(node.label ?? "")}</div>${
        node.description ? `<div class="label-desc">${escapeHtml(node.description)}</div>` : ""
      }${node.component ? renderNode(node.component) : ""}</div>`;
    case TEXT_INPUT:
      return `<input class="textinput" placeholder="${escapeHtml(node.placeholder ?? node.label ?? "")}">`;
    default:
      return "";
  }
}

function renderContainer(node: Node): string {
  const accent = typeof node.accentColor === "number" ? node.accentColor : null;
  const style =
    accent === null ? "" : ` style="--accent: #${accent.toString(16).padStart(6, "0")}"`;
  const className = accent === null ? "container" : "container has-accent";
  return `<div class="${className}"${style}>${(node.components ?? []).map(renderNode).join("")}</div>`;
}

function renderButton(node: Node): string {
  const style = STYLE_NAMES[node.style ?? 2] ?? "secondary";
  const disabled = node.disabled === true ? " disabled" : "";
  const text = escapeHtml(node.label ?? "button");
  if (node.url !== undefined) {
    return `<a class="link" href="${escapeHtml(node.url)}">${text}</a>`;
  }
  return `<button class="${style}"${disabled} title="${escapeHtml(node.custom_id ?? "")}">${text}</button>`;
}

function renderSelect(node: Node): string {
  const first = node.options?.find((option) => option.default) ?? node.options?.[0];
  const label = first === undefined ? (node.placeholder ?? "select") : first.label;
  const count = node.options === undefined ? 0 : node.options.length;
  return `<div class="select"><span>${escapeHtml(label)}</span><span class="options">${count} option(s)</span></div>`;
}

/** discord's own markdown, roughly: headings, bold, code, mentions and the
 *  relative timestamps the pages use. */
function markdown(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/^### (.+)$/gm, "<h1>$1</h1>");
  out = out.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`(.+?)`/g, "<code>$1</code>");
  out = out.replace(/&lt;@(\d+)&gt;/g, '<span class="mention">@$1</span>');
  out = out.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@role</span>');
  out = out.replace(/&lt;t:(\d+):?([a-zA-Z])?&gt;/g, '<span class="timestamp">a moment ago</span>');
  out = out.replace(/-# (.+)/g, '<span class="muted">$1</span>');
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
