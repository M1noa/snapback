// the site's design tokens and component css, in one string. the markup lives in
// pages.ts; this file is only what gives it a shape.
//
// the whole palette comes from one random hue, worked the way the crypto site
// does it: pick a pastel, then derive every surface, border and shadow from it
// at stepped alphas. one hue per page load, chosen on the server, so there is
// no script and nothing to hash into the csp.
//
// two faces: sora for text, geist mono for the tracked labels and status
// words. all self-hosted from /assets/fonts.

import { CLOSE_SECONDS } from "./countdown.ts";

/** hue used when nothing overrides it. a blue-violet, calm, not discord's. */
export const DEFAULT_HUE = 286;

/** a pastel hue for this response. any hue reads at this lightness, so there is
 *  no band to exclude. floored and wrapped so the value is always css-safe. */
export function pastelHue(): number {
  return Math.floor(Math.random() * 360);
}

/** the override a page carries so its palette is its own. */
export function hueStyle(hue: number): string {
  return `:root{--h:${Math.round(Math.abs(hue)) % 360}}`;
}

/** the browser's own chrome, tinted with the same pastel. hsl, because a
 *  theme-color is read by things that are not always css-color-4 aware. */
export function themeColor(hue: number): string {
  return `hsl(${Math.round(Math.abs(hue)) % 360} 46% 82%)`;
}

/** the two faces. sora sets everything that is read; geist mono carries the
 *  small tracked labels. */
const FONT_FACES = `
@font-face {
  font-family: "Sora";
  src: url(/assets/fonts/sora-latin.woff2) format("woff2");
  font-weight: 300 800;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono";
  src: url(/assets/fonts/geist-mono-latin.woff2) format("woff2");
  font-weight: 400 600;
  font-style: normal;
  font-display: swap;
}
`;

/** every colour is the hue at some lightness and alpha. nothing here is a
 *  literal, so changing --h changes the whole page. */
const TOKENS = `
:root {
  color-scheme: dark;
  --h: ${DEFAULT_HUE};

  --paper: oklch(0.128 0.014 var(--h));
  --paper-2: oklch(0.166 0.018 var(--h));
  --line: oklch(0.86 0.105 var(--h) / 0.14);
  --line-2: oklch(0.86 0.105 var(--h) / 0.22);

  --ink: oklch(0.945 0.032 var(--h));
  --ink-2: oklch(0.805 0.042 var(--h));
  --ink-3: oklch(0.660 0.042 var(--h));

  --accent: oklch(0.855 0.108 var(--h));
  --accent-hi: oklch(0.905 0.092 var(--h));
  --accent-lo: oklch(0.790 0.112 var(--h));
  --on-accent: oklch(0.175 0.030 var(--h));

  --border: oklch(0.86 0.105 var(--h) / 0.16);
  --border-hi: oklch(0.86 0.105 var(--h) / 0.36);

  --ok: oklch(0.840 0.150 158);
  --err: oklch(0.760 0.160 22);

  --font-sans: "Sora", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.0625rem;
  --display: clamp(2.05rem, 1.45rem + 2.9vw, 3.05rem);

  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-7: 32px; --sp-8: 40px;
  --sp-9: 48px; --sp-10: 64px; --sp-11: 80px; --sp-12: 96px;
  --r-pill: 999px;

  /* the spring set, lifted from the crypto site. no raw ease anywhere. */
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-snappy: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-polish: cubic-bezier(0.22, 1, 0.36, 1);

  --dur-1: 120ms; --dur-2: 220ms; --dur-3: 420ms;
  --ease-out: var(--ease-out-expo);
}
`;

const BASE = `
*, *::before, *::after { box-sizing: border-box; }
html {
  overflow-x: clip;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: oklch(0.86 0.105 var(--h) / 0.10);
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
body {
  margin: 0;
  overflow-x: clip;
  background-color: var(--paper);
  background-image:
    radial-gradient(120% 78% at 50% -12%, oklch(0.86 0.105 var(--h) / 0.11), transparent 62%),
    linear-gradient(180deg, var(--paper-2), var(--paper) 58%);
  background-attachment: fixed;
  color: var(--ink);
  font: 400 var(--text-base)/1.65 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  touch-action: manipulation;
}
::selection { background-color: var(--accent); color: var(--on-accent); }
::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background-color: var(--line-2);
  border-radius: 10px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background-color: var(--border-hi); }
a:focus-visible, button:focus-visible {
  outline: 2px solid var(--border-hi);
  outline-offset: 3px;
}
`;

/** the grain, exactly the way the crypto site runs it: a 400px tile repeated
 *  over a 200% box that keeps stepping to a new offset, so the field never
 *  settles. it paints over the page like film grain; clicks pass through. */
