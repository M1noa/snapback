// the landing route (D4PLAN 13.1, 13.3). it shows the guild's name and a Verify
// button, and the button starts the OAuth flow: the state is minted here and the
// browser goes to discord.
//
// the fingerprint is collected by the same page and kept in a cookie, so the
// callback can read it without a second endpoint. the script touches nothing but
// the browser's own properties, and it makes no request to anyone.

import { getGuild } from "../../db/queries/guilds.ts";
import type { Database } from "../../db/types.ts";
import type { RequestContext, WebResponse } from "../router.ts";
import { homePage } from "../views/pages.ts";

export interface HomeDeps {
  readonly db: Database;
  /** the authorize url for a guild, or null when the flow is not wired. */
  readonly authorizeUrl: (guildId: string) => Promise<string | null>;
  /** the disclosure text's url. */
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}

// the fingerprint the browser sends. it is read out of a cookie on the callback,
// and it is a set of the browser's own properties: no request leaves the page.
const FINGERPRINT_SCRIPT = `<script>
(function () {
  try {
    var payload = {
      ua: navigator.userAgent,
      lang: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: screen.width + "x" + screen.height,
      colorDepth: screen.colorDepth,
      viewport: innerWidth + "x" + innerHeight,
      touch: "ontouchstart" in window,
      platform: navigator.platform,
      cookies: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      fonts: 0
    };
    document.cookie = "x-track=" + encodeURIComponent(JSON.stringify(payload)) + "; path=/; max-age=900; SameSite=Lax";
  } catch (e) { /* a browser that says no gets no fingerprint. */ }
})();
</script>`;

export function homeRoute(deps: HomeDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const guildId = ctx.query.get("guild");
    let guildName: string | null = null;
    let guildIconUrl: string | null = null;
    if (guildId !== null && guildId !== "") {
      const row = await getGuild(deps.db, guildId);
      guildName = row?.name ?? null;
      guildIconUrl = row?.icon_url ?? null;
    }

    // the button's target: the same page with the marker that starts the flow.
    const start = ctx.query.get("start") === "1";
    if (start && guildId !== null && guildId !== "") {
      const url = await deps.authorizeUrl(guildId);
      if (url !== null) {
        return {
          status: 302,
          headers: { location: url, "cache-control": "no-store" },
          body: "",
        };
      }
    }

    const verifyUrl =
      guildId === null || guildId === ""
        ? null
        : `${ctx.path}?guild=${encodeURIComponent(guildId)}&start=1`;

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: homePage({
        guildId,
        guildName,
        guildIconUrl,
        verifyUrl,
        disclosureUrl: deps.disclosureUrl,
        revokeUrl: deps.revokeUrl,
      }).replace("</body>", `${FINGERPRINT_SCRIPT}</body>`),
    };
  };
}
