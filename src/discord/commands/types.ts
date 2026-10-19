// the shape every slash command follows. everything a command needs is injected,
// so a command is testable without a gateway, a database, or a network call.

import type { ContainerComponent } from "oceanic.js";
import type { CommandOption } from "../registry.ts";

export type CommandOptionValue = string | number | boolean | undefined;

export interface CommandContext {
  readonly guildId: string;
  readonly userId: string;
  readonly options: Readonly<Record<string, CommandOptionValue>>;
}

export interface CommandResult {
  /** the rendered page. the transport sends it and sets the v2 flag itself. */
  readonly page: ContainerComponent;
  /** private settings and records reply ephemerally by default (AGENTS.md qol). */
  readonly ephemeral: boolean;
}

// one subcommand, not one whole slash command. two entries with the same group
// merge into a single definition, because discord rejects two commands sharing a
// name: /snapback is one command with a status and a diagnostics subcommand, not
// two commands both called snapback.
/** what discord is typing into while it asks for choices. */
export interface AutocompleteContext {
  readonly guildId: string;
  readonly userId: string;
  /** the option being typed into. */
  readonly option: string;
  /** what has been typed so far. */
  readonly value: string;
}

/** one suggested value. the name is what the person reads, the value is what
 *  discord hands back when the choice is picked. */
export interface AutocompleteChoice {
  readonly name: string;
  readonly value: string;
}

export interface SlashCommand {
  /** the top-level command name, e.g. "snapback". */
  readonly group: string;
  /** absent for a command with no subcommands, e.g. /setup. */
  readonly subcommand?: string;
  readonly description: string;
  /** this subcommand's own options. */
  readonly options?: readonly CommandOption[];
  /**
   * the choices for an option that names a record. discord asks while the person
   * is typing, so it never makes anyone copy an id (AGENTS.md quality of life).
   */
  readonly autocomplete?: (ctx: AutocompleteContext) => Promise<AutocompleteChoice[]>;
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
}

/** ms as a short human duration, e.g. "3d 4h", "12m 5s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/** bytes as the largest unit that keeps a whole number, e.g. "13.4 MiB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** a discord relative timestamp. every time we show a user goes through this. */
export function relativeTimestamp(at: number): string {
  return `<t:${Math.floor(at / 1000)}:R>`;
}
