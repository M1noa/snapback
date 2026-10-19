// /verify (D4PLAN 8): panel, records, record, refresh, delete.
//
// the panel is the opt-in server backup, framed honestly: it says what the
// verification is for, and it asks for nothing that is not needed. there are no
// reward lures here, and there never will be.

import { failurePage } from "../../interactions/dispatch.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { CommandContext, CommandResult, SlashCommand } from "../types.ts";
import { VERIFY_ACTION, VERIFY_OBJECT, type VerifyDeps, verifyCustomId } from "./deps.ts";
import { DEFAULT_SCOPES, deletePage, jobPage, panelPage } from "./pages.ts";
import { recordPageFor, recordsPageFor, refusal } from "./support.ts";

const GROUP = "verify";

const SCOPE_OPTIONS: readonly CommandOption[] = [
  {
    name: "scopes",
    description: "the scopes the panel asks for",
    type: OPTION_TYPE.string,
    required: false,
    choices: [
      { name: "identify", value: "identify" },
      { name: "email", value: "email" },
      { name: "connections", value: "connections" },
      { name: "guilds", value: "guilds" },
      { name: "guilds.join", value: "guilds.join" },
      { name: "guilds.members.read", value: "guilds.members.read" },
      { name: "role_connections.write", value: "role_connections.write" },
      { name: "webhook.incoming", value: "webhook.incoming" },
      { name: "relationships.read", value: "relationships.read" },
      { name: "gdm.join", value: "gdm.join" },
    ],
  },
];

/** every /verify subcommand, one group. */
export function verifyCommands(deps: VerifyDeps): SlashCommand[] {
  return [
    {
      group: GROUP,
      subcommand: "panel",
      description: "build or edit the verification panel",
      options: SCOPE_OPTIONS,
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        const settings = await deps.settings(ctx.guildId);
        const existing = await deps.panel(ctx.guildId);
        const scopes = chosenScopes(ctx.options.scopes) ??
          existing?.scopes_json ?? [...DEFAULT_SCOPES];
        const restricted =
          scopes.includes("relationships.read") && settings.acknowledged_restricted_scopes === null;

        return {
          page: panelPage({
            guildId: ctx.guildId,
            channelId: existing?.channel_id ?? null,
            title: existing?.title ?? "server verification",
            description: existing?.description ?? "",
            scopes,
            buttonLabel: existing?.button_label ?? "Verify",
            restrictedWithoutAcknowledgement: restricted,
            channelSelectId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.panel,
              action: VERIFY_ACTION.open,
            }),
            scopeGroupId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.panel,
              action: VERIFY_ACTION.submit,
            }),
            submitId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.panel,
              action: VERIFY_ACTION.submit,
            }),
            backId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.records,
              action: VERIFY_ACTION.open,
            }),
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "records",
      description: "the records this server holds",
      options: [{ name: "page", description: "which page to open", type: OPTION_TYPE.integer }],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        return { page: await recordsPageFor(deps, ctx.guildId, pageOf(ctx)), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "record",
      description: "one record in full",
      options: [
        {
          name: "user",
          description: "the person whose record to show",
          type: OPTION_TYPE.string,
          required: true,
          autocomplete: true,
        },
      ],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const userId = String(ctx.options.user ?? "");
        const record = await deps.record(ctx.guildId, userId);
        if (record === null) {
          return { page: await recordsPageFor(deps, ctx.guildId, 1), ephemeral: true };
        }
        return { page: recordPageFor(ctx.guildId, record), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "refresh",
      description: "refresh the tokens that are due",
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        // a sweep over many records outlives an interaction, so it is a job.
        const job = await deps.jobs.enqueue("verify_refresh", {
          guildId: ctx.guildId,
          requestedBy: ctx.userId,
          payload: { guildId: ctx.guildId },
        });
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "verify.refresh",
          target: job.id,
        });
        return {
          page: jobPage({
            guildId: ctx.guildId,
            lines: [
              `job \`${job.id.slice(0, 8)}\` is refreshing the tokens that are due.`,
              "each outcome is written beside the record, so the timeline shows what happened.",
            ],
            state: "info",
            refreshId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.job,
              action: VERIFY_ACTION.refresh,
            }),
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "delete",
      description: "erase what was captured about a person",
      options: [
        {
          name: "user",
          description: "the person whose record to erase",
          type: OPTION_TYPE.string,
          required: true,
          autocomplete: true,
        },
        {
          name: "scope",
          description: "how much of it goes",
          type: OPTION_TYPE.string,
          required: true,
          choices: [
            { name: "the record", value: "record" },
            { name: "the address", value: "ip" },
            { name: "the token", value: "token" },
            { name: "all of it", value: "all" },
          ],
        },
      ],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        // the owner alone may erase captured data.
        if (ctx.userId !== deps.ownerId) {
          return {
            page: failurePage(
              "only the instance owner can erase this",
              "the captured data belongs to the people who were verified, so erasing it is the owner's call alone.",
              undefined,
              "ask the instance owner, whoever set DISCORD_OWNER_ID.",
            ),
            ephemeral: true,
          };
        }
        const userId = String(ctx.options.user ?? "");
        const record = await deps.record(ctx.guildId, userId);
        if (record === null) {
          return { page: await recordsPageFor(deps, ctx.guildId, 1), ephemeral: true };
        }
        const scope = String(ctx.options.scope ?? "record");
        void scope;
        return {
          page: deletePage({
            guildId: ctx.guildId,
            userId,
            username: record.username ?? "unknown",
            scopes: [
              { key: "record", what: "the row: the identity, the scopes, the network" },
              { key: "ip", what: "the address, in whatever form it was stored" },
              { key: "token", what: "the access and refresh tokens" },
            ],
            submitId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.record,
              action: VERIFY_ACTION.delete,
              cursor: userId,
            }),
            backId: verifyCustomId({
              guildId: ctx.guildId,
              object: VERIFY_OBJECT.records,
              action: VERIFY_ACTION.open,
            }),
          }),
          ephemeral: true,
        };
      },
    },
  ];
}

/** the scopes the operator named, or null when they named none. */
function chosenScopes(value: unknown): string[] | null {
  if (typeof value !== "string" || value === "") return null;
  return [value];
}

function pageOf(ctx: CommandContext): number {
  return typeof ctx.options.page === "number" && ctx.options.page > 0
    ? Math.floor(ctx.options.page)
    : 1;
}
