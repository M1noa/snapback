// the web and tunnel wizard step (D4PLAN 10.1 #2, 7.4, 7.5). the public base
// url, port, tunnel flag, and proxy depth are environment, not guild settings,
// so this step renders the facts of those and edits the one thing that is a
// guild setting: the name the verification pages show.
//
// only shown when verification is on (verifyOnly in state.ts): the redirect uri
// and the ip capture only matter once a panel exists.

import {
  ButtonStyles,
  type ContainerComponent,
  type ModalComponent,
  TextInputStyles,
} from "oceanic.js";
import { type GuildSettings, readGuildSettings } from "../../config/defaults.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button, label, textInput } from "../../discord/components/row.ts";
import {
  SETUP_ACTION,
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

// the three deployment shapes from D4PLAN 7.5, so the operator can match their
// own setup in one line.
const DEPLOYMENTS: readonly string[] = [
  "- **cloudflare tunnel** `BEHIND_CLOUDFLARE_TUNNEL=true`, ip read from `CF-Connecting-IP`",
  "- **reverse proxy** (nginx, caddy) `BEHIND_CLOUDFLARE_TUNNEL=false`, `TRUSTED_PROXY_DEPTH=1`, ip walked from the right of `X-Forwarded-For`",
  "- **direct exposure** `BEHIND_CLOUDFLARE_TUNNEL=false`, `TRUSTED_PROXY_DEPTH=0`, ip is the socket address",
];

const NAME_LIMIT = 100;

function stepId(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: "web" });
}

// the modal's one field, in the shape the branding step uses for its inputs:
// the step key is the action slot and the cursor only names the field.
function nameField(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: "web", cursor: "name" });
}

export const webStep: StepModule = {
  key: "web",

  async render(ctx: StepContext): Promise<ContainerComponent> {
    const { publicBaseUrl, port, behindCloudflareTunnel, trustedProxyDepth } = ctx.deps.web;
    const { ipStorage, tokenStorage } = ctx.deps.privacy;
    // the one live fact: is the local socket accepting right now.
    const reachable = await ctx.deps.web.listening();
    // plaintext is legal and bad: the page says so instead of staying green
    // (D4PLAN 14.5).
    const storage =
      ipStorage === "hash"
        ? 'a salted hash. it answers "same person again" and never shows an address.'
        : ipStorage === "encrypted"
          ? "encrypted with `ENCRYPTION_KEY`, readable by this bot only."
          : "**plaintext**. anyone who opens the database reads every address, and that is personal data you are responsible for.";
    const probe = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.nav,
      action: SETUP_ACTION.probe,
    });
    const stored = ctx.settings.web_display_name;

    return page({
      state: reachable && ipStorage !== "plaintext" ? "success" : "warning",
      title: "web and tunnel",
      sections: [
        textDisplay(
          [
            "**where the bot is reachable** these are environment values, set in `.env`, not here. discord has to reach this url for the oauth redirect and the verify button to work.",
            `- public base url: \`${publicBaseUrl}\``,
            `- port: \`${port}\``,
            `- behind cloudflare tunnel: \`${behindCloudflareTunnel}\``,
            `- trusted proxy depth: \`${trustedProxyDepth}\``,
          ].join("\n"),
        ),
        textDisplay(
          [
            "**https is required.** discord refuses a redirect uri that is not `https`, so a plain `http://localhost` redirect will not register.",
            "**the tunnel mode changes how the client ip is read.** behind cloudflare the only trustworthy source is `CF-Connecting-IP`; without the flag the proxy address is captured instead.",
            "**a bare localhost deployment captures `::1` for every user.** every record then shows the same loopback address, which silently ruins the whole record set and makes every vpn check look identical.",
          ].join("\n"),
        ),
        textDisplay(
          [
            "**edit these lines in `.env`, then restart the bot.** none of them reload without a restart:",
            "```",
            `PUBLIC_BASE_URL=${publicBaseUrl}`,
            `PORT=${port}`,
            `BEHIND_CLOUDFLARE_TUNNEL=${behindCloudflareTunnel}`,
            `TRUSTED_PROXY_DEPTH=${trustedProxyDepth}`,
            `IP_STORAGE=${ipStorage}`,
            "```",
          ].join("\n"),
        ),
        textDisplay(
          [
            "**how a captured ip is stored** `IP_STORAGE` is read once at boot and is the same for every server on this instance, so a change applies to new records only. old rows keep the form they were written in.",
            `- captured ip: ${storage}`,
            tokenStorage
              ? "- tokens: encrypted at rest with `ENCRYPTION_KEY`."
              : "- **no `ENCRYPTION_KEY`** so nothing can be encrypted: `/pull` and token refresh are off.",
          ].join("\n"),
        ),
        textDisplay(["**match your deployment** (D4PLAN 7.5)", ...DEPLOYMENTS].join("\n")),
        textDisplay(
          reachable
            ? "**local socket** accepting, the bot is listening on its port."
            : [
                "**local socket** nothing is accepting on the port.",
                "start the bot (`bun run dev`) or fix `PORT`, then press probe again.",
              ].join("\n"),
        ),
        textDisplay(
          [
            "**the name on the verification pages** the default is the server's own name, which the bot keeps current from discord. a value stored here overrides it on the landing page and the results.",
            stored !== null
              ? `display name: \`${stored}\``
              : "display name: not stored, the server's own name",
          ].join("\n"),
        ),
      ],
      controls: [
        actionRow([
          button({
            id: stepId(ctx.guildId),
            label: "edit the page name",
            style: ButtonStyles.SECONDARY,
          }),
        ]),
        actionRow([button({ id: probe, label: "probe", style: ButtonStyles.PRIMARY })]),
      ],
    });
  },

  modal(ctx: StepContext): { title: string; components: ModalComponent[] } {
    return {
      title: "the page name",
      components: [
        label({
          label: "display name",
          description: "blank = the server's own name, as discord has it",
          component: textInput({
            id: nameField(ctx.guildId),
            style: TextInputStyles.SHORT,
            maxLength: NAME_LIMIT,
            required: false,
            value: ctx.settings.web_display_name ?? undefined,
          }),
        }),
      ],
    };
  },

  // bound and validated again by the reader in config/defaults.ts; blank is a
  // removed override, not an empty name.
  async apply(ctx: StepContext, values: StepValues): Promise<Partial<GuildSettings>> {
    const raw = values[nameField(ctx.guildId)];
    return { web_display_name: readGuildSettings({ web_display_name: raw }).web_display_name };
  },
};
