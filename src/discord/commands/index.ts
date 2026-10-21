// the command manifest. one place that knows every slash command, so the
// registration diff and the boot check both read the same list.
//
// discord rejects two commands sharing a name, so entries with the same group
// merge into one definition with a subcommand per entry (D4PLAN 8).

import { type CommandDefinition, type CommandOption, OPTION_TYPE } from "../registry.ts";
import type { SlashCommand } from "./types.ts";

// one description per top-level command. a group with no entry here is a bug the
// buildDefinitions call below reports rather than inventing a description.
export const GROUP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  setup: "the setup wizard, its steps, and the operator docs",
  snapback: "snapback bot status, diagnostics, and version",
  backup: "capture this server, and read what was captured",
  restore: "put a backup back into a server, category by category",
  verify: "the verification panel, its records, and the refresh sweep",
  users: "look up one member record, export it, or blacklist someone",
  pull: "add the members who granted a token back into this server",
};

export interface CommandManifest {
  readonly definitions: readonly CommandDefinition[];
  readonly commands: readonly SlashCommand[];
}

/** groups subcommands under one top-level command, in a stable order. */
export function buildDefinitions(commands: readonly SlashCommand[]): CommandDefinition[] {
  const groups = new Map<string, SlashCommand[]>();
  for (const command of commands) {
    const existing = groups.get(command.group);
    if (existing === undefined) groups.set(command.group, [command]);
    else existing.push(command);
  }

  const definitions: CommandDefinition[] = [];
  for (const [name, entries] of groups) {
    const description = GROUP_DESCRIPTIONS[name];
    if (description === undefined) {
      throw new Error(`no group description for /${name}; add one to GROUP_DESCRIPTIONS`);
    }

    const grouped = entries.filter((entry) => entry.subcommand !== undefined);
    if (grouped.length === 0) {
      // a plain command: its single entry carries the top-level options.
      const only = entries[0];
      if (only === undefined) continue;
      definitions.push({ name, description, ...optionsOf(only.options) });
      continue;
    }
    if (grouped.length !== entries.length) {
      throw new Error(`/${name} mixes subcommands and bare entries; pick one shape`);
    }

    definitions.push({
      name,
      description,
      options: grouped.map((entry) => ({
        name: entry.subcommand ?? "",
        description: entry.description,
        type: OPTION_TYPE.subCommand,
        ...optionsOf(entry.options),
      })),
    });
  }
  return definitions;
}

function optionsOf(options: readonly CommandOption[] | undefined): {
  options?: readonly CommandOption[];
} {
  return options === undefined || options.length === 0 ? {} : { options };
}

export function buildManifest(commands: readonly SlashCommand[]): CommandManifest {
  return { definitions: buildDefinitions(commands), commands };
}

/** the handler for one (group, subcommand) pair, or undefined if there is none. */
export function findCommand(
  commands: readonly SlashCommand[],
  group: string,
  subcommand: string | undefined,
): SlashCommand | undefined {
  return commands.find((command) => command.group === group && command.subcommand === subcommand);
}

export {
  diagnosticsCommand,
  type Probe,
  type ProbeResult,
  type ProbeState,
} from "./system/diagnostics.ts";
export { type StatusProbe, type StatusSnapshot, statusCommand } from "./system/status.ts";