const GRAIN = `
.grain {
  position: fixed;
  inset: -50%;
  width: 200%;
  height: 200%;
  z-index: 3;
  pointer-events: none;
  background: transparent url(/assets/noise.png) repeat 0 0;
  opacity: 0.9;
  animation: grain 0.2s infinite;
}
@keyframes grain {
  0%   { transform: translate(0, 0) }
  10%  { transform: translate(-5%, -5%) }
  20%  { transform: translate(-10%, 5%) }
  30%  { transform: translate(5%, -10%) }
  40%  { transform: translate(-5%, 15%) }
  50%  { transform: translate(-10%, 5%) }
  60%  { transform: translate(15%, 0) }
  70%  { transform: translate(0, 10%) }
  80%  { transform: translate(-15%, 0) }
  90%  { transform: translate(10%, 5%) }
  100% { transform: translate(5%, 0) }
}
`;

const SHELL = `
.shell {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100dvh;
  width: 100%;
  padding-inline: var(--sp-6);
}
.foot {
  width: 100%;
  max-width: 34rem;
  display: flex;
  justify-content: center;
  padding-block: 0 var(--sp-6);
}
.gitlab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background-color: oklch(0.86 0.105 var(--h) / 0.06);
  color: var(--ink-3);
  text-decoration: none;
  transition:
    color var(--dur-2) var(--ease-snappy),
    border-color var(--dur-2) var(--ease-snappy),
    background-color var(--dur-2) var(--ease-snappy);
}
.gitlab:hover {
  color: var(--ink-2);
  border-color: var(--border-hi);
  background-color: oklch(0.86 0.105 var(--h) / 0.12);
}
.gitlab svg {
  display: block;
  flex: none;
  width: 1rem;
  height: 1rem;
  fill: currentColor;
  opacity: 0.9;
}

main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 34rem;
  padding-block: clamp(var(--sp-6), 6vh, var(--sp-10));
  text-align: center;
}
`;

const TEXT = `
.eyebrow {
  margin: 0 0 var(--sp-3);
  font: 500 var(--text-xs)/1 var(--font-mono);
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--ink-3);
}
h1 {
  margin: 0 0 var(--sp-4);
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: var(--display);
  line-height: 1.12;
  letter-spacing: -0.028em;
  color: var(--ink);
  overflow-wrap: anywhere;
  min-width: 0;
  text-wrap: balance;
}
.lede {
  margin: 0;
  max-width: 32ch;
  font-size: var(--text-md);
  line-height: 1.6;
  color: var(--ink-2);
  text-wrap: pretty;
}
.fine {
  margin: var(--sp-5) 0 0;
  font-size: var(--text-sm);
  color: var(--ink-3);
}
.status {
  margin: 0 0 var(--sp-3);
  font: 500 var(--text-xs)/1 var(--font-mono);
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.status.is-ok { color: var(--ok); }
.status.is-err { color: var(--err); }
`;

const CONTROLS = `
.button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-7);
  padding: 1rem 1.65rem;
  overflow: hidden;
  isolation: isolate;
  border: 1px solid oklch(1 0 0 / 0.18);
  border-radius: var(--r-pill);
  background: linear-gradient(180deg, var(--accent-hi), var(--accent));
  color: var(--on-accent);
  font: 600 var(--text-md)/1 var(--font-sans);
  letter-spacing: -0.005em;
  text-decoration: none;
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 0.45),
    inset 0 -1px 0 oklch(0 0 0 / 0.12),
    0 2px 0 oklch(0 0 0 / 0.28),
    0 14px 30px -12px oklch(0.86 0.105 var(--h) / 0.55);
  transition:
    background var(--dur-2) var(--ease-polish),
    border-color var(--dur-2) var(--ease-snappy),
    box-shadow var(--dur-2) var(--ease-polish);
}
.button::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: radial-gradient(ellipse 76% 62% at 50% -18%, oklch(1 0 0 / 0.42), transparent 72%);
  opacity: 0;
  transition: opacity var(--dur-3) var(--ease-out);
}
.button:hover {
  background: linear-gradient(180deg, oklch(0.93 0.075 var(--h)), var(--accent-hi));
  border-color: oklch(1 0 0 / 0.32);
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 0.5),
    inset 0 -1px 0 oklch(0 0 0 / 0.12),
    0 2px 0 oklch(0 0 0 / 0.28),
    0 18px 38px -12px oklch(0.86 0.105 var(--h) / 0.7);
}
.button:hover::before { opacity: 1; }
.button:active {
  background: linear-gradient(180deg, var(--accent), var(--accent-lo));
  border-color: oklch(1 0 0 / 0.14);
  box-shadow:
    inset 0 2px 4px oklch(0 0 0 / 0.18),
    0 1px 0 oklch(0 0 0 / 0.24),
    0 6px 16px -10px oklch(0.86 0.105 var(--h) / 0.5);
  transition:
    background var(--dur-1) var(--ease-snappy),
    box-shadow var(--dur-1) var(--ease-snappy);
}
.button:active::before { opacity: 0.4; }
.button svg { display: block; flex: none; opacity: 0.85; }
`;

