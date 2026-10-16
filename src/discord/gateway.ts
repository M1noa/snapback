// discord/gateway.ts (D4PLAN 4, 7.1, 18.4; AGENTS.md 6).
//
// oceanic owns the gateway; this is the only file that builds its Client. it
// wires the connection, the intent list, the shard lifecycle, and the event
// hooks, and hands the boot path a status and a clean destroy().
//
// no REST here: discord/client.ts owns that, and interactions go to
// discord/interactions/router.ts. every hook logs through the injected logger;
// nothing here calls console.

import { Client, type IntentNames } from "oceanic.js";
import type { Logger } from "../lib/log.ts";

// the intent list (D4PLAN 7.1). exactly these, no more. GUILD_PRESENCES and
// DIRECT_MESSAGES are never requested. GUILD_MEMBERS is privileged: it must be
// toggled on in the Developer Panel or the bot never reaches ready.
export const GATEWAY_INTENTS: readonly IntentNames[] = [
  "GUILDS",
  "GUILD_MEMBERS",
  "GUILD_MODERATION",
  "GUILD_EMOJIS_AND_STICKERS",
  "GUILD_VOICE_STATES",
  "GUILD_SCHEDULED_EVENTS",
  "GUILD_MESSAGES",
];

// D4PLAN 7.1: reaction capture on live messages. optional, off by default.
export const LIVE_REACTIONS_INTENT: IntentNames = "GUILD_MESSAGE_REACTIONS";

// the intents-checklist pointer. 4013/4014 are always a Developer Panel problem
// (D4PLAN 18.4), so the log line names the toggle, not just the close code.
export const INTENTS_CHECKLIST =
  'Developer Panel -> your application -> Bot -> Privileged Gateway Intents ("Server Members Intent"); see docs/developer-panel.md';

// the gateway close-code table (D4PLAN 18.4). it ADDS a plain diagnosis to the
// close code and reason discord sent; neither is ever replaced by it.
const CLOSE_CODE_DIAGNOSIS: Record<number, string> = {
  4004: "the bot token was rejected; regenerate it in the Developer Panel and update DISCORD_TOKEN",
  4010: "the shard id is invalid; check the shard count and id, then reconnect",
  4011: "the session would handle too many guilds; the gateway requires sharding",
  4013: `the gateway rejected the intents as invalid; ${INTENTS_CHECKLIST}`,
  4014: `the gateway refused a disallowed privileged intent; snapback requests GUILD_MEMBERS, so enable it: ${INTENTS_CHECKLIST}`,
};

const INTENTS_CLOSE_CODES: ReadonlySet<number> = new Set([4013, 4014]);

export interface CloseCodeDiagnosis {
  readonly code: number;
  readonly reason: string;
  /** a sentence added to the code and reason, or null when the code is unmapped. */
  readonly diagnosis: string | null;
  /** true when the diagnosis points at the Developer Panel intents checklist. */
  readonly intentsChecklist: boolean;
}

/** add a diagnosis to one gateway close code and reason, never replacing them. */
export function diagnoseCloseCode(code: number, reason: string): CloseCodeDiagnosis {
  return {
    code,
    reason,
    diagnosis: CLOSE_CODE_DIAGNOSIS[code] ?? null,
    intentsChecklist: INTENTS_CLOSE_CODES.has(code),
  };
}

// oceanic surfaces the close code as a numeric `.code` on its GatewayError, or
// as a bare string. pull the code out when it is there.
function closeCodeOf(info: Error | string): number | null {
  if (typeof info === "object" && info !== null) {
    const code = (info as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

// the fields for one error/warn line: code and reason kept, a diagnosis added.
function closeFields(info: Error | string, shard: number | undefined): Record<string, unknown> {
  const reason = typeof info === "string" ? info : info.message;
  const fields: Record<string, unknown> = { reason };
  if (shard !== undefined) fields.shard = shard;
  const code = closeCodeOf(info);
  if (code !== null) {
    const { diagnosis, intentsChecklist } = diagnoseCloseCode(code, reason);
    fields.code = code;
    fields.diagnosis = diagnosis;
    if (intentsChecklist) fields.intentsChecklist = INTENTS_CHECKLIST;
  }
  return fields;
}

export interface GatewayOptions {
  readonly token: string;
  readonly log: Logger;
  /** D4PLAN 7.1: add GUILD_MESSAGE_REACTIONS for live reaction capture. off by default. */
  readonly liveReactions?: boolean;
}

/** the resolved gateway state the boot path reads. */
export interface GatewayStatus {
  /** true once every shard has reached ready. */
  readonly ready: boolean;
  /** average shard latency in ms, or null until a shard reports one. */
  readonly ping: number | null;
  readonly shards: number;
  readonly tag: string | null;
}

export class Gateway {
  readonly #client: Client;
  readonly #log: Logger;
  #ready = false;
  #readyLogged = false;
  #tag: string | null = null;

  constructor(options: GatewayOptions) {
    this.#log = options.log;
    const intents = options.liveReactions
      ? [...GATEWAY_INTENTS, LIVE_REACTIONS_INTENT]
      : [...GATEWAY_INTENTS];
    this.#client = new Client({ auth: `Bot ${options.token}`, gateway: { intents } });
    this.#registerHooks();
  }

  /** the underlying client, so the boot path can attach the interaction router. */
  get client(): Client {
    return this.#client;
  }

  /** connect. resolves once the connect is queued, not once the gateway is ready. */
  async connect(): Promise<void> {
    await this.#client.connect();
  }

  /** disconnect and stop reconnecting. */
  destroy(): void {
    this.#ready = false;
    this.#client.disconnect(false);
  }

  status(): GatewayStatus {
    let total = 0;
    let reporting = 0;
    for (const shard of this.#client.shards.values()) {
      if (shard.ready) {
        total += shard.latency;
        reporting += 1;
      }
    }
    return {
      ready: this.#ready,
      ping: reporting === 0 ? null : Math.round(total / reporting),
      shards: this.#client.shards.size,
      tag: this.#tag,
    };
  }

  #registerHooks(): void {
    const client = this.#client;

    // D4PLAN 18.4 wants the code and reason kept, with a diagnosis added.
    client.on("error", (info, shard) => this.#log.error("gateway error", closeFields(info, shard)));
    client.on("warn", (info, shard) => this.#log.warn("gateway warning", closeFields(info, shard)));

    client.on("ready", () => {
      this.#ready = true;
      this.#tag = client.user.tag;
      if (this.#readyLogged) return; // log the first ready once
      this.#readyLogged = true;
      this.#log.info("gateway ready", { shards: client.shards.size, tag: this.#tag });
    });
  }
}

// D4PLAN 18.4: the unhandled paths. exposed as a function the boot path calls,
// not registered on import, so importing this module never mutates the process.
// oceanic surfaces most discord errors as rejections, so unhandledRejection
// logs and does NOT exit; exiting there would make the bot a crash loop.
export function installProcessErrorHandlers(log: Logger): void {
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", { reason });
  });
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception, exiting", { error });
    void log.flush().finally(() => process.exit(1));
  });
}
