// the first wizard step (D4PLAN 10.1 #0). what snapback does, then the honest
// list of what the optional verification feature captures. no reward, no nitro,
// no gift phrasing: that vocabulary is banned in this project.
//
// nothing to submit: the only control moves the cursor forward.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button } from "../../discord/components/row.ts";
import {
  SETUP_ACTION,
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  setupCustomId,
} from "../deps.ts";

export const welcomeStep: StepModule = {
  key: "welcome",

  render(ctx: StepContext): ContainerComponent {
    const next = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.nav,
      action: SETUP_ACTION.next,
    });

    return page({
      state: "info",
      title: "welcome",
      sections: [
        textDisplay(
          [
            "**snapback** is a server backup and restore tool.",
            "it captures channels, roles, permissions, emojis, stickers, scheduled events, and messages, then writes them back on demand.",
            "this wizard walks the setup once. every step can be skipped and returned to from `/setup`.",
          ].join("\n"),
        ),
        textDisplay(
          [
            "**what the optional verification feature captures**",
            "verification is off until you build a panel, so this only applies if you turn it on. when a user verifies, they share:",
            "- their discord id and username",
            "- their email address, only if the `email` scope is on",
            "- their ip address, stored one of three ways (hash, encrypted, or plaintext)",
            "- their browser user agent",
            "nothing else is needed, and verifying grants nothing extra inside the server.",
          ].join("\n"),
        ),
        textDisplay(
          "-# press continue, or use the step rail to jump ahead. required steps are marked.",
        ),
      ],
      controls: [actionRow([button({ id: next, label: "continue", style: ButtonStyles.PRIMARY })])],
    });
  },
};
