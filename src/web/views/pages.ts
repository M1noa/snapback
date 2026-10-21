// the pages the web layer renders. server-rendered html, one file per page, and
// nothing in them that a person did not ask for: no trackers, no third-party
// scripts, and no embedded scripts beyond the fingerprint the plan names.
//
// every page is one centred column: a wordmark, the seal, a small label, the
// display line, one sentence, one control. the palette is a random pastel
// chosen here, on the server, so the same page looks different each load
// without shipping a line of javascript.

import { hueStyle, pastelHue, THEME_CSS, themeColor } from "./theme.ts";

export interface PageInput {
  readonly title: string;
  readonly body: string;
}

const MARK_SVG = `<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><rect width="18" height="18" rx="5" fill="var(--accent)"/><path d="M5 9.4 7.9 12.3 13 7.1" fill="none" stroke="var(--on-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ARROW_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="m12.5 5.5 6.5 6.5-6.5 6.5"/></svg>`;

const CHECK = `<path d="M5.2 12.6 9.6 17 18.8 6.6" pathLength="1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;

const CROSS = `<path d="M7 7 17 17M17 7 7 17" pathLength="1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`;

/** what the seal holds when it has neither an icon nor a name: a server, drawn
 *  plainly, claiming nothing about its state. */
const SERVER_GLYPH = `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="6" rx="2.5"/><rect x="3" y="14" width="18" height="6" rx="2.5"/><path d="M6.8 7h.01M6.8 17h.01"/></svg>`;

/** the shell every page renders through. the hue is picked per response. */
export function page(input: PageInput): string {
  const hue = pastelHue();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="${themeColor(hue)}">
<title>${escapeHtml(input.title)}</title>
<style>${THEME_CSS}${hueStyle(hue)}</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<div class="shell">
<header class="bar"><span class="mark">${MARK_SVG}<span class="word">snapback</span></span></header>
<main>
${input.body}
</main>
<footer class="foot">
<span>no trackers</span><span class="dot" aria-hidden="true">·</span><span>no third-party scripts</span>
</footer>
</div>
</body>
</html>`;
}

/** the seal: two rings, the server inside, and the state on the badge.
 *  `draw` makes the badge mark stroke itself on instead of appearing. */
function seal(input: {
  readonly name: string | null;
  readonly iconUrl: string | null;
  readonly state: "pending" | "ok" | "failed" | "empty";
  readonly draw?: boolean;
}): string {
  const classes = ["seal", "rise"];
  if (input.state === "ok") classes.push("is-done");
  if (input.state === "failed") classes.push("is-failed");
  if (input.state === "empty") classes.push("is-empty");

  const face =
    input.iconUrl !== null
      ? `<img src="${escapeHtml(input.iconUrl)}" alt="" width="160" height="160">`
      : input.name === null
        ? SERVER_GLYPH
        : `<span class="initial">${escapeHtml(initialOf(input.name))}</span>`;

  const mark = stateMark(input.state, input.draw === true);

  return `<div class="${classes.join(" ")}" style="--i:0">
<svg class="rings" viewBox="0 0 100 100" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke">
<circle cx="50" cy="50" r="49.4" opacity="0.55"${input.state === "empty" ? ' stroke-dasharray="0.6 3.4" stroke-linecap="round"' : ""}/>
<circle cx="50" cy="50" r="45" stroke-dasharray="0.6 3.4" stroke-linecap="round" opacity="0.9"/>
</svg>
<div class="face">${face}</div>
${mark === "" ? "" : `<div class="badge">${mark}</div>`}
</div>`;
}

/** the mark on the badge. pending and empty draw nothing, ok and failed stroke
 *  themselves on when the page asks for it. */
function stateMark(state: "pending" | "ok" | "failed" | "empty", draw: boolean): string {
  if (state === "empty") return "";
  const glyph = state === "failed" ? CROSS : CHECK;
  const className = draw && state !== "pending" ? ' class="draw"' : "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${className}>${glyph}</svg>`;
}

/** the one letter a seal falls back to when it has no icon. */
function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}

/** the landing page. with a server it names it and offers the button; without
 *  one it says nothing about a server at all. the page does not describe what
 *  happens behind the flow: the consent screen speaks for itself. */
export interface HomePageInput {
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly guildIconUrl: string | null;
  readonly verifyUrl: string | null;
}

export function homePage(input: HomePageInput): string {
  if (input.guildId === null || input.guildId === "") {
    return page({
      title: "snapback verification",
      body: `${seal({ name: null, iconUrl: null, state: "empty" })}
<p class="eyebrow rise" style="--i:1">verification</p>
<h1 class="rise" style="--i:2">This link has no server</h1>
<p class="lede rise" style="--i:3">A verification link carries its server with it, and this one does not. Ask the server's bot for a fresh one.</p>`,
    });
  }

  const name = input.guildName ?? input.guildId;
  const button =
    input.verifyUrl === null
      ? ""
      : `<a class="button" href="${escapeHtml(input.verifyUrl)}">Continue with Discord${ARROW_SVG}</a>
<p class="fine">Opens discord.com. Close the tab when it is finished.</p>`;

  return page({
    title: `verify for ${name} · snapback`,
    body: `${seal({ name: input.guildName, iconUrl: input.guildIconUrl, state: "pending" })}
<p class="eyebrow rise" style="--i:1">verify for</p>
<h1 class="rise" style="--i:2">${escapeHtml(name)}</h1>
<p class="lede rise" style="--i:3">Approve it on Discord's own screen and you are done. There is nothing to install.</p>
<div class="rise" style="--i:4">${button}</div>`,
  });
}

/** the result page after a verification. */
export interface ResultPageInput {
  readonly ok: boolean;
  readonly guildName: string | null;
  readonly detail: string;
  /** the word the status line carries. defaults to verified / not verified. */
  readonly statusWord?: string;
}

export function resultPage(input: ResultPageInput): string {
  const word = input.statusWord ?? (input.ok ? "verified" : "not verified");
  // a name fits the display face; a sentence does not, so a failure title is
  // set in the text face instead.
  const name = input.ok ? input.guildName : null;
  const heading = name ?? (input.ok ? "You are verified" : "Verification did not finish");
  const title = input.ok && input.guildName !== null ? `${word} · ${input.guildName}` : word;

  return page({
    title,
    body: `${seal({
      name: input.guildName,
      iconUrl: null,
      state: input.ok ? "ok" : "failed",
      draw: true,
    })}
<p class="status ${input.ok ? "is-ok" : "is-err"} rise" style="--i:1">${escapeHtml(word)}</p>
<h1 class="rise" style="--i:2">${escapeHtml(heading)}</h1>
<p class="lede rise" style="--i:3">${escapeHtml(input.detail)}</p>`,
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
