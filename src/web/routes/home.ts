// the landing route (D4PLAN 13.1, 13.3). it shows the server's name (the
// operator's override, or the name the gateway keeps fresh) and a Verify button,
// and the button starts the OAuth flow: the state is minted here and the
// browser goes to discord.
//
// when a captcha is configured the button is a form and the challenge comes
// first: the widget posts its token back to this route, the token is checked
// against the provider, and only then is a state minted. a page with a
// challenge never redirects on a plain get, or the token would be optional.
//
// the fingerprint is collected by the same page and kept in a cookie, so the
// callback can read it without a second endpoint. the script touches nothing but
// the browser's own properties, and it makes no request to anyone. a page with
// no server attached runs no script at all: nothing is collected for nobody.

import { getGuild, getGuildSettings } from "../../db/queries/guilds.ts";
import type { Database } from "../../db/types.ts";
import {
  CAPTCHA_FIELDS,
  type CaptchaConfig,
  type CaptchaVerdict,
  verifyCaptcha,
} from "../../services/verify/captcha.ts";
import { fingerprintScript } from "../capture/fingerprint-script.ts";
import { displayName } from "../display-name.ts";
import type { RequestContext, WebResponse } from "../router.ts";
import { type CaptchaWidget, captchaWidget } from "../views/captcha.ts";
import { homePage } from "../views/pages.ts";

export interface HomeDeps {
  readonly db: Database;
  /** the challenge a person solves before the flow starts. */
  readonly captcha: CaptchaConfig;
  /** the authorize url for a guild, or null when the flow is not wired. */
  readonly authorizeUrl: (guildId: string) => Promise<string | null>;
}

/** what the provider said, in one line a person can act on. */
function refusalOf(verdict: CaptchaVerdict): string {
  if (verdict.unanswered) return "The challenge could not be checked. Try again in a moment.";
  if (verdict.codes.length > 0) return `The challenge was refused: ${verdict.codes.join(", ")}.`;
  return "The challenge was not solved. Complete it and continue.";
}

function toDiscord(url: string): WebResponse {
  return {
    status: 302,
    headers: { location: url, "cache-control": "no-store" },
    body: "",
  };
}

export function homeRoute(deps: HomeDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const guildId = ctx.query.get("guild");
    const named = guildId !== null && guildId !== "";
    let guildName: string | null = null;
    let guildIconUrl: string | null = null;
    if (named) {
      // the name the operator set, or the server's own name.
      const [row, settings] = await Promise.all([
        getGuild(deps.db, guildId),
        getGuildSettings(deps.db, guildId),
      ]);
      guildName = displayName(settings, row);
      guildIconUrl = row?.icon_url ?? null;
    }

    const widget = captchaWidget(deps.captcha);
    const start = ctx.query.get("start") === "1";
    let refusal: string | null = null;

    if (named && start) {
      if (widget === null) {
        const url = await deps.authorizeUrl(guildId);
        if (url !== null) return toDiscord(url);
      } else if (ctx.method === "POST") {
        // the challenge coming back: the token is the only thing that decides.
        const form = new URLSearchParams(await ctx.text());
        const token = form.get(CAPTCHA_FIELDS[deps.captcha.provider]) ?? "";
        const verdict = await verifyCaptcha(deps.captcha, token, ctx.remoteAddress);
        if (verdict.ok) {
          const url = await deps.authorizeUrl(guildId);
          if (url !== null) return toDiscord(url);
        } else {
          refusal = refusalOf(verdict);
        }
      }
    }

    const verifyUrl = named ? `${ctx.path}?guild=${encodeURIComponent(guildId)}&start=1` : null;

    // the script runs only when a server is attached: a page collecting
    // nothing collects nothing for nobody.
    const script = verifyUrl === null ? "" : fingerprintScript();

    return {
      // a refused challenge is a page, not a failure: the person can solve it
      // again on the same screen.
      status: refusal === null ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: homePage({
        guildId,
        guildName,
        guildIconUrl,
        verifyUrl,
        captcha: widget satisfies CaptchaWidget | null,
        captchaError: refusal,
      }).replace("</body>", `${script}</body>`),
    };
  };
}
