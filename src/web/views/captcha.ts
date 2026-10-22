// the landing page's challenge. every provider ships its own widget script and
// writes its token into a hidden input inside the enclosing form, so the page
// needs no submission script of its own: the form posts to the same route and
// the server checks the token before it starts the oauth flow.
//
// the widget is the only third party a page ever loads, and the policy only
// allows it when an operator configured one (captchaSources). a page for an
// install with no captcha keeps default-src 'none' and no form at all.

import type { CaptchaConfig } from "../../services/verify/captcha.ts";
import type { CspSources } from "../capture/fingerprint-script.ts";
import { escapeHtml } from "./pages.ts";

export interface CaptchaWidget {
  /** the provider's own script. the only third party script a page loads. */
  readonly scriptSrc: string;
  /** the element that script turns into a challenge. */
  readonly markup: string;
}

/** the challenge, or null when the provider is none. */
export function captchaWidget(config: CaptchaConfig): CaptchaWidget | null {
  switch (config.provider) {
    case "none":
      return null;
    case "turnstile":
      return {
        scriptSrc: "https://challenges.cloudflare.com/turnstile/v0/api.js",
        markup: `<div class="cf-turnstile" data-sitekey="${escapeHtml(config.siteKey)}"></div>`,
      };
    case "recaptcha":
      return {
        scriptSrc: "https://www.google.com/recaptcha/api.js",
        markup: `<div class="g-recaptcha" data-sitekey="${escapeHtml(config.siteKey)}"></div>`,
      };
    case "cap":
      // cap is self hosted: the widget comes from the instance, not a cdn.
      return {
        scriptSrc: `${escapeHtml(config.baseUrl)}/assets/widget.js`,
        markup: `<cap-widget data-cap-api-endpoint="${escapeHtml(`${config.baseUrl}/${config.siteKey}/`)}"></cap-widget>`,
      };
  }
}

/** the origins the widget loads and calls, for the response policy. */
export function captchaSources(config: CaptchaConfig): CspSources {
  switch (config.provider) {
    case "none":
      return {};
    case "turnstile":
      return {
        script: ["https://challenges.cloudflare.com"],
        frame: ["https://challenges.cloudflare.com"],
        connect: ["https://challenges.cloudflare.com"],
        form: true,
      };
    case "recaptcha":
      return {
        script: ["https://www.google.com", "https://www.gstatic.com"],
        frame: ["https://www.google.com", "https://recaptcha.google.com"],
        connect: ["https://www.google.com"],
        form: true,
      };
    case "cap":
      // the widget is a wasm module, which the policy names explicitly.
      return {
        script: ["'wasm-unsafe-eval'", config.baseUrl],
        connect: [config.baseUrl],
        form: true,
      };
  }
}
