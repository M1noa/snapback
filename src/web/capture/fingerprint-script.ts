// the landing page's fingerprint script (D4PLAN 14.2). the browser's own
// properties, collected client-side, written to a short-lived cookie, and read
// back on the callback. the script makes no request to anyone.
//
// the script text and its hash live in one module because the server's content
// security policy allows this script by hash: editing the script changes the
// policy, and the policy cannot name a script that is not this one.

import { COUNTDOWN_SCRIPT_HASH } from "../views/countdown.ts";
import { OPENER_SCRIPT_HASH } from "../views/opener.ts";

/** the cookie the script writes and the callback reads back. */
export const COOKIE_NAME = "sb-fp";
const RAW_SCRIPT = `
(function () {
  try {
    var n = navigator, w = window, s = screen;
    var payload = {
      ua: n.userAgent,
      lang: n.language,
      languages: n.languages ? n.languages.join(",") : null,
      platform: n.platform,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffset: new Date().getTimezoneOffset(),
      screen: s.width + "x" + s.height,
      avail: s.availWidth + "x" + s.availHeight,
      colorDepth: s.colorDepth,
      viewport: w.innerWidth + "x" + w.innerHeight,
      dpr: w.devicePixelRatio,
      touch: "ontouchstart" in w || n.maxTouchPoints > 0,
      maxTouchPoints: n.maxTouchPoints,
      hwConcurrency: n.hardwareConcurrency,
      deviceMemory: n.deviceMemory,
      cookies: n.cookieEnabled,
      doNotTrack: n.doNotTrack,
      reducedMotion: w.matchMedia("(prefers-reduced-motion: reduce)").matches,
      colorScheme: w.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      connection: n.connection && n.connection.effectiveType ? n.connection.effectiveType : null,
      referrer: document.referrer || null,
      capturedAt: Date.now()
    };
    // the cookie is written before the device list finishes: a browser that
    // never answers the enumeration still gets the rest of its details in.
    var write = function () {
      try {
        document.cookie = "sb-fp=" + encodeURIComponent(JSON.stringify(payload)) +
          "; path=/; max-age=900; SameSite=Lax";
      } catch (e) { /* a browser that says no gets no fingerprint. */ }
    };
    write();
    try {
      if (n.mediaDevices && n.mediaDevices.enumerateDevices) {
        n.mediaDevices.enumerateDevices().then(function (d) {
          payload.audioDevices = d.length;
          write();
        }, function () { /* the answer never came; the first write stands. */ });
      }
    } catch (e) { /* no media devices, no count. */ }
  } catch (e) { /* a browser that says no gets no fingerprint. */ }
})();
`;

/** the script as a page would embed it. */
export function fingerprintScript(): string {
  return `<script>${RAW_SCRIPT}</script>`;
}

/** the sha256 the policy must allow the inline script by. */
const SCRIPT_HASH: string = new Bun.CryptoHasher("sha256").update(RAW_SCRIPT).digest("base64");

/** what a page needs from outside this origin, beyond the defaults. a captcha
 *  widget is the only thing that ever adds to it. */
export interface CspSources {
  readonly script?: readonly string[];
  readonly frame?: readonly string[];
  readonly connect?: readonly string[];
  /** the page posts a form back to itself. */
  readonly form?: boolean;
}

/** the policy every response carries. inline scripts are allowed by hash and
 *  never by 'unsafe-inline', so a script that appears without its hash is
 *  dropped by the browser; tests/web/csp.test.ts holds that line. images come
 *  from this origin (the grain tile) and discord's cdn (guild icons). */
export function webCsp(sources: CspSources = {}): string {
  const scripts = [
    `'sha256-${SCRIPT_HASH}'`,
    `'sha256-${COUNTDOWN_SCRIPT_HASH}'`,
    `'sha256-${OPENER_SCRIPT_HASH}'`,
  ]
    .concat(sources.script ?? [])
    .join(" ");
  const directives = [
    "default-src 'none'",
    "img-src 'self' https://cdn.discordapp.com",
    "font-src 'self'",
    "style-src 'unsafe-inline'",
    `script-src ${scripts}`,
    "object-src 'none'",
    "base-uri 'none'",
    sources.form === true ? "form-action 'self'" : "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  if (sources.frame !== undefined && sources.frame.length > 0) {
    directives.push(`frame-src ${sources.frame.join(" ")}`);
  }
  if (sources.connect !== undefined && sources.connect.length > 0) {
    directives.push(`connect-src ${sources.connect.join(" ")}`);
  }
  return directives.join("; ");
}

/** the policy a page with no third party on it gets. */
export const WEB_CSP: string = webCsp();
