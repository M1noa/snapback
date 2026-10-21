// the verification policy step (wizard step 9, D4PLAN 14.4). two rules, both off
// until the owner turns them on: the network rule, which refuses a verification
// from a vpn, a hosting provider or a tor exit, and the alt check, which compares
// a verification with the accounts this server already holds.
//
// one page, two choices. a select submits the moment it is picked, so there is no
// save button to forget.

import type { ContainerComponent } from "oceanic.js";
import {
  ALT_POLICIES,
  type GuildSettings,
  type VerifyAltPolicy,
  type VerifyVpnPolicy,
  VPN_POLICIES,
} from "../../config/defaults.ts";
import { separator, textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, stringSelect } from "../../discord/components/row.ts";
import {
  SETUP_OBJECT,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

const STEP_KEY = "policy";

// what each choice does, in the words the operator needs. the label is the value
// itself, so the page and the stored setting never drift apart.
const VPN_CHOICES: readonly { value: VerifyVpnPolicy; description: string }[] = [
  { value: "off", description: "any network may verify" },
  { value: "block", description: "refuse a vpn, a hosting provider or a tor exit" },
];
const ALT_CHOICES: readonly { value: VerifyAltPolicy; description: string }[] = [
  { value: "off", description: "keep no signals and compare nothing" },
  { value: "flag", description: "keep the signals and show a match on the record" },
  { value: "block", description: "refuse a verification that looks like another account here" },
];

/** a control on this step submits under the step's own action, so the router
 *  sends it to this step's apply. */
function policyId(guildId: string, field: "vpn" | "alt"): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.policy, action: STEP_KEY, cursor: field });
}

/** the first value of a select, when it is one of the allowed ones. */
function policyOf<T extends string>(
  raw: string | readonly string[] | undefined,
  allowed: readonly T[],
  current: T,
): T {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return current;
  return (allowed as readonly string[]).includes(value) ? (value as T) : current;
}

function render(ctx: StepContext): ContainerComponent {
  const guildId = ctx.guildId;
  const settings = ctx.settings;

  return page({
    state: "info",
    title: "verification policy",
    sections: [
      textDisplay(
        [
          "**when a verification is refused**",
          `- network \`${settings.verify_vpn_policy}\` · alt check \`${settings.verify_alt_policy}\``,
          "",
          "the network rule reads the local geo files: the asn, the asn org, and whether the range belongs to a hosting provider. it never calls out and never sees an address it was not given.",
          "the alt check keeps a digest of the device, the address, the email, the avatar and the name, and compares a new verification with the accounts already in this server. a match inside one server is never compared against another server.",
          "a refused verification says why on the record page and never names the account it matched.",
        ].join("\n"),
      ),
      separator({ divider: true }),
      textDisplay(
        "-# both rules are off until you pick one. an alt match flags the record; only a strong match refuses the verification (D4PLAN 14.4).",
      ),
    ],
    controls: [
      actionRow([
        stringSelect({
          id: policyId(guildId, "vpn"),
          placeholder: "network rule",
          options: VPN_CHOICES.map((choice) => ({
            label: choice.value,
            value: choice.value,
            description: choice.description,
            default: settings.verify_vpn_policy === choice.value,
          })),
          minValues: 1,
          maxValues: 1,
        }),
      ]),
      actionRow([
        stringSelect({
          id: policyId(guildId, "alt"),
          placeholder: "alt check",
          options: ALT_CHOICES.map((choice) => ({
            label: choice.value,
            value: choice.value,
            description: choice.description,
            default: settings.verify_alt_policy === choice.value,
          })),
          minValues: 1,
          maxValues: 1,
        }),
      ]),
    ],
  });
}

function apply(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
  const guildId = ctx.guildId;
  return {
    verify_vpn_policy: policyOf(
      values[policyId(guildId, "vpn")],
      VPN_POLICIES,
      ctx.settings.verify_vpn_policy,
    ),
    verify_alt_policy: policyOf(
      values[policyId(guildId, "alt")],
      ALT_POLICIES,
      ctx.settings.verify_alt_policy,
    ),
  };
}

export const policyStep: StepModule = {
  key: STEP_KEY,
  render,
  apply,
};
