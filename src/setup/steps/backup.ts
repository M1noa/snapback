// the backup-defaults wizard step (D4PLAN 10.1 #6, 6.1). turns scheduled
// capture on, sets the interval and the per-backup message ceiling, and turns
// the join notice on. all four are per-guild settings_json values, not env.
//
// the two ceilings are edited from a modal so a typed number goes through
// clampInt; the two toggles are checkboxes on the page.

import {
  ButtonStyles,
  type ContainerComponent,
  type ModalComponent,
  TextInputStyles,
} from "oceanic.js";
import { type GuildSettings, LIMITS } from "../../config/defaults.ts";
import type { ContainerChild } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import {
  actionRow,
  button,
  checkbox,
  label,
  modal,
  textInput,
} from "../../discord/components/row.ts";
import { clampInt, type Range } from "../../lib/validate.ts";
import {
  SETUP_OBJECT,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

const STEP = "backup";

// the modal-open control and the modal itself share one id; the two text inputs
// carry their own cursors, which apply() reads.
function idOpen(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP });
}
function idInterval(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "interval" });
}
function idCount(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "count" });
}
function idAuto(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "auto" });
}
function idNotify(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "notify" });
}

// a checkbox contributes its value only when it is part of the submission, so a
// missing key keeps the stored setting rather than flipping it off.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  if (Array.isArray(raw) && raw.length > 0) return readBool(raw[0], fallback);
  return fallback;
}

// a number from a modal is a string; clampInt rejects an empty or non-numeric
// answer (null), which we turn into an actionable error. an absent key is not
// part of this submission, so the stored value stands.
function readNumber(raw: unknown, field: string, range: Range, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const clamped = clampInt(value, range);
  if (clamped === null) {
    throw new SetupInputError(
      field,
      `${field} must be a whole number between ${range.min} and ${range.max}.`,
    );
  }
  return clamped;
}

export const backupStep: StepModule = {
  key: STEP,

  render(ctx: StepContext): ContainerComponent {
    const s = ctx.settings;
    const interval = LIMITS.auto_backup_interval_hours;
    const count = LIMITS.auto_backup_message_count;

    // checkboxes are modal controls on discord's side; the cast keeps them as
    // page controls and apply() reads the same ids.
    const sections: ContainerChild[] = [
      textDisplay(
        [
          "**these are per-guild.** every server the bot is in keeps its own schedule, kept in `settings_json`.",
          `**interval** is in hours (${interval.min}-${interval.max}). **message count** is a per-backup ceiling (${count.min}-${count.max}); the \`.env\` hard limits (\`MAX_MESSAGES_PER_CHANNEL\`, \`MAX_MESSAGES_TOTAL\`) still cap it.`,
        ].join("\n"),
      ),
      textDisplay(
        [
          `auto backup: ${s.auto_backup_enabled ? "on" : "off"}`,
          `interval: ${s.auto_backup_interval_hours} h`,
          `messages per backup: ${s.auto_backup_message_count}`,
          `notify on join: ${s.notify_on_join ? "on" : "off"}`,
        ].join("\n"),
      ),
      textDisplay("**auto backup** run a capture on the interval below."),
      checkbox({
        id: idAuto(ctx.guildId),
        default: s.auto_backup_enabled,
      }) as unknown as ContainerChild,
      textDisplay("**tell me when someone joins** post a notice when a member joins."),
      checkbox({
        id: idNotify(ctx.guildId),
        default: s.notify_on_join,
      }) as unknown as ContainerChild,
    ];

    return page({
      state: "info",
      title: "backup defaults",
      sections,
      controls: [
        actionRow([
          button({ id: idOpen(ctx.guildId), label: "set limits", style: ButtonStyles.PRIMARY }),
        ]),
      ],
    });
  },

  modal(ctx: StepContext): { title: string; components: ModalComponent[] } {
    const interval = LIMITS.auto_backup_interval_hours;
    const count = LIMITS.auto_backup_message_count;
    const built = modal({
      id: idOpen(ctx.guildId),
      title: "backup limits",
      components: [
        label({
          label: "interval (hours)",
          description: `whole hours, ${interval.min}-${interval.max}`,
          component: textInput({
            id: idInterval(ctx.guildId),
            style: TextInputStyles.SHORT,
            required: false,
            value: String(ctx.settings.auto_backup_interval_hours),
          }),
        }),
        label({
          label: "messages per backup",
          description: `per-backup ceiling, ${count.min}-${count.max}`,
          component: textInput({
            id: idCount(ctx.guildId),
            style: TextInputStyles.SHORT,
            required: false,
            value: String(ctx.settings.auto_backup_message_count),
          }),
        }),
      ],
    });
    return { title: built.title, components: built.components };
  },

  apply(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
    return {
      auto_backup_enabled: readBool(values[idAuto(ctx.guildId)], ctx.settings.auto_backup_enabled),
      notify_on_join: readBool(values[idNotify(ctx.guildId)], ctx.settings.notify_on_join),
      auto_backup_interval_hours: readNumber(
        values[idInterval(ctx.guildId)],
        "auto_backup_interval_hours",
        LIMITS.auto_backup_interval_hours,
        ctx.settings.auto_backup_interval_hours,
      ),
      auto_backup_message_count: readNumber(
        values[idCount(ctx.guildId)],
        "auto_backup_message_count",
        LIMITS.auto_backup_message_count,
        ctx.settings.auto_backup_message_count,
      ),
    };
  },
};
