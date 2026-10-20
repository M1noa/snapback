// the pages the web layer renders. server-rendered html, one file per page, and
// nothing in them that a person did not ask for: no trackers, no third-party
// requests, no webfonts, and no embedded scripts beyond the fingerprint the
// plan names.
//
// tokens first (hallmark): dark slate paper close to discord's own dark, a
// mono display and a sans body, and one accent, spent only on the verify
// button. no colour that is not a token below.

export interface PageInput {
  readonly title: string;
  readonly body: string;
  /** the guild the page is about, when there is one. */
  readonly guildName?: string | null;
  readonly guildIconUrl?: string | null;
  /** the header's two links. defaults point at the disclosure and revoke pages. */
  readonly disclosureHref?: string;
  readonly revokeHref?: string;
}

/** the shell's header links. a page can point them somewhere else, but the
 *  default is disclosure then revoke. */
const DEFAULT_HREFS: { disclosureHref: string; revokeHref: string } = {
  disclosureHref: "/legal",
  revokeHref: "/revoke",
};
export function page(input: PageInput): string {
  const hrefs = { ...DEFAULT_HREFS, ...input };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)}</title>
<style>
/* hallmark · macrostructure: long document · genre: atmospheric, technical ·
   theme: snapback slate (paper 0.185 / display mono / accent blurple 277) */
:root {
  color-scheme: dark;
  --paper: oklch(0.185 0.014 265);
  --surface: oklch(0.225 0.016 265);
  --rule: oklch(0.33 0.018 265);
  --ink: oklch(0.94 0.008 262);
  --muted: oklch(0.7 0.012 258);
  --faint: oklch(0.56 0.012 258);
  --accent: oklch(0.55 0.2 277);
  --accent-hover: oklch(0.6 0.2 277);
  --accent-wash: oklch(0.3 0.05 277);
  --accent-ink: oklch(0.99 0.002 265);
  --ok: oklch(0.72 0.15 152);
  --err: oklch(0.68 0.18 20);
  --font-display: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --radius: 10px; --radius-sm: 6px; --radius-xs: 4px;
  --dur: 120ms; --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--paper); color: var(--ink); font: 400 1rem/1.55 var(--font-body); }
