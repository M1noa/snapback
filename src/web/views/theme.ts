// the site's design tokens and component css, in one string. the markup lives in
// pages.ts; this file is only what gives it a shape.
//
// two families: geist for text, geist mono for the wordmark and a status word,
// and nothing else. both are self-hosted from /assets/fonts, so the page still
// asks no third party for anything.
//
// the accent is spent on the primary button, the verification badge and the
// focus ring. nowhere else.

/** the two font faces. the fallback carries metric overrides so the swap to
 *  geist does not shift the lines under it. */
const FONT_FACES = `
@font-face {
  font-family: "Geist";
  src: url(/assets/fonts/geist-latin.woff2) format("woff2");
  font-weight: 300 700;
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
@font-face {
  font-family: "Geist Fallback";
  src: local("Helvetica Neue"), local("Arial");
  size-adjust: 100%;
  ascent-override: 92%;
  descent-override: 24%;
  line-gap-override: 0%;
}
`;

const TOKENS = `
:root {
  color-scheme: dark;

  --paper: oklch(0.155 0.010 274);
  --paper-2: oklch(0.195 0.012 274);
  --paper-3: oklch(0.235 0.014 274);
  --line: oklch(0.300 0.014 274);
  --line-2: oklch(0.245 0.012 274);
  --ring: oklch(0.345 0.018 274);

  --ink: oklch(0.975 0.003 274);
  --ink-2: oklch(0.800 0.010 274);
  --ink-3: oklch(0.660 0.012 274);
  --ink-dim: oklch(0.715 0.012 274);

  --accent: oklch(0.575 0.205 274);
  --accent-hi: oklch(0.645 0.195 274);
  --accent-lo: oklch(0.500 0.190 274);
  --on-accent: oklch(0.990 0 0);
  --ok: oklch(0.780 0.160 158);
  --err: oklch(0.700 0.170 22);

  --font-sans: "Geist", "Geist Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.25rem;
  --text-lg: 1.5625rem;
  --text-xl: 1.953rem;
  --display: clamp(2.75rem, 1.85rem + 3.9vw, 4.4rem);

  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-7: 32px; --sp-8: 40px;
  --sp-9: 48px; --sp-10: 64px; --sp-11: 80px; --sp-12: 96px;

  --r-1: 6px; --r-2: 10px; --r-3: 14px; --r-pill: 999px;

  --dur-1: 120ms; --dur-2: 220ms; --dur-3: 420ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
`;

const BASE = `
*, *::before, *::after { box-sizing: border-box; }
html { overflow-x: clip; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  overflow-x: clip;
  background: var(--paper);
  background-image: linear-gradient(180deg, oklch(0.178 0.013 274), oklch(0.143 0.009 274));
  background-attachment: fixed;
  color: var(--ink);
  font: 400 var(--text-base)/1.6 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(115% 70% at 50% -15%, oklch(0.575 0.205 274 / 0.07), transparent 62%);
}
::selection { background: var(--accent); color: var(--on-accent); }
a:focus-visible, button:focus-visible {
  outline: 2px solid var(--accent-hi);
  outline-offset: 3px;
  border-radius: var(--r-1);
}
`;

const SHELL = `
.shell {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 100dvh;
  width: min(100% - var(--sp-7) * 2, 62rem);
  margin-inline: auto;
}

.bar { padding-block: var(--sp-7) var(--sp-5); border-bottom: 1px solid oklch(0.235 0.012 274); }
.mark {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  font: 500 var(--text-sm)/1 var(--font-mono);
  letter-spacing: -0.01em;
  color: var(--ink);
}
.mark svg { display: block; flex: none; }

main {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-block: clamp(var(--sp-8), 8vh, var(--sp-12));
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr);
  align-items: center;
  gap: clamp(var(--sp-8), 6vw, var(--sp-12));
}

.column { min-width: 0; }
`;

const TEXT = `
h1 {
  margin: 0 0 var(--sp-4);
  font: 600 var(--display)/1.03 var(--font-sans);
  letter-spacing: -0.035em;
  color: var(--ink);
  overflow-wrap: anywhere;
  min-width: 0;
  text-wrap: balance;
}
.lede {
  margin: 0 0 var(--sp-7);
  max-width: 34ch;
  font-size: var(--text-md);
  line-height: 1.5;
  color: var(--ink-2);
  text-wrap: pretty;
}
.lede strong { font-weight: 550; color: var(--ink); }
h1 .quiet { font-weight: 500; color: var(--ink-dim); }
.fine {
  margin: var(--sp-5) 0 0;
  font-size: var(--text-sm);
  color: var(--ink-3);
}
.status {
  margin: 0 0 var(--sp-4);
  font: 500 var(--text-sm)/1 var(--font-mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.status.ok { color: var(--ok); }
.status.err { color: var(--err); }
`;

