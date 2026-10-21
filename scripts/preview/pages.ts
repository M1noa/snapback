// scripts/preview/pages.ts
//
// the website's pages, built with the real builders and invented data. the
// admin surfaces are not here on purpose: this is the whole website — the
// landing, the no-server landing, and the two results. setup and the commands
// happen in discord.

import { fingerprintScript } from "../../src/web/capture/fingerprint-script.ts";
import { homePage, resultPage } from "../../src/web/views/pages.ts";

export interface PreviewPage {
  readonly title: string;
  readonly path: string;
  /** heading the index groups by. */
  readonly surface: string;
  readonly html: string;
}

const GUILD = { id: "123", name: "nightly" };

export function buildPages(): PreviewPage[] {
  const home = homePage({
    guildId: GUILD.id,
    guildName: GUILD.name,
    guildIconUrl: null,
    verifyUrl: `/?guild=${GUILD.id}&start=1`,
  }).replace("</body>", `${fingerprintScript()}</body>`);

  const homeNoGuild = homePage({
    guildId: null,
    guildName: null,
    guildIconUrl: null,
    verifyUrl: null,
  });

  const verified = resultPage({
    ok: true,
    guildName: GUILD.name,
    detail: "You can close this page now.",
  });

  const failed = resultPage({
    ok: false,
    guildName: null,
    detail:
      "We could not complete the verification. The link may have expired, so start again from the server's verification link.",
  });

  return [
    { title: "landing, with a server", path: "/landing", surface: "verification", html: home },
    {
      title: "landing, without a server",
      path: "/no-guild",
      surface: "verification",
      html: homeNoGuild,
    },
    { title: "verified", path: "/result-verified", surface: "results", html: verified },
    { title: "did not finish", path: "/result-failed", surface: "results", html: failed },
  ];
}
