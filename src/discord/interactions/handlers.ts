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
  type AutocompleteInteraction,
  type CommandInteraction,
  type ComponentInteraction,
  ComponentTypes,
  type InteractionOptions,
  type ModalSubmitInteraction,
} from "oceanic.js";
import type { Logger } from "../../lib/log.ts";
import { findCommand } from "../commands/index.ts";
import type { CommandOptionValue, SlashCommand } from "../commands/types.ts";
import { checkAccess } from "../registry.ts";
import type { RespondableInteraction } from "./dispatch.ts";
import {
  commandResultPayload,
  deniedPage,
  failurePage,
  type InteractionResponder,
  oceanicResponder,
  outcomeReply,
  v2Payload,
} from "./dispatch.ts";
import type { AuthDecision, AuthHook, HandlerSurface, Router, SubmittedValue } from "./router.ts";

// the two codes this file can raise itself. one fixed message each (AGENTS.md errors).
export const ACCESS_DENIED = "SB_ACCESS_DENIED";
export const GUILD_MISMATCH = "SB_GUILD_MISMATCH";

export interface InteractionDeps {
  readonly commands: readonly SlashCommand[];
  readonly router: Router;
  readonly ownerId: string;
  /** the same row the authorizer's owner lane reads; see AccessDeps. */
  readonly guildOwnerId: (guildId: string) => Promise<string | null>;
  readonly log: Logger;
  /** db-backed: is this user a snapback admin for the guild (guild_admins)? */
  readonly isGuildAdmin: (userId: string, guildId: string) => Promise<boolean> | boolean;
  readonly responder?: InteractionResponder;
}

/** what every access decision needs. the two paths share one predicate. */
export interface AccessDeps {
  readonly ownerId: string;
  /** the guild owner, read from the synced guilds row. null when the guild has
   *  no row, which vouches for nobody. */
  readonly guildOwnerId: (guildId: string) => Promise<string | null>;
  /**
   * is this person allowed to drive this surface? the surface is the id's, so
   * the check can be per capability: reading records is not the same grant as
   * running a backup (D4PLAN 19.1).
   */
  readonly isGuildAdmin: (
    userId: string,
    guildId: string,
    surface: string,
  ) => Promise<boolean> | boolean;
}

// an attachment option's value is its id, not the file. an id is not fetchable,
// so the command path trades it for the cdn url discord resolved next to it.
type AttachmentResolver = (id: string) => string | undefined;

