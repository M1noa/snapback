// services/backup/events.ts. D4PLAN 11 step 12: scheduled events, with their
// cover images, so a restore can put the same events back.

import { insertBackupEvents } from "../../db/queries/backup-events.ts";
import type { BackupEventRow, JsonObject } from "../../db/types.ts";
import type { BackupContext, Capture } from "./types.ts";
import { skipFor } from "./types.ts";

interface RawEvent {
  id: string;
  name: string;
  description?: string | null;
  scheduled_start_time?: string | null;
  scheduled_end_time?: string | null;
  privacy_level: number;
  entity_type: number;
  entity_metadata?: JsonObject | null;
  status: number;
  image?: string | null;
  cover_image?: string | null;
}

// the cover lives beside the guild's own assets; discord returns a hash, and the
// url is the one it serves the image from.
function coverUrl(event: RawEvent): string | null {
  const hash = event.image ?? event.cover_image ?? null;
  if (typeof hash !== "string" || hash === "") return null;
  return `https://cdn.discordapp.com/guild-events/${event.id}/${hash}.png`;
}

function toEventRow(ctx: BackupContext, event: RawEvent): BackupEventRow {
  return {
    backup_id: ctx.backupId,
    source_event_id: event.id,
    name: event.name,
    description: event.description ?? null,
    scheduled_start: event.scheduled_start_time ?? null,
    scheduled_end: event.scheduled_end_time ?? null,
    privacy_level: event.privacy_level,
    entity_type: event.entity_type,
    entity_metadata_json: event.entity_metadata ?? null,
    status: event.status,
    cover_url: coverUrl(event),
  };
}

export const captureEvents: Capture = async (ctx) => {
  let raw: RawEvent[];
  try {
    raw = await ctx.client.request<RawEvent[]>({
      method: "GET",
      // with_user_count is what the plan asks for: the counts ride along with the
      // events rather than costing a request each.
      route: `/guilds/${ctx.guildId}/scheduled-events?with_user_count=true`,
    });
  } catch (error) {
    ctx.skips.add(skipFor("events", "all scheduled events", error));
    return { written: 0 };
  }

  const rows = (Array.isArray(raw) ? raw : []).map((event) => toEventRow(ctx, event));
  await insertBackupEvents(ctx.db, rows);

  for (const row of rows) {
    if (row.cover_url !== null) await ctx.assets.save("guild", row.source_event_id, row.cover_url);
  }

  await ctx.checkpoint("events", { done: 1, total: 1 });
  return { written: rows.length };
};
