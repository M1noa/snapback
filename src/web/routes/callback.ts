// the callback route (D4PLAN 13.1, 13.3, 14.4). it exchanges the code, captures
// the ip and the fingerprint, decides whether the verification is allowed, and
// shows the result.
//
// every failure gives the person a plain sentence and gives the operator the
// parsed discord error in the log. nothing here invents a reason.
//
// a refusal is not a failure: the verification is written with its reason, the
// token is handed back, and the page says what happened without naming the
// account it was compared against.

import type { Database } from "../../db/types.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import type { Logger } from "../../lib/log.ts";
import { type AltSignals, emailDigest } from "../../services/verify/alt.ts";
import type { GuardDecision, GuardInput } from "../../services/verify/guard.ts";
import type { RoleGrantResult } from "../../services/verify/role.ts";
import type { TokenStore } from "../../services/verify/token-store.ts";
import { deviceDigest, readFingerprint } from "../capture/fingerprint.ts";
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
    username: string;
    globalName: string | null;
    discriminator: string | null;
    avatarUrl: string | null;
    avatarHash: string | null;
    email: string | null;
    flags: number | null;
    premiumType: number | null;
    mfaEnabled: boolean | null;
    locale: string | null;
    scopes: readonly string[];
    connections: readonly unknown[];
    guilds: readonly unknown[];
  } | null>;
  /** the policy: the network rule and the anti-alt rule. */
  readonly guard: (input: GuardInput) => Promise<GuardDecision>;
  /** grant the verified role. from services/verify/role.ts, wrapped by boot so
   *  the guild's own setting is read there. */
  readonly grant: (input: { guildId: string | null; userId: string }) => Promise<RoleGrantResult>;
  /** the token store. a refused verification gives its token back. */
  readonly tokens: TokenStore;
  /** write the record. from services/verify/records.ts. */
  readonly record: (input: {
    userId: string;
    guildId: string | null;
    ip: CapturedIp;
    fingerprint: unknown;
    username: string;
    globalName: string | null;
    discriminator: string | null;
    avatarUrl: string | null;
    email: string | null;
    flags: number | null;
    premiumType: number | null;
    mfaEnabled: boolean | null;
    locale: string | null;
    scopes: readonly string[];
    connections: readonly unknown[];
    guilds: readonly unknown[];
    intel: GuardDecision["intel"];
    status: "verified" | "refused";
    refusalReason: string | null;
    alt: GuardDecision["alt"];
    device: string | null;
    signals: AltSignals | null;
  }) => Promise<void>;
}

/** the one sentence a failed callback shows. it names the fix, not the cause. */
const FAILED_DETAIL =
  "We could not complete the verification. The link may have expired, so start again from the server's verification link.";

/** the sentence a refusal shows. it says what happened and what to do, and it
 *  does not say which account it was compared against. */
const REFUSED_DETAIL =
  "This verification was not completed. The network it came from looks like a VPN or a hosting provider, so it was refused. Try again from an ordinary connection.";

const REFUSED_ALT_DETAIL =
  "This verification was not completed. It matches another account on this server too closely, so it was refused. If this is you, ask the server's admins.";

/** the success sentences. the role is the one thing the person is waiting for,
 *  so the page says what happened to it. */
const GRANTED_DETAIL = "The verification is complete and the role is on your account.";

const GRANT_FAILED_DETAIL =
  "The verification is complete, but the role could not be added. Ask a server admin to add it for you.";

const DONE_DETAIL = "Nothing is left to do here.";

export function callbackRoute(deps: CallbackDeps) {
  return async (ctx: RequestContext): Promise<WebResponse> => {
    const code = ctx.query.get("code");
    const state = ctx.query.get("state");
    if (code === null || state === null) {
      return failed(FAILED_DETAIL);
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
      return failed(FAILED_DETAIL);
    }

    if (exchanged === null) {
      return failed(FAILED_DETAIL);
    }

    const fingerprint = readFingerprint(fingerprintFrom(ctx.headers.get("cookie")));
    const device = deviceDigest(fingerprint);
    const signals: AltSignals = {
      device,
      // the encrypted mode writes a fresh ciphertext every time, so it never
      // repeats and cannot be compared between two verifications.
      ip: ip.mode === "encrypted" ? null : ip.stored,
      email: emailDigest(exchanged.email),
      avatar: exchanged.avatarHash,
      name: exchanged.username.toLowerCase(),
    };

    const decision = await deps.guard({
      guildId: exchanged.guildId ?? "",
      userId: exchanged.userId,
      address: ip.address,
      signals,
    });

    if (!decision.allowed) {
      // the exchange stored the token before the guard ran, so a refused
      // verification hands it back. an account that was refused holds nothing.
      await deps.tokens.remove(exchanged.userId, "refused");
    }

    try {
      await deps.record({
        userId: exchanged.userId,
        guildId: exchanged.guildId,
        ip,
        fingerprint,
        username: exchanged.username,
        globalName: exchanged.globalName,
        discriminator: exchanged.discriminator,
        avatarUrl: exchanged.avatarUrl,
        email: exchanged.email,
        flags: exchanged.flags,
        premiumType: exchanged.premiumType,
        mfaEnabled: exchanged.mfaEnabled,
        locale: exchanged.locale,
        scopes: exchanged.scopes,
        connections: exchanged.connections,
        guilds: exchanged.guilds,
        intel: decision.intel,
        status: decision.allowed ? "verified" : "refused",
        refusalReason: decision.reason,
        alt: decision.alt,
        device,
        signals: decision.keepSignals ? signals : null,
      });
    } catch (error) {
      deps.log.error("writing the verify record threw", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (!decision.allowed) {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: resultPage({
          ok: false,
          guildName: exchanged.guildName,
          detail: decision.reason === "alt" ? REFUSED_ALT_DETAIL : REFUSED_DETAIL,
        }),
      };
    }

    // the record is written, so the role is the last thing. a grant that fails
    // never turns a completed verification into a failure: the page says what
    // happened, and the operator gets discord's words in the log.
    let granted: RoleGrantResult = { outcome: "skipped", said: null };
    try {
      granted = await deps.grant({ guildId: exchanged.guildId, userId: exchanged.userId });
    } catch (error) {
      deps.log.error("granting the verified role threw", {
        message: error instanceof Error ? error.message : String(error),
      });
      granted = { outcome: "failed", said: error instanceof Error ? error.message : String(error) };
    }

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: resultPage({
        ok: true,
        guildName: exchanged.guildName,
        detail: successDetail(granted),
      }),
    };
  };
}

function successDetail(granted: RoleGrantResult): string {
  if (granted.outcome === "granted") return GRANTED_DETAIL;
  if (granted.outcome === "failed") return GRANT_FAILED_DETAIL;
  return DONE_DETAIL;
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

function failed(detail: string): WebResponse {
  return {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: resultPage({
      ok: false,
      guildName: null,
      detail,
    }),
  };
}
