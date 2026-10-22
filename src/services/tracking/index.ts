// the timeline service. one append-only table, two switches, no db read per event.
import type { Client } from "oceanic.js";
import { DEFAULT_TRACKING, type TrackingSettings } from "../../config/defaults.ts";
import { getGuildSettings, listActiveGuilds } from "../../db/queries/guilds.ts";
import { insertTrackedEvent } from "../../db/queries/tracked-events.ts";
import type {
  Database,
  EventSource,
  JsonObject,
  TrackedEventKind,
  TrackedSubjectKind,
} from "../../db/types.ts";
import type { Logger } from "../../lib/log.ts";
import { attachHandlers } from "./attach.ts";
import { needsPalantir } from "./kinds.ts";

export interface TrackInput {
  guildId: string;
  subjectKind: TrackedSubjectKind;
  subjectId: string;
  kind: TrackedEventKind;
  actorId?: string | null;
  source?: EventSource;
  channelId?: string | null;
  before?: JsonObject | null;
  after?: JsonObject | null;
  detail?: JsonObject | null;
  at?: string | null;
}

export class TrackingService {
  readonly #db: Database;
  readonly #log: Logger;
  readonly #settings = new Map<string, TrackingSettings>();

  constructor(db: Database, log: Logger) {
    this.#db = db;
    this.#log = log;
  }

  // every active guild's switches, read once. a guild missing here uses the defaults.
  async load(): Promise<void> {
    const guilds = await listActiveGuilds(this.#db);
    let history = 0;
    let palantir = 0;
    for (const guild of guilds) {
      const settings = guild.settings_json?.tracking ?? DEFAULT_TRACKING;
      this.#settings.set(guild.guild_id, settings);
      if (settings.history) history += 1;
      if (settings.history && settings.palantir) palantir += 1;
    }
    this.#log.debug("tracking loaded", { guilds: guilds.length, history, palantir });
  }

  settingsFor(guildId: string): TrackingSettings {
    return this.#settings.get(guildId) ?? DEFAULT_TRACKING;
  }

  allows(guildId: string, kind: TrackedEventKind): boolean {
    const settings = this.settingsFor(guildId);
    if (!settings.history) return false;
    return settings.palantir || !needsPalantir(kind);
  }

  // called when /setup saves a guild's settings.
  async invalidate(guildId: string): Promise<void> {
    const settings = await getGuildSettings(this.#db, guildId);
    this.#settings.set(guildId, settings?.tracking ?? DEFAULT_TRACKING);
  }

  async record(input: TrackInput): Promise<boolean> {
    if (!this.allows(input.guildId, input.kind)) return false;
    const recordedAt = new Date().toISOString();
    await insertTrackedEvent(this.#db, {
      event_id: Bun.randomUUIDv7(),
      guild_id: input.guildId,
      subject_kind: input.subjectKind,
      subject_id: input.subjectId,
      kind: input.kind,
      actor_id: input.actorId ?? null,
      source: input.source ?? "gateway",
      channel_id: input.channelId ?? null,
      before_json: input.before ?? null,
      after_json: input.after ?? null,
      detail_json: input.detail ?? null,
      at: input.at ?? recordedAt,
      recorded_at: recordedAt,
    });
    return true;
  }

  async recordAll(inputs: readonly TrackInput[]): Promise<void> {
    for (const input of inputs) await this.record(input);
  }

  attach(client: Client): void {
    attachHandlers(client, this);
  }

  // a tracking failure is logged, never thrown into a gateway handler.
  reportFailure(handler: string, error: unknown): void {
    this.#log.error("tracking handler failed", {
      handler,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
