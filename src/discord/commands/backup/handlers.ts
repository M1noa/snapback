// the /backup controls. one handler per (surface, action); the object slot is not
// part of that key, so one handler serves every object reporting the same verb
// and dispatches on the object (the same shape the setup surface uses).
//
// the router re-checks access on every press, so a control rendered for an admin
// last week fails closed today (AGENTS.md rule 8). a handler here still checks
// the nonce's owner: a confirmation minted for someone else is not theirs.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { TextInputStyles } from "oceanic.js";
import { purgeBackup } from "../../../db/queries/backup-purge.ts";
import { getJob } from "../../../db/queries/jobs.ts";
import { clampInt } from "../../../lib/validate.ts";
import { applyPrune, DEFAULT_RETENTION, planPrune } from "../../../services/retention/index.ts";
import { label, textInput } from "../../components/row.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { Handler, HandlerContext, HandlerResult, Router } from "../../interactions/router.ts";
import { STATE_TTL_MS } from "../../interactions/state.ts";
import {
  BACKUP_ACTION,
  BACKUP_OBJECT,
  BACKUP_SURFACE,
  type BackupDeps,
  backupCustomId,
} from "./deps.ts";
import { confirmDeletePage, prunePage } from "./pages.ts";
import { infoPageFor, jobPageFor, listPageFor, lookupBackup } from "./support.ts";

async function answer(ctx: HandlerContext, message: ContainerLike): Promise<HandlerResult> {
  await ctx.surface.reply({ message, ephemeral: true, update: true });
  return { kind: "reply" };
}

type ContainerLike = Parameters<HandlerContext["surface"]["reply"]>[0]["message"];

/** the list, on a page number carried in the cursor. */
function listHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const pageNumber = Number.parseInt(ctx.id.cursor, 10);
    const page = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    return await answer(ctx, await listPageFor(deps, ctx.id.guild, page));
  };
}

/** the list again, with a fresh read. */
function refreshHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    // the job page carries a job id in the same slot, and both report under the
    // same verb, so the object slot says which one this is.
    if (ctx.id.object === BACKUP_OBJECT.job) {
      return await answer(ctx, await jobPageFor(deps, ctx.id.guild, ctx.id.cursor));
    }
    const pageNumber = Number.parseInt(ctx.id.cursor, 10);
    const page = Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1;
    return await answer(ctx, await listPageFor(deps, ctx.id.guild, page));
  };
}

/** a backup was picked from the list. the value carries the id, the id carries
 *  nothing: a selection payload never goes in a customID (D4PLAN 9.3). */
function selectHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const submitted = ctx.surface.values[ctx.id.raw];
    const backupId = Array.isArray(submitted) ? (submitted[0] ?? "") : (submitted ?? "");
    const row = await lookupBackup(deps, ctx.id.guild, backupId);
    if (row === null) {
      return await answer(ctx, failurePage("that backup is gone", "it was deleted or pruned."));
    }
    return await answer(ctx, await infoPageFor(deps, ctx.id.guild, row));
  };
}

/** the delete button on the info page: it mints a one-time nonce and shows the
 *  destructive page. the delete itself is the confirm handler's job. */
function deleteHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const row = await lookupBackup(deps, ctx.id.guild, ctx.id.cursor);
    if (row === null) {
      return await answer(ctx, failurePage("that backup is gone", "it was deleted or pruned."));
    }
    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: BACKUP_SURFACE,
      payload: { action: "delete", backupId: row.backup_id },
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "backup.delete.armed",
      target: row.backup_id,
    });
    return await answer(
      ctx,
      confirmDeletePage({
        guildId: ctx.id.guild,
        backup: row,
        nonce,
        expiresAt: deps.now() + STATE_TTL_MS,
      }),
    );
  };
}

