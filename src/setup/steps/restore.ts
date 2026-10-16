// the restore-defaults wizard step (D4PLAN 10.1 #7, 12.7). three toggles: run
// the restore automatically after a backup, clear the target first, and add a
// timestamp suffix to restored messages.
//
// clear-before is destructive, so the page says so plainly. the destructive
// confirmation itself still happens at restore time on its own page, so leaving
// this on does not remove the safety net.

import type { ContainerComponent } from "oceanic.js";
import type { GuildSettings } from "../../config/defaults.ts";
import type { ContainerChild } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { checkbox } from "../../discord/components/row.ts";
import {
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

const STEP = "restore";

function idAuto(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "auto" });
}
function idClear(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "clear" });
}
function idSuffix(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: STEP, cursor: "suffix" });
}

// a checkbox contributes its value only when it is part of the submission, so a
// missing key keeps the stored setting rather than flipping it off.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  if (Array.isArray(raw) && raw.length > 0) return readBool(raw[0], fallback);
  return fallback;
}

export const restoreStep: StepModule = {
  key: STEP,

  render(ctx: StepContext): ContainerComponent {
    const s = ctx.settings;

    // checkboxes are modal controls on discord's side; the cast keeps them as
    // page controls and apply() reads the same ids.
    const sections: ContainerChild[] = [
      textDisplay(
        "**auto restore** after a successful backup, run the restore into the target guild automatically.",
      ),
      checkbox({
        id: idAuto(ctx.guildId),
        default: s.auto_restore_enabled,
      }) as unknown as ContainerChild,
      textDisplay(
        "**clear before restore** destructive: deletes the target's channels, then its roles, before writing the backup back. off by default. the destructive action still gets its own confirmation page at restore time, so leaving this on does not remove the safety net.",
      ),
      checkbox({
        id: idClear(ctx.guildId),
        default: s.restore_clear_before,
      }) as unknown as ContainerChild,
      textDisplay(
        "**timestamp suffix** append the capture time to restored messages so a re-run is distinguishable from the original.",
      ),
      checkbox({
        id: idSuffix(ctx.guildId),
        default: s.restore_message_timestamp_suffix,
      }) as unknown as ContainerChild,
    ];

    return page({
      state: "info",
      title: "restore defaults",
      sections,
    });
  },

  apply(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
    return {
      auto_restore_enabled: readBool(
        values[idAuto(ctx.guildId)],
        ctx.settings.auto_restore_enabled,
      ),
      restore_clear_before: readBool(
        values[idClear(ctx.guildId)],
        ctx.settings.restore_clear_before,
      ),
      restore_message_timestamp_suffix: readBool(
        values[idSuffix(ctx.guildId)],
        ctx.settings.restore_message_timestamp_suffix,
      ),
    };
  },
};
