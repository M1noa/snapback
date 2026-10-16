// the web and tunnel wizard step (D4PLAN 10.1 #2, 7.4, 7.5). the public base
// url, port, tunnel flag, and proxy depth are environment, not guild settings,
// so this step renders the facts and writes nothing back.
//
// only shown when verification is on (verifyOnly in state.ts): the redirect uri
// and the ip capture only matter once a panel exists.

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

// the three deployment shapes from D4PLAN 7.5, so the operator can match their
// own setup in one line.
const DEPLOYMENTS: readonly string[] = [
  "- **cloudflare tunnel** `BEHIND_CLOUDFLARE_TUNNEL=true`, ip read from `CF-Connecting-IP`",
  "- **reverse proxy** (nginx, caddy) `BEHIND_CLOUDFLARE_TUNNEL=false`, `TRUSTED_PROXY_DEPTH=1`, ip walked from the right of `X-Forwarded-For`",
  "- **direct exposure** `BEHIND_CLOUDFLARE_TUNNEL=false`, `TRUSTED_PROXY_DEPTH=0`, ip is the socket address",
];

export const webStep: StepModule = {
  key: "web",

  async render(ctx: StepContext): Promise<ContainerComponent> {
    const { publicBaseUrl, port, behindCloudflareTunnel, trustedProxyDepth } = ctx.deps.web;
    // the one live fact: is the local socket accepting right now.
    const reachable = await ctx.deps.web.listening();
    const probe = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.nav,
      action: SETUP_ACTION.probe,
    });

    return page({
      state: reachable ? "success" : "warning",
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
            "```",
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
      ],
      controls: [actionRow([button({ id: probe, label: "probe", style: ButtonStyles.PRIMARY })])],
    });
  },
};
