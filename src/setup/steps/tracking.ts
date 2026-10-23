// the timeline wizard step (D4PLAN 19.5). two switches and one number.
//
// the split between them is the whole point: `history` is state anyone with the
// member list could already look up, `palantir` is what someone did. they are
// separate settings so an operator can keep a record of a server without keeping
// a record of its people, and the copy says which is which without dressing it up.
//
// the page never reads the database: a step module is a pure renderer plus a
// validator, so the row count lives on `/users` and not here.

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
import { clampInt } from "../../lib/validate.ts";
import {
  SETUP_OBJECT,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

const STEP = "tracking";

// the modal-open control and the button that opens it share one id; the input
// carries the cursor apply() reads.
function idOpen(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP });
}
function idKeep(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "keep" });
}
function idHistory(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "history" });
}
function idPalantir(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "palantir" });
}

// a checkbox contributes its value only when it is part of the submission, so a
// missing key keeps the stored setting rather than flipping it off.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  if (Array.isArray(raw) && raw.length > 0) return readBool(raw[0], fallback);
  return fallback;
}

function describeKeep(days: number | null): string {
  if (days === null) return "kept until you delete it";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export const trackingStep: StepModule = {
  key: STEP,

  render(ctx: StepContext): ContainerComponent {
    const t = ctx.settings.tracking;
    const keep = LIMITS.tracking_keep_days;

    const sections: ContainerChild[] = [
      textDisplay(
        [
          `**timeline** ${t.history || t.palantir ? "recording" : "off"}`,
          `history: ${t.history ? "on" : "off"}`,
          `behaviour: ${t.palantir ? "on" : "off"}`,
          `keep for: ${describeKeep(t.keep_days)}`,
        ].join("\n"),
      ),
      textDisplay(
        "one row per change, never one row per person. message text and attachment bytes are never recorded: a deleted message leaves a row saying it was deleted, not what it said.",
      ),
      textDisplay(
        "**history** member joins and leaves, roles, nicknames, usernames, avatars, boosts, timeouts, and changes to the guild, its channels, roles, emoji and stickers. this is what anyone with the member list could already look up.",
      ),
      checkbox({
        id: idHistory(ctx.guildId),
        default: t.history,
      }) as unknown as ContainerChild,
      textDisplay(
        "**behaviour** voice joins, leaves and moves; message deletes and edits; bans; blacklist changes; pull attempts. this is what people did, so it is off until you ask for it.",
      ),
      checkbox({
        id: idPalantir(ctx.guildId),
        default: t.palantir,
      }) as unknown as ContainerChild,
      textDisplay(
        `**retention** ${describeKeep(t.keep_days)}. set ${keep.min} to ${keep.max} days, or leave it blank to keep everything. this is separate from your backup retention: 400 backups and 30 days of timeline is a fine combination.`,
      ),
    ];

    return page({
      state: "info",
      title: "timeline",
      sections,
      controls: [
        actionRow([
          button({ id: idOpen(ctx.guildId), label: "set retention", style: ButtonStyles.PRIMARY }),
        ]),
      ],
    });
  },

  modal(ctx: StepContext): { title: string; components: ModalComponent[] } {
    const keep = LIMITS.tracking_keep_days;
    const built = modal({
      id: idOpen(ctx.guildId),
      title: "how long to keep the timeline",
      components: [
        label({
          label: "days to keep",
          description: `blank keeps everything, otherwise ${keep.min}-${keep.max}`,
          component: textInput({
            id: idKeep(ctx.guildId),
            style: TextInputStyles.SHORT,
            required: false,
            value:
              ctx.settings.tracking.keep_days === null
                ? ""
                : String(ctx.settings.tracking.keep_days),
          }),
        }),
      ],
    });
    return { title: built.title, components: built.components };
  },

  apply(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
    const t = ctx.settings.tracking;
    const raw = values[idKeep(ctx.guildId)];
    const field = Array.isArray(raw) ? raw[0] : raw;

    // an absent key is not part of this submission; an empty one is an answer,
    // and that answer is "keep everything".
    let keep_days: number | null = t.keep_days;
    if (field !== undefined) {
      const text = typeof field === "string" ? field.trim() : "";
      if (text === "") {
        keep_days = null;
      } else {
        keep_days = clampInt(text, LIMITS.tracking_keep_days);
        if (keep_days === null) {
          throw new SetupInputError(
            "tracking.keep_days",
            `days to keep must be a whole number between ${LIMITS.tracking_keep_days.min} and ${LIMITS.tracking_keep_days.max}, or blank to keep everything.`,
          );
        }
      }
    }

    return {
      tracking: {
        history: readBool(values[idHistory(ctx.guildId)], t.history),
        palantir: readBool(values[idPalantir(ctx.guildId)], t.palantir),
        keep_days,
      },
    };
  },
};
