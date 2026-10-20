// the disclosure route (D4PLAN 13.1, 19.3). what is captured, why, and how to
// revoke it.
//
// the text is generated from the panel's own scope list, so it cannot drift from
// what the panel actually asks discord for. the operator's paragraph comes after
// it, and the two agree or the page says which scopes are asked for.

import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
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

export function legalRoute(deps: LegalDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const guildId = ctx.query.get("guild");
    const panel = guildId === null ? null : await deps.panel(guildId);

    const sections: string[] = [];
    if (panel !== null) {
      sections.push(
        `This server asks discord for: ${panel.scopes.join(", ") || "your account id"}.`,
      );
    }
    sections.push(
      "It also records the address your browser connects from, your browser and operating system, and your timezone, and uses them to check for VPNs and alternate accounts.",
    );
    sections.push(
      "It keeps this until you revoke access, or until the server's retention period ends.",
    );
    sections.push(
      "Pressing continue asks discord for permission. Nothing is captured before you approve.",
    );
    if (deps.operatorText !== "") {
      sections.push(deps.operatorText);
    }

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: legalPage({ disclosure: sections.join("\n") }),
    };
  };
}
