// the setup wizard state machine (D4PLAN 10).
//
// the step order is data, not a chain of ifs: a step knows its key, whether it is
// required to finish, and whether it only applies when verification is enabled.
// every transition is a pure function over the stored WizardState, so resuming is
// just a read and a partial setup is a supported state rather than a broken one.

import type { GuildSettings, WizardState, WizardStepState } from "../config/defaults.ts";
import { DEFAULT_WIZARD } from "../config/defaults.ts";

export interface WizardStep {
  /** the 0-10 index from D4PLAN 10.1. */
  readonly index: number;
  /** stable key: it is the customID action and the settings_json key. */
  readonly key: string;
  readonly title: string;
  /** a step the wizard insists on before `wizard.done_at` is written. */
  readonly required: boolean;
  /** skipped entirely unless the operator has turned verification on. */
  readonly verifyOnly: boolean;
  readonly summary: string;
}

export const WIZARD_STEPS: readonly WizardStep[] = Object.freeze([
  {
    index: 0,
    key: "welcome",
    title: "welcome",
    required: true,
    verifyOnly: false,
    summary: "what snapback does, and what the verification feature captures",
  },
  {
    index: 1,
    key: "app",
    title: "app check",
    required: true,
    verifyOnly: false,
    summary: "token, owner id, gateway, and the privileged intent",
  },
  {
    index: 2,
    key: "web",
    title: "web and tunnel",
    required: false,
    verifyOnly: true,
    summary: "public base url, port, the live ip probe, and the page name",
  },
  {
    index: 3,
    key: "branding",
    title: "branding",
    required: false,
    verifyOnly: false,
    summary: "bot avatar, banner, and display name",
  },
  {
    index: 4,
    key: "admins",
    title: "admins",
    required: false,
    verifyOnly: false,
    summary: "who else may change settings",
  },
  {
    index: 5,
    key: "logs",
    title: "logging",
    required: false,
    verifyOnly: false,
    summary: "log channel and event families",
  },
  {
    index: 6,
    key: "backup",
    title: "backup defaults",
    required: false,
    verifyOnly: false,
    summary: "include set, message limits, auto-backup schedule",
  },
  {
    index: 7,
    key: "restore",
    title: "restore defaults",
    required: false,
    verifyOnly: false,
    summary: "clear-before, timestamp suffix, default selections",
  },
  {
    index: 8,
    key: "verify",
    title: "verification panel",
    required: false,
    verifyOnly: true,
    summary: "the panel, its colour, and its buttons",
  },
  {
    index: 9,
    key: "policy",
    title: "verification policy",
    required: false,
    verifyOnly: true,
    summary: "when a verification is refused: the network rule and the alt check",
  },
  {
    index: 10,
    key: "scopes",
    title: "scopes",
    required: false,
    verifyOnly: true,
    summary: "what the verification asks for, and why",
  },
  {
    index: 11,
    key: "finish",
    title: "finish",
    required: true,
    verifyOnly: false,
    summary: "the invite link, the command list, and the docs pointer",
  },
]);

export const WIZARD_STEP_KEYS: readonly string[] = Object.freeze(
  WIZARD_STEPS.map((step) => step.key),
);

export function findStep(key: string): WizardStep | undefined {
  return WIZARD_STEPS.find((step) => step.key === key);
}

export function stepAt(index: number): WizardStep | undefined {
  return WIZARD_STEPS.find((step) => step.index === index);
}

const NOT_DONE: WizardStepState = Object.freeze({ done: false, skipped: false, at: null });

export function stepState(wizard: WizardState, key: string): WizardStepState {
  return wizard.steps[key] ?? NOT_DONE;
}

/** a step counts as handled when it was finished or explicitly skipped. */
export function isHandled(wizard: WizardState, step: WizardStep): boolean {
  const state = stepState(wizard, step.key);
  return state.done || state.skipped;
}

// verification is opt-in, so the three steps that only exist to serve it are not
// required until the operator has turned it on. the panel is the switch: building
// one is what enables the feature, and the scopes live inside it.
export function verificationEnabled(settings: GuildSettings): boolean {
  return settings.verify_panel !== null;
}

/** the steps an operator still has to deal with, in order. */
export function pendingSteps(settings: GuildSettings): WizardStep[] {
  const verify = verificationEnabled(settings);
  return WIZARD_STEPS.filter((step) => {
    if (step.verifyOnly && !verify) return false;
    return !isHandled(settings.wizard, step);
  });
}

/** the step `/setup` opens at, and the step "next" walks to from anywhere. */
export function firstOpenStep(settings: GuildSettings): WizardStep {
  const pending = pendingSteps(settings);
  return pending[0] ?? WIZARD_STEPS[WIZARD_STEPS.length - 1]!;
}

/** back to the previous step in the fixed order, clamped at the first. */
export function previousStep(key: string): WizardStep {
  const current = findStep(key);
  if (!current) return WIZARD_STEPS[0]!;
  return stepAt(current.index - 1) ?? WIZARD_STEPS[0]!;
}

/** forward in the fixed order, clamped at the last. */
export function nextStep(key: string): WizardStep {
  const current = findStep(key);
  const last = WIZARD_STEPS[WIZARD_STEPS.length - 1]!;
  if (!current) return WIZARD_STEPS[0]!;
  return stepAt(current.index + 1) ?? last;
}

export type StepOutcome = "done" | "skipped" | "reopened";

export interface MarkOptions {
  readonly now: string; // iso, injected so the transition stays pure
}

/** records a step outcome and moves the cursor. pure: returns a new state. */
export function markStep(
  wizard: WizardState,
  key: string,
  outcome: StepOutcome,
  options: MarkOptions,
): WizardState {
  const previous = stepState(wizard, key);
  const state: WizardStepState =
    outcome === "done"
      ? { done: true, skipped: false, at: options.now }
      : outcome === "skipped"
        ? { done: false, skipped: true, at: options.now }
        : { done: false, skipped: previous.skipped, at: previous.at };

  return {
    ...wizard,
    current: outcome === "reopened" ? key : nextStep(key).key,
    steps: { ...wizard.steps, [key]: state },
    started_at: wizard.started_at ?? options.now,
    // editing a step after the wizard finished keeps it finished; reopening a
    // step means the operator is working through the wizard again.
    done_at: outcome === "reopened" ? null : wizard.done_at,
  };
}

/** the finish step writes this: the wizard is complete and stays complete. */
export function completeWizard(wizard: WizardState, now: string): WizardState {
  const updated = markStep(wizard, "finish", "done", { now });
  return {
    ...updated,
    current: "finish",
    done_at: now,
  };
}

export function isComplete(settings: GuildSettings): boolean {
  return pendingSteps(settings).length === 0;
}

export { DEFAULT_WIZARD };
