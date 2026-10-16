// the wizard chrome: the rail and the navigation row that every step page carries
// (D4PLAN 9.2 "every surface has the same shape", 10.1).
//
// a step renders its own body through page(), and page() refuses to exceed the 40
// component cap. the chrome is the one caller that adds to an already built tree,
// so it re-runs the count itself: a wizard page that overflows must fail loudly,
// because truncating it would drop the navigation and strand the operator.

import type { ContainerComponent } from "oceanic.js";
import { ButtonStyles } from "oceanic.js";
import type { WizardState } from "../config/defaults.ts";
import { relativeTimestamp } from "../discord/commands/types.ts";
import { separator, textDisplay } from "../discord/components/fields.ts";
import { countComponents, PAGE_LIMIT, page } from "../discord/components/page.ts";
import { actionRow, button } from "../discord/components/row.ts";
import { SETUP_ACTION, SETUP_OBJECT, setupCustomId } from "./deps.ts";
import { findStep, isHandled, stepState, WIZARD_STEPS } from "./state.ts";

export interface WizardChromeInput {
  readonly guildId: string;
  readonly stepKey: string;
  readonly wizard: WizardState;
  /** the step's own page, built by page(). */
  readonly body: ContainerComponent;
}

/** how many steps are done, skipped, and still open, in one short line. */
export function railLine(wizard: WizardState, stepKey: string): string {
  const step = findStep(stepKey);
  const position = step === undefined ? 1 : step.index + 1;
  let done = 0;
  let skipped = 0;
  for (const entry of WIZARD_STEPS) {
    if (!isHandled(wizard, entry)) continue;
    if (stepState(wizard, entry.key).skipped) skipped += 1;
    else done += 1;
  }
  const left = WIZARD_STEPS.length - done - skipped;
  const parts = [`step ${position} of ${WIZARD_STEPS.length}`, `${done} done`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  parts.push(left === 0 ? "nothing left" : `${left} left`);
  return `-# ${parts.join(" · ")}`;
}

/** the navigation row: back, forward, skip, and the way to the hub. skip is
 *  disabled on a step the wizard insists on before it can finish. */
export function navRow(guildId: string, stepKey: string, required: boolean) {
  const at = (action: string) =>
    setupCustomId({ guildId, object: SETUP_OBJECT.nav, action, cursor: stepKey });
  return actionRow([
    button({ id: at(SETUP_ACTION.prev), label: "back", style: ButtonStyles.SECONDARY }),
    button({ id: at(SETUP_ACTION.next), label: "next", style: ButtonStyles.PRIMARY }),
    button({
      id: at(SETUP_ACTION.skip),
      label: "skip for now",
      style: ButtonStyles.SECONDARY,
      disabled: required,
    }),
    button({
      id: setupCustomId({ guildId, object: SETUP_OBJECT.nav, action: SETUP_ACTION.status }),
      label: "setup status",
      style: ButtonStyles.SECONDARY,
    }),
  ]);
}

/** the step's page with the rail and the navigation row appended. */
export function withWizardChrome(input: WizardChromeInput): ContainerComponent {
  const { guildId, stepKey, wizard, body } = input;
  const step = findStep(stepKey);
  const children = [
    ...body.components,
    separator({ divider: true }),
    textDisplay(railLine(wizard, stepKey)),
    navRow(guildId, stepKey, step?.required ?? true),
  ];
  const tree: ContainerComponent = { ...body, components: children };
  const total = countComponents(tree);
  if (total > PAGE_LIMIT) {
    throw new Error(
      `setup: step "${stepKey}" renders ${total} components, over the ${PAGE_LIMIT} cap`,
    );
  }
  return tree;
}

export interface ConfirmInput {
  readonly guildId: string;
  readonly title: string;
  /** what is about to happen, in the operator's words. */
  readonly what: string;
  /** what it costs when it happens. */
  readonly consequence: string;
  /** the object and action the confirm button runs. */
  readonly object: (typeof SETUP_OBJECT)[keyof typeof SETUP_OBJECT];
  readonly action: string;
  /** a one-time value minted for this page (D4PLAN 9.4). */
  readonly nonce: string;
  /** where "cancel" goes back to, as an already built customID. */
  readonly cancel: string;
  readonly expiresAt: number;
}

/** the second page every destructive action gets. the trigger is never on the
 *  same page as its confirm button, and the confirm carries a one-time nonce and
 *  an expiry (D4PLAN 9.4). */
export function confirmPage(input: ConfirmInput): ContainerComponent {
  const confirmId = setupCustomId({
    guildId: input.guildId,
    object: input.object,
    action: input.action,
    cursor: input.nonce,
  });
  return page({
    state: "danger",
    title: input.title,
    sections: [
      textDisplay(input.what),
      textDisplay(input.consequence),
      textDisplay(`-# this confirmation expires ${relativeTimestamp(input.expiresAt)}`),
    ],
    controls: [
      actionRow([
        button({ id: confirmId, label: "yes, do it", style: ButtonStyles.DANGER }),
        button({ id: input.cancel, label: "cancel", style: ButtonStyles.SECONDARY }),
      ]),
    ],
  });
}

/** one page of "here is what I found", for a subcommand that only reports. */
export function reportPage(
  title: string,
  lines: readonly string[],
  state: "info" | "success" | "warning" | "danger" = "info",
): ContainerComponent {
  return page({ state, title, sections: lines.map((line) => textDisplay(line)) });
}
