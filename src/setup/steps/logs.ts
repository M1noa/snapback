// the logging wizard step (D4PLAN 10.1 #5, 16). picks the log channel, the
// event families to record, and offers a test fire. the test fire itself is a
// handler the integrator owns; this step only produces its custom id and never
// imports the log module.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import { type GuildSettings, LOG_EVENT_FAMILIES } from "../../config/defaults.ts";
import type { ContainerChild } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button, channelSelect, checkboxGroup } from "../../discord/components/row.ts";
import { snowflake } from "../../lib/validate.ts";
import {
  SETUP_ACTION,
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

// what each family carries, shown under its checkbox (D4PLAN 16).
const FAMILY_WHAT: Readonly<Record<string, string>> = {
  lifecycle: "bot started and stopped, gateway reconnect and resume, shard ready",
  backup: "started, finished with counts, failed with the parsed error, pruned",
  restore: "started, the per-category report, failed, cancelled, cleared a guild",
  verify: "verification completed, revoked, refreshed, panel created or edited",
  pull: "run started and finished, account restricted or released, guild full",
  admin: "admin added or removed, permission changed, destructive action confirmed",
  error: "anything unhandled",
};

function idChannel(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.log,
    action: SETUP_ACTION.toggle,
    cursor: "channel",
  });
}

function idFamilies(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.log,
    action: SETUP_ACTION.toggle,
    cursor: "families",
  });
}

function idTestfire(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.log,
    action: SETUP_ACTION.testfire,
  });
}

export const logsStep: StepModule = {
  key: "logs",

  render(ctx: StepContext): ContainerComponent {
    const channel = ctx.settings.log_channel_id;
    const enabled = ctx.settings.log_events;

    // a checkbox group is a modal control on discord's side, but the page child
    // union here predates its type; the cast keeps it as a page control and
    // apply() reads the same id either way.
    const families = checkboxGroup({
      id: idFamilies(ctx.guildId),
      options: LOG_EVENT_FAMILIES.map((family) => ({
        label: family,
        value: family,
        description: FAMILY_WHAT[family],
        default: enabled.includes(family),
      })),
    });

    const sections: ContainerChild[] = [
      textDisplay(
        [
          `**log channel** ${channel ? `<#${channel}>` : "not set"}`,
          `**families on** ${enabled.length > 0 ? enabled.join(", ") : "none"}`,
        ].join("\n"),
      ),
      textDisplay(
        "**event families** toggle the families to post. each event is one components-v2 container, coloured by severity. a missing channel or lost permissions disables a family rather than breaking the action that logged.",
      ),
      families as unknown as ContainerChild,
    ];

    return page({
      state: "info",
      title: "logging",
      sections,
      controls: [
        actionRow([
          channelSelect({ id: idChannel(ctx.guildId), placeholder: "pick the log channel" }),
        ]),
        actionRow([
          button({
            id: idTestfire(ctx.guildId),
            label: "test fire",
            style: ButtonStyles.SECONDARY,
          }),
        ]),
      ],
    });
  },

  apply(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
    // the channel select and the family checkboxes are two controls on one page,
    // so either can arrive alone: a key that is not part of this submission keeps
    // the stored value rather than clearing it.
    const channelRaw = values[idChannel(ctx.guildId)];
    const channel =
      channelRaw === undefined
        ? ctx.settings.log_channel_id
        : // snowflake() returns null for anything that is not a digit string, so a
          // bad selection clears the channel rather than being stored as a number.
          snowflake(channelRaw);

    const familyRaw = values[idFamilies(ctx.guildId)];
    const log_events =
      familyRaw === undefined
        ? ctx.settings.log_events
        : (Array.isArray(familyRaw) ? familyRaw : []).filter(
            (family): family is string =>
              typeof family === "string" &&
              (LOG_EVENT_FAMILIES as readonly string[]).includes(family),
          );

    return { log_channel_id: channel, log_events };
  },
};
