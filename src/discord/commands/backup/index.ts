// /backup (D4PLAN 8, 11): create, list, info, export, delete, prune.
//
// nothing long runs here. every command that has work to do enqueues a job,
// answers with the job's page, and lets the runner do the work (AGENTS.md rule 7).
// /backup restore is deliberately absent: it hands off to /restore, which does
// not exist yet, and a command that cannot work is worse than a missing one.

import type { BackupInclude } from "../../../config/defaults.ts";
import type { BackupRow } from "../../../db/types.ts";
import { DEFAULT_RETENTION, planPrune } from "../../../services/retention/index.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { STATE_TTL_MS } from "../../interactions/state.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { AutocompleteChoice, CommandContext, CommandResult, SlashCommand } from "../types.ts";
import { BACKUP_ACTION, BACKUP_OBJECT, type BackupDeps, backupCustomId } from "./deps.ts";
import { confirmDeletePage, prunePage } from "./pages.ts";
import { infoPageFor, jobPageFor, listPageFor, lookupBackup, refusal } from "./support.ts";

const GROUP = "backup";

// the include set a create run uses: the guild's stored set with the two per-run
// overrides applied. an absent option leaves the stored value alone.
function includeFor(
  stored: BackupInclude,
  options: Readonly<Record<string, unknown>>,
): BackupInclude {
  const next: BackupInclude = { ...stored };
  if (typeof options.messages === "boolean") next.messages = options.messages;
  if (typeof options.members === "boolean") next.members = options.members;
  return next;
}

const CREATE_OPTIONS: readonly CommandOption[] = [
  {
    name: "label",
    description: "what to call this backup, so a later restore is unambiguous",
    type: OPTION_TYPE.string,
  },
  {
    name: "messages",
    description: "capture message history this time (default: this server's setting)",
    type: OPTION_TYPE.boolean,
  },
  {
    name: "members",
    description: "capture the member list this time (default: this server's setting)",
    type: OPTION_TYPE.boolean,
  },
  {
    name: "message_limit",
    description: "messages per channel for this backup, clamped to the hard ceiling",
    type: OPTION_TYPE.integer,
    min_value: 1,
    max_value: 10_000,
  },
  {
    name: "dry_run",
    description: "show what would be captured and write nothing",
    type: OPTION_TYPE.boolean,
  },
];

const BACKUP_OPTION: CommandOption = {
  name: "backup",
  description: "the backup to act on",
  type: OPTION_TYPE.string,
  required: true,
  autocomplete: true,
};

/** what a person has to type to arm a delete: the label, or the short id when
 *  there is none. compared exactly (AGENTS.md). */
export function expectedConfirm(row: BackupRow): string {
  return row.label ?? row.backup_id.slice(0, 8);
}

/** the choices for the "backup" option: this guild's backups, matched on the
 *  label and the id, newest first. an id is never typed by hand. */
async function backupChoices(
  deps: BackupDeps,
  guildId: string,
  value: string,
): Promise<AutocompleteChoice[]> {
  const rows = await deps.lookupAll(guildId);
  const needle = value.trim().toLowerCase();
  const matched = rows.filter((row) => {
    if (needle === "") return true;
    const label = (row.label ?? "").toLowerCase();
    return label.includes(needle) || row.backup_id.toLowerCase().startsWith(needle);
  });
  return matched.slice(0, 25).map((row) => ({
    name: `${row.label ?? "(no label)"} ${row.kind}`.slice(0, 100),
    value: row.backup_id,
  }));
}

