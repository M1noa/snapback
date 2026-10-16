// /snapback status (D4PLAN 8). uptime, gateway latency, job queue depth, db size,
// tracked guilds, version.
//
// every number is read through an injected probe, so the page is testable
// without a gateway or a database, and a probe that fails does not take the
// page down with it.

import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import type { CommandContext, CommandResult, SlashCommand } from "../types.ts";
import { formatBytes, formatDuration, relativeTimestamp } from "../types.ts";

export interface StatusSnapshot {
  readonly version: string;
  readonly commit: string | null;
  readonly oceanicVersion: string;
  readonly schemaVersion: number;
  readonly startedAt: number;
  readonly gatewayReady: boolean;
  readonly gatewayLatencyMs: number | null;
  readonly jobDepth: number;
  readonly jobRunning: number;
  readonly dbDriver: string;
  readonly dbBytes: number | null;
  readonly trackedGuilds: number;
  readonly rateLimitBuckets: number;
}

export type StatusProbe = () => Promise<StatusSnapshot> | StatusSnapshot;

function line(label: string, value: string): string {
  return `**${label}** ${value}`;
}

export function statusCommand(read: StatusProbe): SlashCommand {
  return {
    group: "snapback",
    subcommand: "status",
    description: "uptime, gateway, queue, database, and version at a glance",
    async run(_ctx: CommandContext): Promise<CommandResult> {
      const snapshot = await read();
      const now = Date.now();

      const gateway = snapshot.gatewayReady
        ? `connected, ${snapshot.gatewayLatencyMs ?? 0} ms ping`
        : "not connected";

      const sections = [
        textDisplay(
          [
            line(
              "version",
              `\`${snapshot.version}\`${snapshot.commit ? ` (\`${snapshot.commit}\`)` : ""}`,
            ),
            line("oceanic", `\`${snapshot.oceanicVersion}\``),
            line("schema", `v${snapshot.schemaVersion}`),
          ].join("\n"),
        ),
        textDisplay(
          [
            line(
              "uptime",
              `${formatDuration(now - snapshot.startedAt)} (since ${relativeTimestamp(snapshot.startedAt)})`,
            ),
            line("gateway", gateway),
            line("guilds", String(snapshot.trackedGuilds)),
          ].join("\n"),
        ),
        textDisplay(
          [
            line("queue", `${snapshot.jobDepth} waiting, ${snapshot.jobRunning} running`),
            line("database", `${snapshot.dbDriver}, ${formatBytes(snapshot.dbBytes)}`),
            line("rate limit buckets", String(snapshot.rateLimitBuckets)),
          ].join("\n"),
        ),
      ];

      // the status word follows the gateway, because that is the thing an
      // operator is actually checking this page for.
      const state = snapshot.gatewayReady ? "success" : "warning";

      return {
        page: page({
          state,
          title: snapshot.gatewayReady ? "snapback is up" : "snapback is up, gateway is not",
          sections,
        }),
        ephemeral: true,
      };
    },
  };
}