/** the confirm button. the nonce decides what happens, and it is one-time. */
function confirmHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation expired",
          "confirmations live for 15 minutes, and this one is gone.",
          undefined,
          "press the button again to get a fresh confirmation.",
        ),
      );
    }
    // one press, one delete: the row goes before the write, so a double press
    // cannot delete twice.
    await deps.state.delete(ctx.id.cursor);

    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage(
          "that confirmation is not yours",
          "it was minted for a different user or server, so it will not be used.",
          undefined,
          "press the button again to get a fresh confirmation.",
        ),
      );
    }

    const payload = nonce.payload as { action?: unknown; backupId?: unknown };
    if (payload.action === "prune") {
      const stored = await deps.retention(ctx.id.guild);
      const policy = stored ?? { ...DEFAULT_RETENTION, guild_id: ctx.id.guild };
      const rows = await deps.lookupAll(ctx.id.guild);
      const plan = planPrune(rows, policy, new Set(), deps.now());
      const applied = await applyPrune(deps.db, plan, deps.backupDir);
      await deps.audit({
        guildId: ctx.id.guild,
        actorUserId: ctx.identity.userId,
        action: "backup.prune",
        target: "policy",
        detail: { removed: applied.removed.length, failed: applied.failed.length },
      });
      return await answer(
        ctx,
        prunePage({
          guildId: ctx.id.guild,
          policy,
          removals: applied.removed.map((row) => ({
            label: row.label ?? row.backup_id.slice(0, 8),
            reason: "removed",
          })),
          keptCount: plan.kept.length,
          confirmId: backupCustomId({
            guildId: ctx.id.guild,
            object: BACKUP_OBJECT.prune,
            action: BACKUP_ACTION.prune,
          }),
          policyId: backupCustomId({
            guildId: ctx.id.guild,
            object: BACKUP_OBJECT.prune,
            action: BACKUP_ACTION.policy,
          }),
          listId: backupCustomId({
            guildId: ctx.id.guild,
            object: BACKUP_OBJECT.list,
            action: BACKUP_ACTION.page,
            cursor: "1",
          }),
          dryRun: false,
        }),
      );
    }

    const backupId = typeof payload.backupId === "string" ? payload.backupId : "";
    const row = await lookupBackup(deps, ctx.id.guild, backupId);
    if (row === null) {
      return await answer(ctx, failurePage("that backup is gone", "it was deleted or pruned."));
    }
    await rm(join(deps.backupDir, row.backup_id), { recursive: true, force: true });
    await purgeBackup(deps.db, row.backup_id);
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "backup.delete",
      target: row.backup_id,
    });
    return await answer(ctx, await listPageFor(deps, ctx.id.guild, 1));
  };
}

/** the prune page's button: it mints the nonce the confirm button carries. */
function pruneHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const stored = await deps.retention(ctx.id.guild);
    const policy = stored ?? { ...DEFAULT_RETENTION, guild_id: ctx.id.guild };
    const rows = await deps.lookupAll(ctx.id.guild);
    const plan = planPrune(rows, policy, new Set(), deps.now());
    if (plan.removals.length === 0) {
      return await answer(
        ctx,
        prunePage({
          guildId: ctx.id.guild,
          policy,
          removals: [],
          keptCount: plan.kept.length,
          confirmId: backupCustomId({
            guildId: ctx.id.guild,
            object: BACKUP_OBJECT.prune,
            action: BACKUP_ACTION.prune,
          }),
          policyId: backupCustomId({
            guildId: ctx.id.guild,
            object: BACKUP_OBJECT.prune,
            action: BACKUP_ACTION.policy,
          }),
          listId: backupCustomId({
            guildId: ctx.id.guild,
            object: BACKUP_OBJECT.list,
            action: BACKUP_ACTION.page,
            cursor: "1",
          }),
          dryRun: true,
        }),
      );
    }
    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: BACKUP_SURFACE,
      payload: { action: "prune" },
    });
    return await answer(
      ctx,
      prunePage({
        guildId: ctx.id.guild,
        policy,
        removals: plan.removals.map((removal) => ({
          label: removal.backup.label ?? removal.backup.backup_id.slice(0, 8),
          reason: removal.reason,
        })),
        keptCount: plan.kept.length,
        confirmId: backupCustomId({
          guildId: ctx.id.guild,
          object: BACKUP_OBJECT.del,
          action: BACKUP_ACTION.confirm,
          cursor: nonce,
        }),
        policyId: backupCustomId({
          guildId: ctx.id.guild,
          object: BACKUP_OBJECT.prune,
          action: BACKUP_ACTION.policy,
        }),
        listId: backupCustomId({
          guildId: ctx.id.guild,
          object: BACKUP_OBJECT.list,
          action: BACKUP_ACTION.page,
          cursor: "1",
        }),
        dryRun: false,
      }),
    );
  };
}

// the policy's numbers, and the range each one accepts. two numbers, so they
// live in the modal rather than a page of their own.
const KEEP_DAYS = { min: 1, max: 3650 } as const;
const KEEP_COUNT = { min: 1, max: 500 } as const;

