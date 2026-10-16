// admins: who else may change settings (D4PLAN 10.1 #4, section 8).
//
// the add and remove work is the handler's, through AdminStore: this step only
// renders the list and mints the ids. there is no apply(), because a select or a
// button applies immediately. the destructive confirmation is a separate page
// with a one-time nonce, owned by the shared chrome (D4PLAN 9.4), so it is not
// built here.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import type { ContainerChild } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button, userSelect } from "../../discord/components/row.ts";
import {
  type AdminEntry,
  SETUP_ACTION,
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  setupCustomId,
} from "../deps.ts";

// the five grantable flags, with the short word a line shows. order is the order
// AdminStore returns them in, so the reading is stable.
const FLAGS = [
  ["canBackup", "backup"],
  ["canRestore", "restore"],
  ["canManageAdmins", "admins"],
  ["canViewRecords", "records"],
  ["canDeleteRecords", "delete"],
] as const;

function flagWords(entry: AdminEntry): string {
  const granted = FLAGS.filter(([key]) => entry.flags[key]).map(([, word]) => word);
  if (granted.length === FLAGS.length) return "all";
  if (granted.length === 0) return "none";
  return granted.join(", ");
}

function adminLine(entry: AdminEntry): string {
  const by = entry.addedBy ? `added by <@${entry.addedBy}>` : "added by the instance owner";
  return `<@${entry.userId}> - ${by} - flags: ${flagWords(entry)}`;
}

export const adminsStep: StepModule = {
  key: "admins",

  async render(ctx: StepContext): Promise<ContainerComponent> {
    const admins = await ctx.deps.admins.list(ctx.guildId);
    const sections: ContainerChild[] = [
      textDisplay(
        "admins can drive this wizard and change settings for this server. the instance owner always has access.",
      ),
    ];

    if (admins.length === 0) {
      sections.push(textDisplay("no admins yet - add one below."));
    } else {
      sections.push(textDisplay(admins.map(adminLine).join("\n")));
    }

    sections.push(
      textDisplay(
        "a new admin gets every flag. per-flag grants are coming with `/admin`, so this step only adds and removes.",
      ),
    );
    if (admins.length > 4) {
      sections.push(
        textDisplay("showing removal for the first four; remove the rest from `/setup admins`."),
      );
    }

    // discord allows one select per row and up to five buttons in another, so
    // adds live on the select, and "add me" plus the removals share a button row.
    const removals = admins.slice(0, 4).map((admin) =>
      button({
        id: setupCustomId({
          guildId: ctx.guildId,
          object: SETUP_OBJECT.admin,
          action: SETUP_ACTION.remove,
          cursor: admin.userId,
        }),
        label: "remove",
        style: ButtonStyles.SECONDARY,
      }),
    );

    return page({
      state: "info",
      title: "admins",
      sections,
      controls: [
        actionRow([
          userSelect({
            id: setupCustomId({
              guildId: ctx.guildId,
              object: SETUP_OBJECT.admin,
              action: SETUP_ACTION.add,
            }),
            placeholder: "add an admin",
            minValues: 1,
            maxValues: 1,
          }),
        ]),
        actionRow([
          button({
            id: setupCustomId({
              guildId: ctx.guildId,
              object: SETUP_OBJECT.admin,
              action: SETUP_ACTION.add,
              cursor: ctx.userId,
            }),
            label: "add me",
            style: ButtonStyles.PRIMARY,
          }),
          ...removals,
        ]),
      ],
    });
  },
};
