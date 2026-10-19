// /restore (D4PLAN 8, 12): start, plan, status, cancel, members, messages.
//
// the selection page is where the operator chooses; the command only opens it.
// nothing long runs here: a restore is a job, and the job's page is what the
// operator watches (AGENTS.md rule 7).

import { listJobsByGuild } from "../../../db/queries/jobs.ts";
import { DEFAULT_RESTORE_OPTIONS, type RestoreOptions } from "../../../services/restore/types.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { AutocompleteChoice, CommandContext, CommandResult, SlashCommand } from "../types.ts";
import { RESTORE_ACTION, RESTORE_OBJECT, type RestoreDeps, restoreCustomId } from "./deps.ts";
import { jobPage, planPage, selectionPage } from "./pages.ts";
import { backupLabel, refusal } from "./support.ts";

const GROUP = "restore";

const BACKUP_OPTION: CommandOption = {
  name: "backup",
  description: "the backup to restore",
  type: OPTION_TYPE.string,
  required: true,
  autocomplete: true,
};

const TARGET_OPTION: CommandOption = {
  name: "target_guild",
  description: "the guild to restore into",
  type: OPTION_TYPE.string,
  required: true,
  autocomplete: true,
};

/** the categories that are on by default. the dangerous one is off. */
function defaultCategories(): string[] {
  return [
    "guild",
    "emojis",
    "stickers",
    "sounds",
    "roles",
    "channels",
    "overwrites",
    "threads",
    "onboarding",
    "automod",
    "events",
    "members",
    "bans",
    "messages",
  ];
}

async function backupChoices(
  deps: RestoreDeps,
  guildId: string,
  value: string,
): Promise<AutocompleteChoice[]> {
  const rows = await deps.backups(guildId);
  const needle = value.trim().toLowerCase();
  return rows
    .filter((row) => {
      if (needle === "") return true;
      const label = (row.label ?? "").toLowerCase();
      return label.includes(needle) || row.backup_id.toLowerCase().startsWith(needle);
    })
    .slice(0, 25)
    .map((row) => ({
      name: `${row.label ?? "(no label)"} ${row.kind}`.slice(0, 100),
      value: row.backup_id,
    }));
}

async function targetChoices(deps: RestoreDeps, value: string): Promise<AutocompleteChoice[]> {
  const needle = value.trim().toLowerCase();
  const guilds = await deps.guilds();
  return guilds
    .filter((guild) => needle === "" || (guild.name ?? "").toLowerCase().includes(needle))
    .slice(0, 25)
    .map((guild) => ({ name: (guild.name ?? guild.id).slice(0, 100), value: guild.id }));
}

export function restoreCommands(deps: RestoreDeps): SlashCommand[] {
  return [
    {
      group: GROUP,
      subcommand: "start",
      description: "restore a backup into a guild, category by category",
      options: [BACKUP_OPTION, TARGET_OPTION],
      async autocomplete(ctx) {
        return ctx.option === "backup"
          ? await backupChoices(deps, ctx.guildId, ctx.value)
          : await targetChoices(deps, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const backupId = String(ctx.options.backup ?? "");
        const targetId = String(ctx.options.target_guild ?? "");
        const row = await deps.lookup(ctx.guildId, backupId);
        if (row === null) {
          return { page: await notFoundPage(), ephemeral: true };
        }
        const target = (await deps.guilds()).find((guild) => guild.id === targetId);

        return {
          page: selectionPage({
            guildId: ctx.guildId,
            backupLabel: backupLabel(row),
            targetLabel: target?.name ?? targetId,
            enabled: defaultCategories(),
            // the checkbox group and the submit button carry one id, so the
            // ticked categories and the press arrive together.
            selectId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            planId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.plan,
              action: RESTORE_ACTION.plan,
            }),
            submitId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            clearId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.clear,
              action: RESTORE_ACTION.open,
            }),
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "plan",
      description: "show what a restore would change, and write nothing",
      options: [BACKUP_OPTION, TARGET_OPTION],
      async autocomplete(ctx) {
        return ctx.option === "backup"
          ? await backupChoices(deps, ctx.guildId, ctx.value)
          : await targetChoices(deps, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const row = await deps.lookup(ctx.guildId, String(ctx.options.backup ?? ""));
        if (row === null) {
          return { page: await notFoundPage(), ephemeral: true };
        }
        const settings = await deps.settings(ctx.guildId);
        const options: RestoreOptions = {
          ...DEFAULT_RESTORE_OPTIONS,
          clearBefore: settings.restore_clear_before,
          timestampSuffix: settings.restore_message_timestamp_suffix,
        };
        const plan = (await deps.plan(row.backup_id, options)) as {
          phases?: readonly { phase: string; ops: readonly { what: string; count: number }[] }[];
        };
        const lines: string[] = [];
        for (const phase of plan.phases ?? []) {
          for (const op of phase.ops) lines.push(`**${phase.phase}** ${op.what} (${op.count})`);
        }
        if (lines.length === 0) lines.push("this backup holds nothing to restore.");

        return {
          page: planPage({
            guildId: ctx.guildId,
            lines,
            backId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            submitId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "status",
      description: "how the last restore in this server is going",
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        return { page: await statusPageFor(deps, ctx.guildId), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "cancel",
      description: "stop the restore that is running",
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        return { page: await cancelPageFor(deps, ctx.guildId), ephemeral: true };
      },
    },

    {
      group: GROUP,
      subcommand: "members",
      description: "restore only the members' roles and nicknames",
      options: [BACKUP_OPTION, TARGET_OPTION],
      async autocomplete(ctx) {
        return ctx.option === "backup"
          ? await backupChoices(deps, ctx.guildId, ctx.value)
          : await targetChoices(deps, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const row = await deps.lookup(ctx.guildId, String(ctx.options.backup ?? ""));
        if (row === null) {
          return { page: await notFoundPage(), ephemeral: true };
        }
        return {
          page: selectionPage({
            guildId: ctx.guildId,
            backupLabel: backupLabel(row),
            targetLabel: String(ctx.options.target_guild ?? ""),
            enabled: ["members"],
            // the checkbox group and the submit button carry one id, so the
            // ticked categories and the press arrive together.
            selectId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            planId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.plan,
              action: RESTORE_ACTION.plan,
            }),
            submitId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            clearId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.clear,
              action: RESTORE_ACTION.open,
            }),
          }),
          ephemeral: true,
        };
      },
    },

    {
      group: GROUP,
      subcommand: "messages",
      description: "replay only the message history",
      options: [BACKUP_OPTION, TARGET_OPTION],
      async autocomplete(ctx) {
        return ctx.option === "backup"
          ? await backupChoices(deps, ctx.guildId, ctx.value)
          : await targetChoices(deps, ctx.value);
      },
      async run(ctx: CommandContext): Promise<CommandResult> {
        const denied = await refusal(deps, ctx);
        if (denied !== null) return denied;
        const row = await deps.lookup(ctx.guildId, String(ctx.options.backup ?? ""));
        if (row === null) {
          return { page: await notFoundPage(), ephemeral: true };
        }
        return {
          page: selectionPage({
            guildId: ctx.guildId,
            backupLabel: backupLabel(row),
            targetLabel: String(ctx.options.target_guild ?? ""),
            enabled: ["messages"],
            // the checkbox group and the submit button carry one id, so the
            // ticked categories and the press arrive together.
            selectId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            planId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.plan,
              action: RESTORE_ACTION.plan,
            }),
            submitId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.confirm,
              action: RESTORE_ACTION.submit,
            }),
            clearId: restoreCustomId({
              guildId: ctx.guildId,
              object: RESTORE_OBJECT.clear,
              action: RESTORE_ACTION.open,
            }),
          }),
          ephemeral: true,
        };
      },
    },
  ];
}

