// the /restore pages. the selection page, the plan, the destructive clear page,
// and the report.
//
// the selection page is one checkbox group with a box per category, prefilled
// from the guild's restore settings (D4PLAN 12.1).

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import { confirmPage } from "../../../setup/pages.ts";
import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import { actionRow, button, checkboxGroup } from "../../components/row.ts";
import { formatBytes, formatDuration, relativeTimestamp } from "../types.ts";
import { RESTORE_ACTION, RESTORE_OBJECT, restoreCustomId } from "./deps.ts";

/** the categories the operator can turn off, with what each one does. */
export const CATEGORIES: readonly { key: string; label: string; what: string }[] = [
  { key: "guild", label: "guild settings", what: "name, icon, banner, verification level, afk" },
  { key: "emojis", label: "emojis", what: "the custom emoji, up to the target's tier" },
  { key: "stickers", label: "stickers", what: "the stickers, up to the target's tier" },
  { key: "sounds", label: "soundboard", what: "the soundboard sounds" },
  { key: "roles", label: "roles", what: "every role, hierarchy included" },
  { key: "channels", label: "channels", what: "the categories and the channels" },
  { key: "overwrites", label: "permissions", what: "the per-channel permission overwrites" },
  { key: "threads", label: "threads", what: "the threads" },
  { key: "onboarding", label: "onboarding", what: "the onboarding prompts and the welcome screen" },
  { key: "automod", label: "automod", what: "the auto-moderation rules" },
  { key: "events", label: "events", what: "the scheduled events" },
  { key: "members", label: "members", what: "the roles and nicknames of the members already here" },
  { key: "bans", label: "bans", what: "the ban list" },
  { key: "messages", label: "messages", what: "the message history, replayed through a webhook" },
];

export interface SelectionPageInput {
  readonly guildId: string;
  readonly backupLabel: string;
  readonly targetLabel: string;
  /** the category keys that are on. */
  readonly enabled: readonly string[];
  readonly selectId: string;
  readonly planId: string;
  readonly submitId: string;
  readonly clearId: string;
}

/** the selection page. one box per category, the dangerous ones off by default. */
export function selectionPage(input: SelectionPageInput): ContainerComponent {
  const on = new Set(input.enabled);
  return page({
    state: "info",
    title: "what to restore",
    sections: [
      textDisplay(
        `**${input.backupLabel}** into **${input.targetLabel}**. untick what should stay as it is.`,
      ),
      textDisplay(
        "a restore is not reversible. the target guild ends up holding what the backup held, and the members the backup knows but the target does not are still missing.",
      ),
      checkboxGroup({
        id: input.selectId,
        options: CATEGORIES.map((category) => ({
          label: category.label,
          value: category.key,
          description: category.what,
          default: on.has(category.key),
        })),
      }) as unknown as ContainerComponent["components"][number],
    ],
    controls: [
      actionRow([
        button({ id: input.planId, label: "preview", style: ButtonStyles.SECONDARY }),
        button({ id: input.clearId, label: "clear target first", style: ButtonStyles.DANGER }),
      ]),
      actionRow([button({ id: input.submitId, label: "restore", style: ButtonStyles.PRIMARY })]),
    ],
  });
}

/** the plan. what would change, and nothing is written. */
export function planPage(input: {
  readonly guildId: string;
  readonly lines: readonly string[];
  readonly backId: string;
  readonly submitId: string;
}): ContainerComponent {
  return page({
    state: "info",
    title: "what the restore would do",
    sections: input.lines.map((line) => textDisplay(line)),
    controls: [
      actionRow([
        button({ id: input.backId, label: "back", style: ButtonStyles.SECONDARY }),
        button({ id: input.submitId, label: "restore", style: ButtonStyles.PRIMARY }),
      ]),
    ],
  });
}

/** the confirm page. the restore is one press away and the button carries a
 *  one-time nonce, so the press cannot be replayed. */
export function confirmRestorePage(input: {
  readonly guildId: string;
  readonly backupLabel: string;
  readonly targetLabel: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly cancelId: string;
}): ContainerComponent {
  return confirmPage({
    guildId: input.guildId,
    title: "restore this backup",
    what: `restore **${input.backupLabel}** into **${input.targetLabel}**.`,
    consequence:
      "a restore is not reversible. the target guild ends up holding what the backup held. the members the backup knows and the target does not are still missing, because a bot cannot add them.",
    nonce: input.nonce,
    cancel: input.cancelId,
    expiresAt: input.expiresAt,
    buildId: (nonce) =>
      restoreCustomId({
        guildId: input.guildId,
        object: RESTORE_OBJECT.confirm,
        action: RESTORE_ACTION.confirm,
        cursor: nonce,
      }),
  });
}

/** the destructive page. the operator types the guild name, and the confirm
 *  button carries a one-time nonce (D4PLAN 12.7). */
export function clearPage(input: {
  readonly guildId: string;
  readonly targetName: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly cancelId: string;
}): ContainerComponent {
  return confirmPage({
    guildId: input.guildId,
    title: "clear the target first",
    what: `delete every channel and every role in **${input.targetName}**, and the bans the backup holds.`,
    consequence:
      "this cannot be undone, and the messages in those channels go with them. a restore is not reversible either.",
    nonce: input.nonce,
    cancel: input.cancelId,
    expiresAt: input.expiresAt,
    buildId: (nonce) =>
      restoreCustomId({
        guildId: input.guildId,
        object: RESTORE_OBJECT.clear,
        action: RESTORE_ACTION.clear,
        cursor: nonce,
      }),
  });
}

/** the report. what each phase did, and what it could not. */
export function reportPage(input: {
  readonly guildId: string;
  readonly lines: readonly string[];
  readonly state: "success" | "warning" | "danger";
  readonly listId: string;
}): ContainerComponent {
  return page({
    state: input.state,
    title: "the restore is done",
    sections: input.lines.map((line) => textDisplay(line)),
    controls: [
      actionRow([
        button({ id: input.listId, label: "back to the backups", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** a job's page, the same shape as the backup job's. */
export function jobPage(input: {
  readonly guildId: string;
  readonly lines: readonly string[];
  readonly state: "info" | "success" | "warning" | "danger";
  readonly refreshId: string;
  readonly cancelId: string;
}): ContainerComponent {
  return page({
    state: input.state,
    title: "the restore",
    sections: input.lines.map((line) => textDisplay(line)),
    controls: [
      actionRow([
        button({ id: input.refreshId, label: "refresh", style: ButtonStyles.SECONDARY }),
        button({ id: input.cancelId, label: "cancel", style: ButtonStyles.DANGER }),
      ]),
    ],
  });
}

export { formatBytes, formatDuration, relativeTimestamp };
