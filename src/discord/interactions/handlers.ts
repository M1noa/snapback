// the interactionCreate entry point. two shapes arrive: a slash command and a
// component. both resolve an identity, re-check access on every call (rule 8),
// and answer through dispatch.ts, so no message is built here and the router
// stays a pure decision.
//
// nothing long runs inline (rule 7): a handler that has work to do enqueues it
// and defers.

import {
  type AnyInteractionGateway,
  ApplicationCommandOptionTypes,
  type CommandInteraction,
  type ComponentInteraction,
  type InteractionOptions,
  type ModalSubmitInteraction,
} from "oceanic.js";
import type { Logger } from "../../lib/log.ts";
import { findCommand } from "../commands/index.ts";
import type { CommandOptionValue, SlashCommand } from "../commands/types.ts";
import { checkAccess } from "../registry.ts";
import {
  commandResultPayload,
  deniedPage,
  failurePage,
  type InteractionResponder,
  oceanicResponder,
  outcomeReply,
  v2Payload,
} from "./dispatch.ts";
import type { AuthDecision, AuthHook, Router } from "./router.ts";

// the two codes this file can raise itself. one fixed message each (AGENTS.md errors).
export const ACCESS_DENIED = "SB_ACCESS_DENIED";
export const GUILD_MISMATCH = "SB_GUILD_MISMATCH";

export interface InteractionDeps {
  readonly commands: readonly SlashCommand[];
  readonly router: Router;
  readonly ownerId: string;
  readonly log: Logger;
  /** db-backed: is this user a snapback admin for the guild (guild_admins)? */
  readonly isGuildAdmin: (userId: string, guildId: string) => Promise<boolean> | boolean;
  readonly responder?: InteractionResponder;
}

/** what every access decision needs. the two paths share one predicate. */
export interface AccessDeps {
  readonly ownerId: string;
  readonly isGuildAdmin: (userId: string, guildId: string) => Promise<boolean> | boolean;
}

// options arrive nested under a subcommand, and a subcommand group adds another
// level. flatten to one record: a command reads ctx.options.name and does not
// care where in the tree discord put it.
function collect(
  options: readonly InteractionOptions[] | undefined,
): Record<string, CommandOptionValue> {
  const out: Record<string, CommandOptionValue> = {};
  for (const option of options ?? []) {
    if ("value" in option) {
      const value = option.value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out[option.name] = value;
      }
    }
    if ("options" in option) Object.assign(out, collect(option.options));
  }
  return out;
}

interface Invocation {
  /** the subcommand to run, or undefined for a command with no subcommands. */
  readonly name: string | undefined;
  readonly options: Record<string, CommandOptionValue>;
}