::selection { background: var(--accent); color: var(--accent-ink); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wrap { min-height: 100dvh; max-width: 44rem; margin: 0 auto; padding: var(--space-4) var(--space-4) var(--space-6); display: flex; flex-direction: column; }
.bar { display: flex; align-items: baseline; gap: var(--space-4); row-gap: var(--space-1); flex-wrap: wrap; padding: var(--space-3) 0 var(--space-4); }
.mark { display: inline-flex; align-items: center; gap: var(--space-2); font: 600 0.8rem/1 var(--font-display); letter-spacing: 0.14em; }
.mark::before { content: ""; width: 9px; height: 9px; background: var(--accent); }
.bar nav { margin-left: auto; display: flex; gap: var(--space-4); }
.bar nav a { color: var(--muted); font: 500 0.8rem/1.2 var(--font-display); text-decoration: none; }
.bar nav a:hover, .bar nav a:active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
main { flex: 1; padding-top: var(--space-5); }
.eyebrow { font: 500 0.72rem/1 var(--font-display); letter-spacing: 0.22em; color: var(--faint); margin: 0 0 var(--space-2); }
h1 { font: 500 clamp(1.45rem, 1.15rem + 1.6vw, 1.9rem)/1.2 var(--font-display); margin: 0 0 var(--space-4); overflow-wrap: anywhere; min-width: 0; }
h1.pad { text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 5px; }
.lede { color: var(--muted); margin: 0 0 var(--space-5); max-width: 40rem; }
.lede strong { color: var(--ink); }
.icon { width: 48px; height: 48px; border-radius: var(--radius-sm); border: 1px solid var(--rule); margin: 0 0 var(--space-4); }
.panel { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: var(--space-4) var(--space-5); margin: 0 0 var(--space-5); }
.fields { list-style: none; margin: 0; padding: 0; }
.fields li { display: grid; grid-template-columns: 6.5rem 1fr; gap: var(--space-4); padding: var(--space-3) 0; border-top: 1px solid var(--rule); font-size: 0.95rem; }
.fields li:first-child { border-top: 0; padding-top: 0; }
.fields b { font: 600 0.74rem/1.6 var(--font-display); letter-spacing: 0.1em; }
.fields span { color: var(--muted); min-width: 0; }
.fields code { font: 500 0.82em/1.4 var(--font-display); color: var(--ink); background: var(--accent-wash); padding: 0.05em 0.35em; border-radius: var(--radius-xs); }
.slate { background: var(--surface); border-left: 3px solid var(--rule); border-radius: 0 var(--radius) var(--radius) 0; padding: var(--space-4) var(--space-5); margin: 0 0 var(--space-5); }
.slate.ok { border-left-color: var(--ok); }
.slate.err { border-left-color: var(--err); }
.status { font: 600 0.76rem/1 var(--font-display); letter-spacing: 0.24em; margin: 0 0 var(--space-3); }
.status.ok { color: var(--ok); }
.status.err { color: var(--err); }
.slate p { margin: 0; }
.button { display: inline-block; padding: 0.9rem 1.4rem; background: var(--accent); color: var(--accent-ink); font: 600 0.95rem/1 var(--font-body); border-radius: var(--radius-sm); text-decoration: none; transition: background var(--dur) var(--ease); }
.button:hover { background: var(--accent-hover); }
.button:active { transform: translateY(1px); }
.links { display: flex; gap: var(--space-5); flex-wrap: wrap; margin: var(--space-5) 0 0; font-size: 0.9rem; }
.links a { color: var(--muted); text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 3px; }
.links a:hover { color: var(--ink); text-decoration-color: var(--muted); }
.prose { max-width: 40rem; }
.prose p { margin: 0 0 var(--space-4); font-size: 0.98rem; }
.prose p.lede { font-size: 1rem; }
.prose code { font: 500 0.85em/1.4 var(--font-display); color: var(--ink); background: var(--accent-wash); padding: 0.05em 0.35em; border-radius: var(--radius-xs); overflow-wrap: anywhere; }
.foot { border-top: 1px solid var(--rule); margin-top: var(--space-8); padding-top: var(--space-4); font: 400 0.72rem/1.6 var(--font-display); color: var(--faint); }
@media (max-width: 480px) { .fields li { grid-template-columns: 1fr; gap: var(--space-1); } }
@media (prefers-reduced-motion: reduce) { .button { transition: none; } }
</style>
</head>
<body>
<div class="wrap">
<header class="bar">
<span class="mark">snapback</span>
<nav><a href="${escapeHtml(hrefs.disclosureHref)}">what is captured</a><a href="${escapeHtml(hrefs.revokeHref)}">revoke</a></nav>
</header>
<main>
${input.body}
</main>
<footer class="foot">no third-party requests, no trackers. the browser details listed above are read on this page and stored only on the server that sent you here.</footer>
</div>
</body>
</html>`;
}

/** the landing page. with a guild it says whose server this is; without one it
 *  says nothing about a server at all. */
export interface HomePageInput {
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly guildIconUrl: string | null;
  readonly verifyUrl: string | null;
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}

export function homePage(input: HomePageInput): string {
  const shell = {
    disclosureHref: input.disclosureUrl,
    revokeHref: input.revokeUrl,
  };

  if (input.guildId === null || input.guildId === "") {
    return page({
      ...shell,
      title: "snapback verification",
      body: `<p class="eyebrow">verification</p>
<h1>this link has no server</h1>
<div class="panel"><p class="lede" style="margin:0">a verification link carries its server with it, and this one does not. ask the server's bot to generate a fresh one.</p></div>`,
    });
  }

  const name = input.guildName ?? input.guildId;
  const icon =
    input.guildIconUrl === null
      ? ""
      : `<img class="icon" src="${escapeHtml(input.guildIconUrl)}" alt="" width="48" height="48">`;
  const button =
    input.verifyUrl === null
      ? ""
      : `<p style="margin:0 0 var(--space-5)"><a class="button" href="${escapeHtml(input.verifyUrl)}">verify with discord</a></p>`;

  return page({
    ...shell,
    title: `verify with ${name} · snapback`,
    body: `<p class="eyebrow">verification</p>
<h1 class="pad">verify with ${escapeHtml(name)}</h1>
${icon}
<p class="lede">verification records you, on <strong>${escapeHtml(name)}</strong>, and only on that server. it is optional, it asks for nothing you have to pay for, and you can revoke it whenever you want.</p>
<div class="panel">
<ul class="fields">
<li><b>discord</b><span>the profile you approve. pressing verify opens discord's own consent screen first, which lists every permission the server asks for. nothing is written before it says yes.</span></li>
<li><b>connection</b><span>the address your browser connects from, hashed, and the country it resolves to.</span></li>
<li><b>browser</b><span>a fixed list of the browser's own details, read the moment this page opens, before you press anything. the list is on the disclosure page. it never reaches the server unless you finish.</span></li>
</ul>
</div>
${button}`,
  });
}

