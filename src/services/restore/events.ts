// the scheduled events phase (D4PLAN 12.2 step 10). an event references a
// channel or a voice stage, so it runs after the channels exist.

import { listBackupEventsByBackup } from "../../db/queries/backup-events.ts";
import { DiscordApiError, formatDiscordError } from "../../discord/errors.ts";
import { phaseOk, type RestorePhase } from "./types.ts";

function why(error: unknown): string {
  if (error instanceof DiscordApiError) return formatDiscordError(error).said;
  return error instanceof Error ? error.message : String(error);
}

export const restoreEvents: RestorePhase = async (ctx) => {
  if (!ctx.options.events) return phaseOk(0);
  const events = await listBackupEventsByBackup(ctx.db, ctx.backupId);
  if (events.length === 0) return phaseOk(0);

  const notes: { what: string; why: string }[] = [];
  let count = 0;

  for (const event of events) {
    const metadata = (event.entity_metadata_json ?? {}) as Record<string, unknown>;
    const entity: Record<string, unknown> = { type: event.entity_type };

    // the entity points at a channel, and the channel is a source id: it is
    // resolved through the map.
    const channelId = metadata.channel_id;
    if (typeof channelId === "string") {
      const target = ctx.maps.channels.get(channelId);
      if (target === undefined) {
        notes.push({
          what: `the event "${event.name}"`,
          why: "the channel it points at is not in the target",
        });
        continue;
      }
      entity.channel_id = target;
    }

    try {
      await ctx.client.request({
        method: "POST",
        route: `/guilds/${ctx.targetGuildId}/scheduled-events`,
        body: {
          name: event.name,
          description: event.description ?? "",
          scheduled_start_time: event.scheduled_start ?? ctx.now(),
          scheduled_end_time: event.scheduled_end ?? undefined,
          privacy_level: event.privacy_level,
          entity_type: event.entity_type,
          entity_metadata: entity,
        },
      });
      count += 1;
    } catch (error) {
      notes.push({ what: `the event "${event.name}"`, why: why(error) });
    }
  }

  for (const note of notes) ctx.note(note.what, note.why);
  return phaseOk(count, notes);
};
