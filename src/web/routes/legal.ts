// the disclosure route (D4PLAN 13.1). the same text the wizard's privacy step
// writes, so the two cannot drift apart.

import type { RequestContext, WebResponse } from "../router.ts";
import { legalPage } from "../views/pages.ts";

export interface LegalDeps {
  /** the disclosure text, from the operator's settings. */
  readonly disclosure: () => string;
}

export function legalRoute(deps: LegalDeps) {
  return (_ctx: RequestContext): WebResponse => {
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: legalPage({ disclosure: deps.disclosure() }),
    };
  };
}
