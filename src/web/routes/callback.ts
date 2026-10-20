// the callback route (D4PLAN 13.1, 13.3). it exchanges the code, captures the ip
// and the fingerprint, writes the record, and shows the result.
//
// every failure gives the person a plain sentence and gives the operator the
// parsed discord error in the log. nothing here invents a reason.

import type { Database } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";
import { readFingerprint } from "../capture/fingerprint.ts";
import { COOKIE_NAME } from "../capture/fingerprint-script.ts";
import { type CapturedIp, captureIp, type IpCaptureOptions } from "../capture/ip.ts";
import type { RequestContext, WebResponse } from "../router.ts";
import { resultPage } from "../views/pages.ts";

export interface CallbackDeps {
  readonly db: Database;
  readonly log: Logger;
  readonly ip: IpCaptureOptions;
  /** the code exchange, from services/verify/oauth.ts. */
  readonly exchange: (input: { code: string; state: string; clientIp: string | null }) => Promise<{
    userId: string;
    guildId: string | null;
    guildName: string | null;
    captured: string[];
    username: string;
    email: string | null;
    scopes: readonly string[];
    connections: readonly unknown[];
    guilds: readonly unknown[];
  } | null>;
  /** write the record. from services/verify/records.ts. */
  readonly record: (input: {
    userId: string;
    guildId: string | null;
    ip: CapturedIp;
    fingerprint: unknown;
    username: string;
    email: string | null;
    scopes: readonly string[];
    connections: readonly unknown[];
    guilds: readonly unknown[];
  }) => Promise<void>;
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}

export function callbackRoute(deps: CallbackDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const code = ctx.query.get("code");
    const state = ctx.query.get("state");
    if (code === null || state === null) {
      return failed(
        "we could not complete the verification, the link may have expired. try clicking Verify again.",
        deps,
      );
    }

    const ip = captureIp(ctx.headers, ctx.remoteAddress, deps.ip);

    let exchanged: Awaited<ReturnType<CallbackDeps["exchange"]>>;
    try {
      exchanged = await deps.exchange({ code, state, clientIp: ip.stored });
    } catch (error) {
      if (error instanceof DiscordApiError) {
        const report = formatDiscordError(error);
        deps.log.error("oauth exchange refused", {
          status: report.status,
          code: report.code,
          said: report.said,
          method: error.method,
          route: error.route,
        });
      } else {
        deps.log.error("oauth exchange threw", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return failed(
        "we could not complete the verification, the link may have expired. try clicking Verify again.",
        deps,
      );
    }

    if (exchanged === null) {
      return failed(
        "we could not complete the verification, the link may have expired. try clicking Verify again.",
        deps,
      );
    }

    try {
      await deps.record({
        userId: exchanged.userId,
        guildId: exchanged.guildId,
        ip,
        fingerprint: readFingerprint(fingerprintFrom(ctx.headers.get("cookie"))),
        username: exchanged.username,
        email: exchanged.email,
        scopes: exchanged.scopes,
        connections: exchanged.connections,
        guilds: exchanged.guilds,
      });
    } catch (error) {
      deps.log.error("writing the verify record threw", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: resultPage({
        ok: true,
        guildName: exchanged.guildName,
        detail: `captured: ${exchanged.captured.join(", ")}. you can revoke this at any time.`,
        disclosureUrl: deps.disclosureUrl,
        revokeUrl: deps.revokeUrl,
      }),
    };
  };
}

/** the fingerprint the landing page put in a cookie. */
function fingerprintFrom(cookie: string | null): unknown {
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE_NAME) continue;
    try {
      return JSON.parse(decodeURIComponent(rest.join("=")));
    } catch {
      return null;
    }
  }
  return null;
}

function failed(detail: string, deps: CallbackDeps): WebResponse {
  return {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: resultPage({
      ok: false,
      guildName: null,
      detail,
      disclosureUrl: deps.disclosureUrl,
      revokeUrl: deps.revokeUrl,
    }),
  };
}
