// the health route (D4PLAN 13.1). json, for a probe and not for a person.
//
// the probe mode the wizard's tunnel check uses is the same route with a query
// parameter, so there is one answer to "is it up".

import type { Database } from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import type { RequestContext, WebResponse } from "../router.ts";
import { healthJson } from "../views/pages.ts";

export interface HealthDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly version: string;
  readonly startedAt: number;
  /** the gateway's state, as a short word. */
  readonly gateway: () => string;
  /** the jobs that are queued or running. */
  readonly queueDepth: () => number;
  /** the schema version the database is on. */
  readonly schemaVersion: number;
}

export function healthRoute(deps: HealthDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const probe = ctx.query.get("probe") === "1";
    let database = "unreachable";
    try {
      await deps.db.query("SELECT 1");
      database = "reachable";
    } catch {
      database = "unreachable";
    }

    const body: Record<string, unknown> = {
      version: deps.version,
      uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      database,
      schema_version: deps.schemaVersion,
      gateway: deps.gateway(),
      queue_depth: deps.queueDepth(),
    };

    // the probe mode answers with the smallest useful body: a tunnel check wants
    // "yes, it answered", not the whole report.
    if (probe) {
      body.status = database === "reachable" ? "ok" : "degraded";
    }

    return {
      status: database === "reachable" ? 200 : 503,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: healthJson(body),
    };
  };
}