const SEAL = `
.seal {
  position: relative;
  width: clamp(7.5rem, 22vw, 9.5rem);
  aspect-ratio: 1;
  margin: 0 auto var(--sp-6);
  color: var(--line-2);
}
.seal svg.rings {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  color: var(--border-hi);
}
.seal .face {
  position: absolute;
  inset: 13%;
  container-type: size;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: var(--r-pill);
  border: 1px solid var(--border);
  background: radial-gradient(120% 120% at 50% 0%, oklch(0.30 0.055 var(--h) / 0.85), oklch(0.17 0.03 var(--h) / 0.9) 74%);
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 0.14),
    inset 0 -8px 18px oklch(0 0 0 / 0.22),
    0 12px 30px oklch(0 0 0 / 0.4),
    0 0 0 5px oklch(0.86 0.105 var(--h) / 0.035);
}
.seal .face img { width: 100%; height: 100%; object-fit: cover; display: block; }
.seal .initial {
  font: 500 32cqmin/1 var(--font-sans);
  color: var(--ink);
  letter-spacing: -0.02em;
}
.seal .glyph { width: 32%; height: 32%; display: block; color: var(--ink-3); }
.seal .badge {
  position: absolute;
  right: 4%;
  bottom: 4%;
  display: grid;
  place-items: center;
  width: 26%;
  aspect-ratio: 1;
  border-radius: var(--r-pill);
  background: linear-gradient(180deg, var(--accent-hi), var(--accent));
  color: var(--on-accent);
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 0.45),
    0 0 0 3px var(--paper),
    0 6px 14px -6px oklch(0.86 0.105 var(--h) / 0.6);
}
.seal .badge svg { width: 54%; height: 54%; display: block; }
.seal.is-empty .face { border-style: dashed; border-color: var(--line); }
.seal.is-empty svg.rings { color: var(--line); }
.seal.is-done { color: oklch(0.84 0.15 158 / 0.4); }
.seal.is-failed { color: oklch(0.76 0.16 22 / 0.4); }
.seal.is-done svg.rings { color: oklch(0.84 0.15 158 / 0.5); }
.seal.is-failed svg.rings { color: oklch(0.76 0.16 22 / 0.5); }
.seal.is-done .badge { background: linear-gradient(180deg, oklch(0.88 0.14 158), var(--ok)); color: oklch(0.18 0.04 158); }
.seal.is-failed .badge { background: linear-gradient(180deg, oklch(0.80 0.15 22), var(--err)); color: oklch(0.16 0.03 22); }
`;

/** the close countdown: a bar that drains over the same six seconds the script
 *  counts, and the sentence under it. the bar is decoration, so a browser that
 *  cannot animate it drops it and keeps the words. */
const CLOSE = `
.close {
  width: 100%;
  max-width: 15rem;
  margin: var(--sp-7) auto 0;
}
.close .track {
  height: 2px;
  overflow: hidden;
  border-radius: var(--r-pill);
  background-color: var(--line-2);
}
.close .track .fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background-color: var(--ok);
  transform-origin: left center;
  animation: drain ${CLOSE_SECONDS}s linear forwards;
}
@keyframes drain { from { transform: scaleX(1) } to { transform: scaleX(0) } }
.close .note {
  margin: var(--sp-3) 0 0;
  font: 500 var(--text-xs)/1 var(--font-mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ok);
}
`;

const MOTION = `
.rise {
  opacity: 0;
  transform: translateY(14px) scale(0.985);
  animation: rise var(--dur-3) var(--ease-out-expo) forwards;
  animation-delay: calc(var(--i, 0) * 70ms);
}
@keyframes rise { to { opacity: 1; transform: none; } }

.draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw var(--dur-3) var(--ease-out-expo) var(--dur-2) forwards;
}
@keyframes draw { to { stroke-dashoffset: 0; } }

@media (prefers-reduced-motion: reduce) {
  .grain { animation: none; }
  .rise, .draw {
    animation-duration: 150ms !important;
    animation-delay: 0ms !important;
  }
  .rise { transform: none; }
  /* a bar that cannot drain honestly is not shown; the countdown words carry it. */
  .close .track { display: none; }
}
`;

const RESPONSIVE = `
@media (max-width: 30rem) {
  .shell { padding-inline: var(--sp-5); }
  .lede { font-size: var(--text-base); }
  .button { width: 100%; justify-content: center; }
}
`;

/** every stylesheet the site ships, in the order it has to load. the page's own
 *  hue override is appended after this, so it wins. */
export const THEME_CSS = `${FONT_FACES}${TOKENS}${BASE}${GRAIN}${SHELL}${TEXT}${CONTROLS}${SEAL}${CLOSE}${MOTION}${RESPONSIVE}`;