const CONTROLS = `
.button {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-5) var(--sp-7);
  border: 0;
  border-radius: var(--r-2);
  background: var(--accent);
  color: var(--on-accent);
  font: 550 1.0625rem/1 var(--font-sans);
  letter-spacing: -0.005em;
  text-decoration: none;
  box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.18), inset 0 -1px 0 oklch(0 0 0 / 0.10);
  transition: background-color var(--dur-1) var(--ease-out);
}
.button:hover { background: var(--accent-hi); }
.button:active { background: var(--accent-lo); }
.button svg { display: block; flex: none; opacity: 0.9; }
`;

const SEAL = `
.seal {
  position: relative;
  width: clamp(12rem, 26vw, 17rem);
  aspect-ratio: 1;
  margin-inline: auto;
}
.seal svg.rings {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  color: var(--ring);
  overflow: visible;
}
.seal .face {
  position: absolute;
  inset: 14%;
  container-type: size;
  display: grid;
  place-items: center;
  border-radius: var(--r-pill);
  background: radial-gradient(120% 120% at 50% 0%, oklch(0.265 0.042 274), oklch(0.195 0.020 274) 72%);
  border: 1px solid var(--line-2);
  overflow: hidden;
}
.seal .face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.seal .badge {
  position: absolute;
  right: 6%;
  bottom: 6%;
  display: grid;
  place-items: center;
  width: 24%;
  aspect-ratio: 1;
  border-radius: var(--r-pill);
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: 0 0 0 3px var(--paper);
}
.seal .badge svg { width: 52%; height: 52%; display: block; }
.seal .initial {
  font: 600 34cqmin/1 var(--font-sans);
  color: var(--ink-2);
  letter-spacing: -0.02em;
}
.seal .glyph { width: 34%; height: 34%; display: block; color: var(--ink-3); }
.seal.is-empty .face { border-style: dashed; border-color: var(--line); }
.seal.is-done { color: oklch(0.78 0.16 158 / 0.45); }
.seal.is-failed { color: oklch(0.70 0.17 22 / 0.45); }
.seal.is-done .badge { background: var(--ok); color: oklch(0.2 0.04 158); }
.seal.is-failed .badge { background: var(--err); color: oklch(0.16 0.03 22); }
`;

const SINGLE = `
.single {
  max-width: 34rem;
  margin-inline: auto;
  text-align: center;
}
.single .seal { width: clamp(10.5rem, 24vw, 14rem); margin-bottom: var(--sp-7); }
.single .status { margin-bottom: var(--sp-3); }
.single h1 { font-size: clamp(1.75rem, 1.3rem + 1.4vw, 2.25rem); margin-bottom: var(--sp-3); }
.single .lede { max-width: 36ch; margin-inline: auto; margin-bottom: 0; }
`;

const FOOT = `
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2) var(--sp-5);
  padding-block: var(--sp-5) var(--sp-7);
  border-top: 1px solid var(--line-2);
  font-size: var(--text-sm);
  color: var(--ink-3);
}
.foot span { min-width: 0; }
`;

const MOTION = `
.rise {
  opacity: 0;
  transform: translateY(8px);
  animation: rise var(--dur-3) var(--ease-out) forwards;
  animation-delay: calc(var(--i, 0) * 70ms);
}
@keyframes rise { to { opacity: 1; transform: none; } }

.draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw var(--dur-3) var(--ease-out) var(--dur-2) forwards;
}
@keyframes draw { to { stroke-dashoffset: 0; } }

@media (prefers-reduced-motion: reduce) {
  .rise, .draw {
    animation-duration: 150ms !important;
    animation-delay: 0ms !important;
  }
  .rise { transform: none; }
}
`;

const RESPONSIVE = `
@media (max-width: 60rem) {
  .split { grid-template-columns: minmax(0, 1fr); gap: var(--sp-8); }
  .split > .column:last-child { order: -1; }
  .lede { max-width: 46ch; }
}
@media (max-width: 30rem) {
  .shell { width: calc(100% - var(--sp-5) * 2); }
  .bar { padding-block: var(--sp-5) 0; }
  .foot { flex-direction: column; align-items: flex-start; }
}
`;

/** every stylesheet the site ships, in the order it has to load. */
export const THEME_CSS = `${FONT_FACES}${TOKENS}${BASE}${SHELL}${TEXT}${CONTROLS}${SEAL}${SINGLE}${FOOT}${MOTION}${RESPONSIVE}`;
