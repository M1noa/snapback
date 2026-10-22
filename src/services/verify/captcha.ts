// the captcha gate (D4PLAN 13.3). the landing page asks the person to solve a
// challenge before the oauth flow starts, so a script that never renders a
// widget never gets a state.
//
// three providers, one call: hand it the token the widget wrote into the form
// and it answers yes, no, or could not ask. a verifier that cannot be reached
// is refused, because a captcha that fails open is not a captcha.
//
// the secret is read from the env, used in one request, and never logged. this
// is a challenge the person solves, never a solver (AGENTS.md rule 9).

import type { CaptchaProvider } from "../../config/parse-env.ts";

export interface CaptchaConfig {
  readonly provider: CaptchaProvider;
  readonly siteKey: string;
  readonly secret: string;
  readonly baseUrl: string;
}

/** the field the widget's own hidden input writes into the enclosing form. */
export const CAPTCHA_FIELDS: Readonly<Record<CaptchaProvider, string>> = {
  none: "",
  turnstile: "cf-turnstile-response",
  recaptcha: "g-recaptcha-response",
  cap: "cap-token",
};

const TIMEOUT_MS = 10_000;

export interface CaptchaVerdict {
  /** the token was accepted. nothing else counts as yes. */
  readonly ok: boolean;
  /** the provider's own error codes, verbatim. empty when it only said no. */
  readonly codes: readonly string[];
  /** no answer came back at all, so nothing was proven either way. */
  readonly unanswered: boolean;
}

/** where a provider checks a token. empty for none. */
export function captchaEndpoint(config: CaptchaConfig): string {
  switch (config.provider) {
    case "none":
      return "";
    case "turnstile":
      return "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    case "recaptcha":
      return "https://www.google.com/recaptcha/api/siteverify";
    case "cap":
      // cap serves the verifier under the site key it gave the operator.
      return `${config.baseUrl}/${encodeURIComponent(config.siteKey)}/siteverify`;
  }
}

/** the request body a provider documents: cap takes json, the other two a form. */
function requestFor(
  config: CaptchaConfig,
  token: string,
  remoteIp: string | null,
): { contentType: string; body: string } {
  if (config.provider === "cap") {
    return {
      contentType: "application/json",
      body: JSON.stringify({ secret: config.secret, response: token }),
    };
  }
  const form = new URLSearchParams({ secret: config.secret, response: token });
  if (remoteIp !== null) form.set("remoteip", remoteIp);
  return { contentType: "application/x-www-form-urlencoded", body: form.toString() };
}

/** check one token. an empty token never costs a request. */
export async function verifyCaptcha(
  config: CaptchaConfig,
  token: string,
  remoteIp: string | null,
  fetcher: typeof fetch = fetch,
): Promise<CaptchaVerdict> {
  if (config.provider === "none") return { ok: true, codes: [], unanswered: false };
  if (token === "") return { ok: false, codes: [], unanswered: false };

  const request = requestFor(config, token, remoteIp);
  let response: Response;
  try {
    response = await fetcher(captchaEndpoint(config), {
      method: "POST",
      headers: { "content-type": request.contentType },
      body: request.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // a timeout or a socket that never opened proves nothing about the person.
    return { ok: false, codes: [], unanswered: true };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload === null || typeof payload !== "object") {
    return { ok: false, codes: [], unanswered: true };
  }

  const record = payload as Record<string, unknown>;
  const raw = record["error-codes"];
  const codes = Array.isArray(raw)
    ? raw.filter((code): code is string => typeof code === "string")
    : [];
  return { ok: record.success === true, codes, unanswered: false };
}
