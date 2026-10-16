// the REST half of command registration. registry.ts decides what differs; this
// file is the adapter that turns that decision into calls on discord/client.ts,
// because all api traffic goes through it (AGENTS.md rule 6). registry.ts stays
// import-free of the client on purpose, so its diff is testable alone.

import type { Logger } from "../../lib/log.ts";
import type { DiscordClient } from "../client.ts";
import {
  type CommandDefinition,
  type CommandOption,
  type CommandsRest,
  diffCommands,
  type RegisteredCommand,
  type RegistrationScope,
} from "../registry.ts";

// discord's shape for a registered command. ids arrive as strings; they are kept
// that way (rule 3).
interface WireCommand {
  id: string;
  name: string;
  description: string;
  options?: CommandOption[];
}

// guild scope when DISCORD_DEV_GUILD_ID is set, global otherwise (D4PLAN 8).
function routeFor(applicationId: string, scope: RegistrationScope): string {
  const base = `/applications/${applicationId}/commands`;
  if (scope.kind === "guild") {
    if (scope.guildId === undefined) throw new Error("guild scope needs a guildId");
    return `/applications/${applicationId}/guilds/${scope.guildId}/commands`;
  }
  return base;
}

function toRegistered(raw: WireCommand): RegisteredCommand {
  return { id: String(raw.id), name: raw.name, description: raw.description, options: raw.options };
}

/** the CommandsRest implementation. applicationId is the bot's own user id. */
export function createCommandsRest(client: DiscordClient, applicationId: string): CommandsRest {
  return {
    async list(scope) {
      const raw = await client.request<WireCommand[]>({
        method: "GET",
        route: routeFor(applicationId, scope),
      });
      return raw.map(toRegistered);
    },
    async put(scope, commands) {
      const raw = await client.request<WireCommand[]>({
        method: "PUT",
        route: routeFor(applicationId, scope),
        body: commands,
      });
      return raw.map(toRegistered);
    },
  };
}

/** list, diff, and put only when something changed. returns the diff either way. */
export async function syncCommands(
  rest: CommandsRest,
  definitions: readonly CommandDefinition[],
  scope: RegistrationScope,
  log: Logger,
): Promise<void> {
  const live = await rest.list(scope);
  const diff = diffCommands(definitions, live);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    log.info("slash commands are in sync", { scope: scope.kind, count: definitions.length });
    return;
  }

  log.info("registering slash commands", {
    scope: scope.kind,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed.flatMap((change) => change.fields.map((f) => `${change.name}.${f}`)),
  });

  const registered = await rest.put(scope, definitions);
  log.info("slash commands registered", {
    scope: scope.kind,
    count: registered.length,
    propagation: scope.kind === "guild" ? "instant" : "up to an hour",
  });
}