/** the result page after a verification or a revoke. */
export interface ResultPageInput {
  readonly ok: boolean;
  readonly guildName: string | null;
  readonly detail: string;
  /** the word the status line carries. defaults to verified / did not finish. */
  readonly statusWord?: string;
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}

export function resultPage(input: ResultPageInput): string {
  const word = input.statusWord ?? (input.ok ? "verified" : "did not finish");
  const title = input.guildName === null ? word : `${word} · ${input.guildName}`;
  const guild =
    input.guildName === null
      ? ""
      : `<p class="lede" style="margin-bottom:0"><strong>${escapeHtml(input.guildName)}</strong></p>`;
  return page({
    disclosureHref: input.disclosureUrl,
    revokeHref: input.revokeUrl,
    title,
    body: `<div class="slate ${input.ok ? "ok" : "err"}">
<p class="status ${input.ok ? "ok" : "err"}">${escapeHtml(word)}</p>
${guild}
<p>${escapeHtml(input.detail)}</p>
</div>
<div class="links"><a href="${escapeHtml(input.disclosureUrl)}">what is captured, and why</a> · <a href="${escapeHtml(input.revokeUrl)}">revoke your access</a></div>`,
  });
}

/** the disclosure page. the same text the wizard's privacy step writes, so the
 *  two cannot drift apart, plus the fixed fingerprint list so neither page can
 *  claim less than the build collects. */
export function legalPage(input: {
  readonly disclosure: string;
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
  readonly fingerprintFields: readonly string[];
}): string {
  const list = input.fingerprintFields.map((f) => `<code>${escapeHtml(f)}</code>`).join(" ");
  return page({
    disclosureHref: input.disclosureUrl,
    revokeHref: input.revokeUrl,
    title: "what is captured, and why",
    body: `<p class="eyebrow">disclosure</p>
<h1>what is captured, and why</h1>
<div class="prose">
${input.disclosure
  .split("\n")
  .map((line) => `<p>${escapeHtml(line)}</p>`)
  .join("\n")}
</div>
<div class="panel" style="margin-top:var(--space-6)">
<p class="eyebrow" style="margin-bottom:var(--space-3)">the fixed browser list</p>
<div style="line-height:2.4">${list}</div>
</div>`,
  });
}

/** the health page. json, not html: it is for a probe, not for a person. */
export function healthJson(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2);
}

/** html needs escaping. an unescaped value in a page is an injection. the
 *  ampersand goes first, or the later escapes would double the old ones. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