// options arrive nested under a subcommand, and a subcommand group adds another
// level. flatten to one record: a command reads ctx.options.name and does not
// care where in the tree discord put it.
function collect(
  options: readonly InteractionOptions[] | undefined,
  attachments?: AttachmentResolver,
): Record<string, CommandOptionValue> {
  const out: Record<string, CommandOptionValue> = {};
  for (const option of options ?? []) {
    if ("value" in option) {
      const value = option.value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const url = typeof value === "string" ? attachments?.(value) : undefined;
        out[option.name] = url ?? value;
      }
    }
    if ("options" in option) Object.assign(out, collect(option.options, attachments));
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
function invocationOf(
  options: readonly InteractionOptions[] | undefined,
  attachments?: AttachmentResolver,
): Invocation {
  for (const option of options ?? []) {
    const name = "name" in option ? option.name : "";
    if (option.type === ApplicationCommandOptionTypes.SUB_COMMAND) {
      const nested = "options" in option ? option.options : undefined;
      return { name, options: collect(nested, attachments) };
    }
    if (option.type === ApplicationCommandOptionTypes.SUB_COMMAND_GROUP) {
      return invocationOf("options" in option ? option.options : undefined, attachments);
    }
  }
  return { name: undefined, options: collect(options, attachments) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// the cdn url for one uploaded attachment id. discord resolves uploads into the
// interaction alongside the components, so a command and a modal both arrive
// with the url already sitting next to the id. an id it did not resolve, or no
// resolved block at all, yields undefined.
function resolvedAttachmentUrl(
  interaction: CommandInteraction | ModalSubmitInteraction,
  id: string | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  return interaction.data.resolved.attachments.get(id)?.url;
}

// one submitted control, whatever type it was. the modal wrapper already flattens
// rows and labels, so this reads a flat list rather than walking the tree.
function submittedValues(
  interaction: ComponentInteraction | ModalSubmitInteraction,
): Record<string, SubmittedValue> {
  const out: Record<string, SubmittedValue> = {};
  if (interaction.isModalSubmitInteraction()) {
    for (const component of interaction.data.components.getComponents()) {
      const node = component as { customID: string; value?: unknown; values?: unknown };
      if (typeof node.value === "string") out[node.customID] = node.value;
      // a bare checkbox submits a boolean; every step reads text, so it is
      // normalised to the same "true"/"false" a modal field would carry.
      else if (typeof node.value === "boolean") out[node.customID] = String(node.value);
      else if (Array.isArray(node.values)) {
        const strings = node.values.filter((value): value is string => typeof value === "string");
        // a file upload carries attachment ids; the step reads the first one. an id
        // alone cannot be downloaded, so it is resolved to the cdn url discord
        // already sent alongside it. an unresolved upload contributes nothing,
        // which the step reads as "no file chosen".
        out[node.customID] =
          component.type === ComponentTypes.FILE_UPLOAD
            ? resolvedAttachmentUrl(interaction, strings[0])
            : strings;
      }
    }
    return out;
  }
  if (interaction.isSelectMenuComponentInteraction()) {
    // a select submits only its own id, so there is exactly one entry. the
    // narrowing above does not reach the conditional `data` type, hence the cast.
    const data = interaction.data as { customID: string; values: { raw: string[] } };
    out[data.customID] = [...data.values.raw];
  }
  return out;
}

function surfaceFor(
  interaction: ComponentInteraction | ModalSubmitInteraction,
  responder: InteractionResponder,
): HandlerSurface {
  return {
    values: submittedValues(interaction),
    source: interaction.isModalSubmitInteraction() ? "modal" : "component",
    async reply(request) {
      const payload = v2Payload(request.message, request.ephemeral === true);
      // a fresh interaction must be answered, not followed up: reply() is what
      // decides between the initial response and a followup when it is already
      // acknowledged.
      if (request.update === true) await responder.update(interaction, payload);
      else await responder.reply(interaction, payload);
    },
    async openModal(modal) {
      await responder.openModal(interaction, modal);
    },
  };
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
    return await accessDecision(
      deps,
      identity.userId,
      identity.guildId,
      id.surface,
      identity.memberPermissions,
    );
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
      if (interaction.isAutocompleteInteraction()) {
        await runAutocomplete(interaction, deps);
        return;
      }
      // ping carries nothing to do.
    } catch (error) {
      // the one place an interaction failure is caught: an unhandled throw here
      // is a silent "the application did not respond" for the user.
      deps.log.error("interaction handler threw", { message: messageOf(error), error });
    }
  };
}

// discord asks for the choices of one option while it is being typed. the
// command that owns the option answers, and the answer is the only thing sent:
// an autocomplete interaction cannot carry a message.
async function runAutocomplete(
  interaction: AutocompleteInteraction,
  deps: InteractionDeps,
): Promise<void> {
  const guildId = interaction.guildID;
  if (guildId === null) {
    await interaction.result([]);
    return;
  }

  const focused = interaction.data.options.getFocused();
  if (focused === undefined) {
    await interaction.result([]);
    return;
  }

  const invocation = invocationOf(interaction.data.options.raw);
  const command = findCommand(deps.commands, interaction.data.name, invocation.name);
  if (command?.autocomplete === undefined) {
    await interaction.result([]);
    return;
  }

  // access is re-checked here too: a person who lost admin rights between the
  // command being registered and the typing must not see the records (rule 8).
  const access = await accessDecision(
    deps,
    interaction.user.id,
    guildId,
    "users",
    memberPermsOf(interaction),
  );
  if (access.kind !== "allow") {
    await interaction.result([]);
    return;
  }

  const choices = await command.autocomplete({
    guildId,
    userId: interaction.user.id,
    option: focused.name,
    value: String(focused.value),
  });
  // discord accepts at most 25 choices.
  await interaction.result(choices.slice(0, 25));
}

// the member's computed guild perms ride in on the interaction itself, so the
// check costs no extra REST call and never touches a cache that could lag.
function memberPermsOf(
  interaction: RespondableInteraction | AutocompleteInteraction,
): string | undefined {
  const perms = interaction.memberPermissions;
  return perms === null ? undefined : String(perms);
}

// the owner id, read from the synced guilds row: the same source the landing
// page shows it from. syncIdentity runs on guildCreate and guildUpdate, so a
// transfer lands by the next interaction, and an unknown guild reads as null
// without throwing.
async function guildOwnerId(deps: AccessDeps, guildId: string): Promise<string | undefined> {
  return (await deps.guildOwnerId(guildId)) ?? undefined;
}

async function accessDecision(
  deps: AccessDeps,
  userId: string,
  guildId: string,
  surface: string,
  memberPermissions?: string,
): Promise<AuthDecision> {
  const access = await checkAccess({
    userId,
    guildId,
    ownerId: deps.ownerId,
    guildOwnerId: await guildOwnerId(deps, guildId),
    memberPermissions,
    isGuildAdmin: async (user: string, guild: string) =>
      await deps.isGuildAdmin(user, guild, surface),
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

  const invocation = invocationOf(interaction.data.options?.raw, (id) =>
    resolvedAttachmentUrl(interaction, id),
  );
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

  const decision = await accessDecision(
    deps,
    interaction.user.id,
    guildId,
    interaction.data.name,
    memberPermsOf(interaction),
  );
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
  const outcome = await deps.router.route(
    customId,
    {
      userId: interaction.user.id,
      guildId,
      isOwner: interaction.user.id === deps.ownerId,
      memberPermissions: memberPermsOf(interaction),
    },
    surfaceFor(interaction, responder),
  );

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