/** the modal's field read, trimmed. a select row can come back as an array. */
function typed(ctx: HandlerContext, id: string): string {
  const value = ctx.surface.values[id];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

/** the retention policy: the button opens the modal, the submit stores the
 *  numbers and shows the plan again. blank means no rule, not zero. */
function policyHandler(deps: BackupDeps): Handler {
  const base = (guildId: string, cursor: string) =>
    backupCustomId({
      guildId,
      object: BACKUP_OBJECT.prune,
      action: BACKUP_ACTION.policy,
      cursor,
    });

  return async (ctx) => {
    const guildId = ctx.id.guild;

    if (ctx.surface.source !== "modal") {
      const stored = await deps.retention(guildId);
      const policy = stored ?? { ...DEFAULT_RETENTION, guild_id: guildId };
      await ctx.surface.openModal({
        customID: base(guildId, ""),
        title: "what this server keeps",
        components: [
          label({
            label: "keep for (days)",
            description: `anything older than this goes. blank = no age rule. ${KEEP_DAYS.min}-${KEEP_DAYS.max}`,
            component: textInput({
              id: base(guildId, "days"),
              style: TextInputStyles.SHORT,
              required: false,
              maxLength: 4,
              value: policy.keep_days === null ? undefined : String(policy.keep_days),
            }),
          }),
          label({
            label: "keep the newest",
            description: `only the newest N stay. blank = no count rule. ${KEEP_COUNT.min}-${KEEP_COUNT.max}`,
            component: textInput({
              id: base(guildId, "count"),
              style: TextInputStyles.SHORT,
              required: false,
              maxLength: 3,
              value: policy.keep_count === null ? undefined : String(policy.keep_count),
            }),
          }),
        ],
      });
      return { kind: "reply" };
    }

    const fields = [
      { key: "days", label: "keep for", range: KEEP_DAYS },
      { key: "count", label: "keep the newest", range: KEEP_COUNT },
    ] as const;
    const numbers: Record<string, number | null> = {};
    for (const field of fields) {
      const raw = typed(ctx, base(guildId, field.key));
      if (raw === "") {
        numbers[field.key] = null;
        continue;
      }
      const value = clampInt(raw, { min: field.range.min, max: field.range.max });
      if (value === null) {
        return await answer(
          ctx,
          failurePage(
            "that value does not fit",
            `**${field.label}** has to be a whole number between ${field.range.min} and ${field.range.max}. nothing was written.`,
            undefined,
            "press set the policy, fix the number, and submit again.",
          ),
        );
      }
      numbers[field.key] = value;
    }

    const keepDays = numbers.days ?? null;
    const keepCount = numbers.count ?? null;
    await deps.saveRetention({
      guild_id: guildId,
      keep_days: keepDays,
      keep_count: keepCount,
      // every kind is in scope: a kind filter needs a checkbox group, which a
      // modal cannot hold (D4PLAN 17.2).
      keep_kind_json: null,
      enabled: keepDays !== null || keepCount !== null,
    });
    await deps.audit({
      guildId,
      actorUserId: ctx.identity.userId,
      action: "backup.retention",
      target: guildId,
      detail: { keepDays, keepCount },
    });
    // the plan against the numbers that were just stored, so the press that set
    // them also shows what they would remove.
    return await pruneHandler(deps)(ctx);
  };
}

/** the export button on the info page: a job, because writing a large backup
 *  outlives an interaction (rule 7). */ function exportHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const row = await lookupBackup(deps, ctx.id.guild, ctx.id.cursor);
    if (row === null) {
      return await answer(ctx, failurePage("that backup is gone", "it was deleted or pruned."));
    }
    const job = await deps.jobs.enqueue("export", {
      guildId: ctx.id.guild,
      requestedBy: ctx.identity.userId,
      payload: { backupId: row.backup_id, format: "json" },
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "backup.export",
      target: row.backup_id,
      detail: { jobId: job.id },
    });
    return await answer(ctx, await jobPageFor(deps, ctx.id.guild, job.id));
  };
}

/** pause, or resume when it is already paused. */
function pauseHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const jobId = ctx.id.cursor;
    const job = await getJob(deps.db, jobId);
    if (job === null) {
      return await answer(ctx, failurePage("that job is gone", "the job row is not there."));
    }
    if (job.status === "paused") await deps.jobs.resume(jobId);
    else await deps.jobs.pause(jobId);
    return await answer(ctx, await jobPageFor(deps, ctx.id.guild, jobId));
  };
}

/** cancel. the runner stops the handler at its next checkpoint. */
function cancelHandler(deps: BackupDeps): Handler {
  return async (ctx) => {
    const jobId = ctx.id.cursor;
    await deps.jobs.cancel(jobId);
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "backup.job.cancel",
      target: jobId,
    });
    return await answer(ctx, await jobPageFor(deps, ctx.id.guild, jobId));
  };
}

/** every control on the /backup surface gets a handler, or the boot stops. */
export function registerBackupHandlers(router: Router, deps: BackupDeps): void {
  router.register(BACKUP_SURFACE, BACKUP_ACTION.page, listHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.refresh, refreshHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.select, selectHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.delete, deleteHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.confirm, confirmHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.prune, pruneHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.policy, policyHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.export, exportHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.pause, pauseHandler(deps));
  router.register(BACKUP_SURFACE, BACKUP_ACTION.cancel, cancelHandler(deps));
}
