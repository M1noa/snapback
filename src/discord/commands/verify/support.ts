// the shared parts of the /verify surface: the access check and the two record
// pages.

import type { VerifyRecordRow } from "../../../db/types.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { CommandContext, CommandResult } from "../types.ts";
import { VERIFY_ACTION, VERIFY_OBJECT, type VerifyDeps, verifyCustomId } from "./deps.ts";
import { type RecordFields, recordPage, recordsPage, type VerifyRecordSummary } from "./pages.ts";

/** how many records one page holds. */
export const RECORDS_PAGE_SIZE = 10;

/** null when the person may act, and the refusal page when they may not. */
export async function refusal(
  deps: VerifyDeps,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  if (await deps.authorize(ctx.userId, ctx.guildId)) return null;
  return {
    page: failurePage(
      "not your server's records",
      "only this server's snapback admins can read or change its records.",
      undefined,
      "ask one of this server's snapback admins, or the instance owner, for access.",
    ),
    ephemeral: true,
  };
}

/** the records of this guild, one page. */
export async function recordsPageFor(
  deps: VerifyDeps,
  guildId: string,
  page: number,
): Promise<ReturnType<typeof recordsPage>> {
  const rows = await deps.records(guildId, RECORDS_PAGE_SIZE * page + RECORDS_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(rows.length / RECORDS_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const shown = rows.slice((current - 1) * RECORDS_PAGE_SIZE, current * RECORDS_PAGE_SIZE);

  return recordsPage({
    guildId,
    rows: shown.map(summarise),
    page: current,
    pages,
    selectId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.select,
    }),
    prevId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.open,
      cursor: String(Math.max(1, current - 1)),
    }),
    nextId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.open,
      cursor: String(Math.min(pages, current + 1)),
    }),
    refreshId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.refresh,
    }),
    deleteId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.delete,
    }),
  });
}

/** one record in full. */
export function recordPageFor(
  guildId: string,
  record: VerifyRecordRow,
): ReturnType<typeof recordPage> {
  return recordPage({
    guildId,
    record: fieldsOf(record),
    revokeId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.record,
      action: VERIFY_ACTION.revoke,
      cursor: record.user_id,
    }),
    deleteId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.record,
      action: VERIFY_ACTION.delete,
      cursor: record.user_id,
    }),
    backId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.open,
    }),
  });
}

function summarise(record: VerifyRecordRow): VerifyRecordSummary {
  return {
    userId: record.user_id,
    username: record.username ?? "unknown",
    scopes: record.oauth_scopes_json ?? [],
    lastChecked: record.oauth_last_checked_at,
    tokenStatus: record.token_status,
  };
}

/** the record's fields, with the ones that were never captured left empty so
 *  the page can say "not captured" rather than showing a blank. */
function fieldsOf(record: VerifyRecordRow): RecordFields {
  const fingerprint = record.fingerprint_json;
  return {
    userId: record.user_id,
    username: record.username ?? "unknown",
    globalName: record.global_name,
    email: record.email,
    emailVerified: record.email_verified,
    scopes: record.oauth_scopes_json ?? [],
    countryName: record.country_name,
    isp: record.isp,
    asOrg: record.as_org,
    ipType: record.ip_type ?? null,
    guilds: [],
    connections: [],
    // the friends list is never captured: discord gates that scope behind the
    // social sdk (D4PLAN 13.3 step 10).
    relationshipsCaptured: false,
    fingerprint: fingerprint === null ? null : "captured",
    tokenStatus: record.token_status,
    lastChecked: record.oauth_last_checked_at,
    events: [],
  };
}
