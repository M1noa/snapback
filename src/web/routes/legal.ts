// the disclosure route (D4PLAN 13.1, 13.3, 19.3). what is captured, why, and
// how to revoke it.
//
// the text is generated from the panel's own scope list, so it cannot drift from
// what the panel actually asks discord for. the operator's paragraph comes after
// it, and the two agree or the page says which scopes are asked for.

import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import { FINGERPRINT_FIELD_LABELS } from "../capture/fingerprint.ts";
import type { RequestContext, WebResponse } from "../router.ts";
import { legalPage } from "../views/pages.ts";

export interface LegalDeps {
  readonly db: Database;
  readonly log: Logger;
  /**
   * the panel of a guild, so the text can list the scopes that guild asks for.
   * null when the guild has no panel, or the request named no guild.
   */
  readonly panel: (guildId: string) => Promise<{ scopes: readonly string[] } | null>;
  /** what the operator wrote, which says why the server wants the verification. */
  readonly operatorText: string;
}

/** the disclosure sections. exported, because the whole point of this page is
 *  that the words it shows live in exactly one place. */
export function disclosureSections(
  panel: { scopes: readonly string[] } | null,
  operatorText: string,
): string {
  const sections: string[] = [];
  if (panel !== null) {
    sections.push(`This server asks discord for: ${panel.scopes.join(", ") || "your account id"}.`);
  }
  sections.push(
    "It also records the address your browser connects from, and a reading of the browser itself. The browser reading is the fixed list shown below; there is no canvas, WebGL, or font probe in this build, and none will be added without a change to the disclosure.",
  );
  sections.push(
    "The browser reading happens the moment the verification page opens, before you press anything, and it travels inside a short-lived cookie. If you do not finish verifying, that cookie dies within fifteen minutes and nothing about you reaches the server.",
  );
  sections.push(
    "After discord's consent screen says yes, the server writes the record: the address, the browser reading, and the discord profile above. They are kept to check for VPNs and alternate accounts.",
  );
  sections.push(
    "It keeps this until you revoke access, or until the server's retention period ends.",
  );
  if (operatorText !== "") {
    sections.push(operatorText);
  }
  return sections.join("\n");
}

export function legalRoute(deps: LegalDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const guildId = ctx.query.get("guild");
    const panel = guildId === null ? null : await deps.panel(guildId);

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: legalPage({
        disclosure: disclosureSections(panel, deps.operatorText),
        disclosureUrl: "/legal",
        revokeUrl: "/revoke",
        fingerprintFields: FINGERPRINT_FIELD_LABELS,
      }),
    };
  };
}
