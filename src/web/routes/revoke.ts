// the revoke route (D4PLAN 13.1). a verified person takes their token back and,
// optionally, their record with it. a defensible consent model needs this.

import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import type { RequestContext, WebResponse } from "../router.ts";
import { resultPage } from "../views/pages.ts";

export interface RevokeDeps {
  readonly db: Database;
  readonly log: Logger;
  /** the token store: the token goes first, then the record. */
  readonly tokens: { remove(userId: string): Promise<void> };
  /** the record goes too, when the person asked for that. */
  readonly records: { remove(guildId: string, userId: string): Promise<void> };
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}

export function revokeRoute(deps: RevokeDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const userId = ctx.query.get("user");
    const guildId = ctx.query.get("guild");
    if (userId === null || userId === "") {
      return {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: resultPage({
          ok: false,
          guildName: null,
          detail: "this link does not say whose access to revoke.",
          disclosureUrl: deps.disclosureUrl,
          revokeUrl: deps.revokeUrl,
        }),
      };
    }

    try {
      await deps.tokens.remove(userId);
      // the record goes only when the person asked for it: the default is to
      // keep what was captured and drop the access.
      if (ctx.query.get("delete") === "1" && guildId !== null) {
        await deps.records.remove(guildId, userId);
      }
    } catch (error) {
      deps.log.error("revoke threw", {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: resultPage({
          ok: false,
          guildName: null,
          detail: "something went wrong while revoking. try again in a moment.",
          disclosureUrl: deps.disclosureUrl,
          revokeUrl: deps.revokeUrl,
        }),
      };
    }

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: resultPage({
        ok: true,
        guildName: null,
        detail: "your access has been revoked. you can verify again at any time.",
        disclosureUrl: deps.disclosureUrl,
        revokeUrl: deps.revokeUrl,
      }),
    };
  };
}
