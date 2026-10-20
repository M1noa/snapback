// scripts/preview/pages.ts
//
// the website's pages, built with the real builders and invented data. the
// admin surfaces are not here on purpose: verification, its results, and the
// disclosure are the whole website. setup and the commands happen in discord.

import { FINGERPRINT_FIELD_LABELS } from "../../src/web/capture/fingerprint.ts";
import { fingerprintScript } from "../../src/web/capture/fingerprint-script.ts";
import { disclosureSections } from "../../src/web/routes/legal.ts";
import { homePage, legalPage, resultPage } from "../../src/web/views/pages.ts";

export interface PreviewPage {
  readonly title: string;
  readonly path: string;
  /** heading the index groups by. */
  readonly surface: string;
  readonly html: string;
}

const GUILD = { id: "123", name: "nightly" };

const LEGAL_TEXT = disclosureSections(
  { scopes: ["identify", "email", "guilds.join"] },
  "verification is optional. the admins read the verified list; nothing else sees it.",
);

export function buildPages(): PreviewPage[] {
  const home = homePage({
    guildId: GUILD.id,
    guildName: GUILD.name,
    guildIconUrl: null,
    verifyUrl: `/?guild=${GUILD.id}&start=1`,
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  }).replace("</body>", `${fingerprintScript()}</body>`);

  const homeNoGuild = homePage({
    guildId: null,
    guildName: null,
    guildIconUrl: null,
    verifyUrl: null,
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  });

  const verified = resultPage({
    ok: true,
    guildName: GUILD.name,
    detail: "captured: identify, email, guilds.join. you can revoke this at any time.",
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  });

  const failed = resultPage({
    ok: false,
    guildName: null,
    detail:
      "we could not complete the verification, the link may have expired. try clicking verify again.",
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  });

  const revoked = resultPage({
    ok: true,
    guildName: null,
    detail: "your access has been revoked. you can verify again at any time.",
    statusWord: "revoked",
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  });

  const cannotRevoke = resultPage({
    ok: false,
    guildName: null,
    detail: "this link does not say whose access to revoke.",
    statusWord: "cannot revoke",
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  });

  const revokeFailed = resultPage({
    ok: false,
    guildName: null,
    detail: "something went wrong while revoking. try again in a moment.",
    statusWord: "revoke failed",
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
  });

  const legal = legalPage({
    disclosure: LEGAL_TEXT,
    disclosureUrl: "/legal",
    revokeUrl: "/revoke",
    fingerprintFields: FINGERPRINT_FIELD_LABELS,
  });

  return [
    { title: "landing, with a server", path: "/", surface: "verification", html: home },
    {
      title: "landing, without a server",
      path: "/no-guild",
      surface: "verification",
      html: homeNoGuild,
    },
    { title: "legal, the disclosure", path: "/legal", surface: "verification", html: legal },
    { title: "verified", path: "/result-verified", surface: "results", html: verified },
    { title: "did not finish", path: "/result-failed", surface: "results", html: failed },
    { title: "revoked", path: "/result-revoked", surface: "revoke", html: revoked },
    {
      title: "cannot revoke, the link is incomplete",
      path: "/result-cannot-revoke",
      surface: "revoke",
      html: cannotRevoke,
    },
    {
      title: "revoke failed",
      path: "/result-revoke-failed",
      surface: "revoke",
      html: revokeFailed,
    },
  ];
}