/** the backup the operator named is not in this guild, or is gone. */
function notFoundPage() {
  return failurePage(
    "no such backup",
    "that backup is not one of this server's, or it has been deleted since.",
    undefined,
    "run `/restore start` again and pick one of the backups listed.",
  );
}

/** the last restore job in this guild, and where it got to. */
async function statusPageFor(deps: RestoreDeps, guildId: string) {
  const jobs = (await listJobsByGuild(deps.db, guildId)).filter((job) => job.kind === "restore");
  const latest = jobs[0];
  if (latest === undefined) {
    return jobPage({
      guildId,
      lines: ["no restore has run in this server yet."],
      state: "info",
      refreshId: restoreCustomId({
        guildId,
        object: RESTORE_OBJECT.job,
        action: RESTORE_ACTION.refresh,
      }),
      cancelId: restoreCustomId({
        guildId,
        object: RESTORE_OBJECT.job,
        action: RESTORE_ACTION.cancel,
      }),
    });
  }
  return jobPage({
    guildId,
    lines: [
      `job \`${latest.id.slice(0, 8)}\` · ${latest.status}`,
      latest.error_code === null
        ? "no error"
        : `**${latest.error_code}** ${latest.error_body ?? ""}`,
    ],
    state:
      latest.status === "failed" ? "danger" : latest.status === "succeeded" ? "success" : "info",
    refreshId: restoreCustomId({
      guildId,
      object: RESTORE_OBJECT.job,
      action: RESTORE_ACTION.refresh,
    }),
    cancelId: restoreCustomId({
      guildId,
      object: RESTORE_OBJECT.job,
      action: RESTORE_ACTION.cancel,
    }),
  });
}

/** stop the restore that is running. */
async function cancelPageFor(deps: RestoreDeps, guildId: string) {
  const jobs = (await listJobsByGuild(deps.db, guildId)).filter((job) => job.kind === "restore");
  const running = jobs.find(
    (job) => job.status === "queued" || job.status === "running" || job.status === "paused",
  );
  if (running === undefined) {
    return jobPage({
      guildId,
      lines: ["no restore is running in this server."],
      state: "info",
      refreshId: restoreCustomId({
        guildId,
        object: RESTORE_OBJECT.job,
        action: RESTORE_ACTION.refresh,
      }),
      cancelId: restoreCustomId({
        guildId,
        object: RESTORE_OBJECT.job,
        action: RESTORE_ACTION.cancel,
      }),
    });
  }
  await deps.jobs.cancel(running.id);
  await deps.audit({
    guildId,
    actorUserId: "unknown",
    action: "restore.cancel",
    target: running.id,
  });
  return jobPage({
    guildId,
    lines: [`job \`${running.id.slice(0, 8)}\` is stopping at its next checkpoint.`],
    state: "warning",
    refreshId: restoreCustomId({
      guildId,
      object: RESTORE_OBJECT.job,
      action: RESTORE_ACTION.refresh,
    }),
    cancelId: restoreCustomId({
      guildId,
      object: RESTORE_OBJECT.job,
      action: RESTORE_ACTION.cancel,
    }),
  });
}