/** every /backup subcommand, one group. */
export function backupCommands(deps: BackupDeps): SlashCommand[] {
  return [
    {
      group: GROUP,
      subcommand: "create",
      description: "capture this server into a new backup",
      options: CREATE_OPTIONS,
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;

        const settings = await deps.settings(ctx.guildId);
        const include = includeFor(settings.backup_include, ctx.options);
        const limit =
          typeof ctx.options.message_limit === "number"
            ? Math.min(ctx.options.message_limit, settings.auto_backup_message_count)
            : settings.auto_backup_message_count;

        if (ctx.options.dry_run === true) {
          // a dry run writes nothing: it says what would be captured, so the
          // answer is a report and not a job.
          const on = Object.entries(include)
            .filter(([, captured]) => captured)
            .map(([category]) => category);
          const off = Object.entries(include)
            .filter(([, captured]) => !captured)
            .map(([category]) => category);
          return {
            page: page({
              state: "info",
              title: "what a backup would capture",
              sections: [
                textDisplay(`**would capture:** ${on.join(", ") || "nothing"}`),
                textDisplay(`**would skip:** ${off.join(", ") || "nothing"}`),
                textDisplay(
                  `**messages per channel:** ${limit} · **message types:** ${settings.backup_message_types.join(", ")}`,
                ),
                textDisplay(
                  "a dry run writes nothing. run `/backup create` without `dry_run` to capture.",
                ),
              ],
            }),
            ephemeral: true,
          };
        }

        const job = await deps.jobs.enqueue("backup", {
          guildId: ctx.guildId,
          requestedBy: ctx.userId,
          payload: {
            label: typeof ctx.options.label === "string" ? ctx.options.label : null,
            include,
            messageLimit: limit,
          },
        });
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "backup.create",
          target: job.id,
          detail: { label: ctx.options.label ?? null, include, messageLimit: limit },
        });

        return { page: await jobPageFor(deps, ctx.guildId, job.id), ephemeral: false };
      },
    },

    {
      group: GROUP,
      subcommand: "list",
      description: "list this server's backups, newest first",
      options: [{ name: "page", description: "which page to open", type: OPTION_TYPE.integer }],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const page =
          typeof ctx.options.page === "number" && ctx.options.page > 0
            ? Math.floor(ctx.options.page)
            : 1;
        return { page: await listPageFor(deps, ctx.guildId, page), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "info",
      description: "what one backup holds, and anything its self-check flagged",
      options: [BACKUP_OPTION],
      async autocomplete(ctx) {
        return await backupChoices(deps, ctx.guildId, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const row = await lookupBackup(deps, ctx.guildId, String(ctx.options.backup ?? ""));
        if (row === null) {
          return { page: await listPageFor(deps, ctx.guildId, 1), ephemeral: true };
        }
        return { page: await infoPageFor(deps, ctx.guildId, row), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "export",
      description: "write one backup out as json",
      options: [
        BACKUP_OPTION,
        {
          name: "format",
          description: "the file format",
          type: OPTION_TYPE.string,
          choices: [{ name: "json", value: "json" }],
        },
      ],
      async autocomplete(ctx) {
        return await backupChoices(deps, ctx.guildId, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const row = await lookupBackup(deps, ctx.guildId, String(ctx.options.backup ?? ""));
        if (row === null) {
          return { page: await listPageFor(deps, ctx.guildId, 1), ephemeral: true };
        }

        // writing a large backup outlives an interaction, so it is a job like
        // everything else (rule 7).
        const job = await deps.jobs.enqueue("export", {
          guildId: ctx.guildId,
          requestedBy: ctx.userId,
          payload: { backupId: row.backup_id, format: "json" },
        });
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "backup.export",
          target: row.backup_id,
          detail: { jobId: job.id },
        });
        return { page: await jobPageFor(deps, ctx.guildId, job.id), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "delete",
      description: "delete one backup and its files",
      options: [
        BACKUP_OPTION,
        {
          name: "confirm",
          description: "type the backup's label to arm the delete",
          type: OPTION_TYPE.string,
        },
      ],
      async autocomplete(ctx) {
        return await backupChoices(deps, ctx.guildId, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const row = await lookupBackup(deps, ctx.guildId, String(ctx.options.backup ?? ""));
        if (row === null) {
          return { page: await listPageFor(deps, ctx.guildId, 1), ephemeral: true };
        }

        const typed = typeof ctx.options.confirm === "string" ? ctx.options.confirm.trim() : "";
        if (typed !== expectedConfirm(row)) {
          // the typed value did not match, so the delete is not armed: the info
          // page says what to type.
          return { page: await infoPageFor(deps, ctx.guildId, row), ephemeral: true };
        }

        // the nonce is the one-time value the confirm button carries. it lives in
        // interaction_state, never in a customID (D4PLAN 9.3).
        const nonce = await deps.state.put({
          guildId: ctx.guildId,
          userId: ctx.userId,
          surface: "backup",
          payload: { action: "delete", backupId: row.backup_id },
        });
        await deps.audit({
          guildId: ctx.guildId,
          actorUserId: ctx.userId,
          action: "backup.delete.armed",
          target: row.backup_id,
        });
        return {
          page: confirmDeletePage({
            guildId: ctx.guildId,
            backup: row,
            nonce,
            expiresAt: deps.now() + STATE_TTL_MS,
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "prune",
      description: "apply this server's retention policy",
      options: [
        {
          name: "dry_run",
          description: "show what would go and delete nothing (default)",
          type: OPTION_TYPE.boolean,
        },
      ],
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const stored = await deps.retention(ctx.guildId);
        const policy = stored ?? { ...DEFAULT_RETENTION, guild_id: ctx.guildId };
        const rows = await deps.lookupAll(ctx.guildId);
        const plan = planPrune(rows, policy, new Set(), deps.now());

        return {
          page: prunePage({
            guildId: ctx.guildId,
            policy,
            removals: plan.removals.map((removal) => ({
              label: removal.backup.label ?? removal.backup.backup_id.slice(0, 8),
              reason: removal.reason,
            })),
            keptCount: plan.kept.length,
            confirmId: backupCustomId({
              guildId: ctx.guildId,
              object: BACKUP_OBJECT.prune,
              action: BACKUP_ACTION.prune,
            }),
            policyId: backupCustomId({
              guildId: ctx.guildId,
              object: BACKUP_OBJECT.prune,
              action: BACKUP_ACTION.policy,
            }),
            listId: backupCustomId({
              guildId: ctx.guildId,
              object: BACKUP_OBJECT.list,
              action: BACKUP_ACTION.page,
              cursor: "1",
            }),
            dryRun: ctx.options.dry_run !== false,
          }),
          ephemeral: true,
        };
      },
    },
  ];
}
