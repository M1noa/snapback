// the app-check wizard step (D4PLAN 7.3, 7.6, 10.1 #1). reads the application
// facts and the developer-panel checklist, and renders the exact strings the
// operator has to paste. makes no discord call of its own: everything comes from
// the injected facts.
//
// owner resolution is compared against the application the api reported, which
// is the one check these facts can settle without a user lookup.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button } from "../../discord/components/row.ts";
import {
  type PortalItem,
  SETUP_ACTION,
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  setupCustomId,
} from "../deps.ts";

// the intents D4PLAN 7.1 asks for, with the one privileged toggle called out.
const INTENTS: readonly string[] = [
  "`GUILDS`",
  "`GUILD_MEMBERS` (privileged, toggle in the Developer Panel)",
  "`GUILD_MODERATION`",
  "`GUILD_EMOJIS_AND_STICKERS`",
  "`GUILD_VOICE_STATES`",
  "`GUILD_SCHEDULED_EVENTS`",
  "`GUILD_MESSAGES`",
  "`GUILD_MESSAGE_REACTIONS` (reaction capture, off by default)",
];

// pass/fail/unknown, padded so the checklist reads as a column.
function mark(done: boolean | null): string {
  return done === true ? "pass   " : done === false ? "fail   " : "unknown";
}

// one line per item, plus the item's fix when it is not passing.
function checklist(items: readonly PortalItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`${mark(item.done)}  ${item.index}. ${item.title}`);
    if (item.done !== true && item.fix) lines.push(`         -# ${item.fix}`);
  }
  return lines.join("\n");
}

export const appStep: StepModule = {
  key: "app",

  async render(ctx: StepContext): Promise<ContainerComponent> {
    const test = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.app,
      action: SETUP_ACTION.test,
    });

    const app = await ctx.deps.app.application();
    const configuredOwner = ctx.deps.app.ownerId;
    const redirect = `${ctx.deps.web.publicBaseUrl}/callback`;

    const ownerLine =
      app.id === null
        ? `**owner** \`${configuredOwner}\` could not be checked, the application lookup returned nothing`
        : app.ownerId === configuredOwner
          ? `**owner** \`${configuredOwner}\` matches the application owner`
          : `**owner** \`${configuredOwner}\` does not match the application owner (\`${app.ownerId}\`)`;

    const items = await ctx.deps.portal.items();
    const invite = ctx.deps.portal.invite();

    const failed = items.some((item) => item.done === false);
    const unresolved = app.id === null || items.some((item) => item.done === null);
    const state = failed ? "danger" : unresolved ? "warning" : "success";

    return page({
      state,
      title: "app check",
      sections: [
        textDisplay(
          [
            `**application** \`${app.name ?? "unknown"}\` (\`${app.id ?? "unknown"}\`)`,
            ownerLine,
          ].join("\n"),
        ),
        textDisplay(
          [
            "**redirect uri** paste this exact string in the Developer Panel, OAuth2 > Redirects:",
            "```",
            redirect,
            "```",
          ].join("\n"),
        ),
        textDisplay(
          [
            "**gateway intents** request exactly these, no more:",
            ...INTENTS.map((i) => `- ${i}`),
            "`GUILD_PRESENCES` is not requested, nothing here needs it.",
          ].join("\n"),
        ),
        textDisplay(
          [
            "**interactions endpoint** not used. this bot is gateway only, so leave it empty.",
            'a stale endpoint here makes every command fail with a silent `401` and "the application did not respond".',
            "**public key** irrelevant for a gateway client, skip it.",
          ].join("\n"),
        ),
        textDisplay(`**developer panel checklist**\n${checklist(items)}`),
        textDisplay(["**invite url** open this to add the bot:", "```", invite, "```"].join("\n")),
      ],
      controls: [
        actionRow([button({ id: test, label: "run self test", style: ButtonStyles.PRIMARY })]),
      ],
    });
  },
};