// the raw options carry the subcommand name; the wrapper's getSubCommand returns
// a tuple that loses it.
function invocationOf(options: readonly InteractionOptions[] | undefined): Invocation {
  for (const option of options ?? []) {
    const name = "name" in option ? option.name : "";
    if (option.type === ApplicationCommandOptionTypes.SUB_COMMAND) {
      const nested = "options" in option ? option.options : undefined;
      return { name, options: collect(nested) };
    }
    if (option.type === ApplicationCommandOptionTypes.SUB_COMMAND_GROUP) {
      return invocationOf("options" in option ? option.options : undefined);
    }
  }
  return { name: undefined, options: collect(options) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** owner or guild admin, re-checked on every interaction. a control rendered for
 *  an admin last week must fail closed today. this is the router's auth hook. */
export function createAuthorizer(deps: AccessDeps): AuthHook {
  return async ({ id, identity }) => {
    // the id carries the guild it was minted for. a control used in another
    // server is refused even when the user is an admin of that other server.
    if (id.guild !== identity.guildId) {
      return deny(GUILD_MISMATCH, "this control was made for a different server.");
    }
    return await accessDecision(deps, identity.userId, identity.guildId);
  };
}

export function createInteractionHandler(
  deps: InteractionDeps,
): (interaction: AnyInteractionGateway) => Promise<void> {
  const responder = deps.responder ?? oceanicResponder;

  return async function onInteraction(interaction: AnyInteractionGateway): Promise<void> {
    try {
      if (interaction.isCommandInteraction()) {
        await runCommand(interaction, deps, responder);
        return;
      }
      if (interaction.isComponentInteraction() || interaction.isModalSubmitInteraction()) {
        await runComponent(interaction, deps, responder);
        return;
      }
      // autocomplete and ping carry nothing to do yet; the first autocomplete
      // source adds its branch here.
    } catch (error) {
      // the one place an interaction failure is caught: an unhandled throw here
      // is a silent "the application did not respond" for the user.
      deps.log.error("interaction handler threw", { message: messageOf(error), error });
    }
  };
}

async function accessDecision(
  deps: AccessDeps,
  userId: string,
  guildId: string,
): Promise<AuthDecision> {
  const access = await checkAccess({
    userId,
    guildId,
    ownerId: deps.ownerId,
    isGuildAdmin: deps.isGuildAdmin,
  });
  if (access.kind === "allow") return { kind: "allow" };
  return deny(ACCESS_DENIED, access.denial.body, access.denial.needs);
}

function deny(code: string, message: string, fix?: string): AuthDecision {
  return { kind: "deny", reason: fix === undefined ? { code, message } : { code, message, fix } };
}

async function runCommand(
  interaction: CommandInteraction,
  deps: InteractionDeps,
  responder: InteractionResponder,
): Promise<void> {
  const guildId = interaction.guildID;
  if (guildId === null) {
    await responder.reply(
      interaction,
      v2Payload(
        failurePage("commands work in a server", "this interaction has no guild attached."),
        true,
      ),
    );
    return;
  }

  const invocation = invocationOf(interaction.data.options?.raw);
  const command = findCommand(deps.commands, interaction.data.name, invocation.name);
  if (command === undefined) {
    // registered live but absent from this build: an older message, or a
    // registration this process did not do.
    await responder.reply(
      interaction,
      v2Payload(
        failurePage(
          "unknown command",
          `this build has no handler for /${interaction.data.name}.`,
          undefined,
          "run /snapback diagnostics, or restart snapback.",
        ),
        true,
      ),
    );
    return;
  }

  const decision = await accessDecision(deps, interaction.user.id, guildId);
  if (decision.kind === "deny") {
    await responder.reply(interaction, v2Payload(deniedPage(decision.reason), true));
    return;
  }

  const result = await command.run({
    guildId,
    userId: interaction.user.id,
    options: invocation.options,
  });
  await responder.reply(interaction, commandResultPayload(result));
}

async function runComponent(
  interaction: ComponentInteraction | ModalSubmitInteraction,
  deps: InteractionDeps,
  responder: InteractionResponder,
): Promise<void> {
  const guildId = interaction.guildID;
  if (guildId === null) {
    await responder.reply(
      interaction,
      v2Payload(failurePage("no server", "this control has no guild attached."), true),
    );
    return;
  }

  const customId = interaction.data.customID;
  const outcome = await deps.router.route(customId, {
    userId: interaction.user.id,
    guildId,
    isOwner: interaction.user.id === deps.ownerId,
  });

  if (outcome.kind === "handled") {
    // the handler answered, or asked to be deferred. deferring something already
    // acknowledged is a 40024.
    if (outcome.result.kind === "deferred" && !interaction.acknowledged) {
      await responder.defer(interaction);
    }
    return;
  }

  if (outcome.kind === "auth_error" || outcome.kind === "handler_error") {
    deps.log.error(outcome.kind === "auth_error" ? "authorisation check threw" : "handler threw", {
      customId,
      message: outcome.message,
      error: outcome.error,
    });
  }

  const reply = outcomeReply(outcome);
  if (reply === null) return;
  if (reply.update) await responder.update(interaction, reply.payload);
  else await responder.reply(interaction, reply.payload);
}
