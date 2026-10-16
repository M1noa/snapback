// the step registry. one module per step, keyed by the same key WIZARD_STEPS
// uses, so a step's customID action and its settings-side key are never two
// names for the same thing (D4PLAN 10.1).

import type { StepModule } from "../deps.ts";
import { WIZARD_STEP_KEYS } from "../state.ts";
import { adminsStep } from "./admins.ts";
import { appStep } from "./app.ts";
import { backupStep } from "./backup.ts";
import { brandingStep } from "./branding.ts";
import { finishStep } from "./finish.ts";
import { logsStep } from "./logs.ts";
import { privacyStep } from "./privacy.ts";
import { restoreStep } from "./restore.ts";
import { scopesStep } from "./scopes.ts";
import { verifyStep } from "./verify.ts";
import { webStep } from "./web.ts";
import { welcomeStep } from "./welcome.ts";

export const STEP_MODULES: readonly StepModule[] = Object.freeze([
  welcomeStep,
  appStep,
  webStep,
  brandingStep,
  adminsStep,
  logsStep,
  backupStep,
  restoreStep,
  verifyStep,
  scopesStep,
  privacyStep,
  finishStep,
]);

const BY_KEY: ReadonlyMap<string, StepModule> = new Map(
  STEP_MODULES.map((module) => [module.key, module]),
);

// a step in the order table with no module is a boot failure, not a blank page
// in a live wizard, so it is checked once at import time.
for (const key of WIZARD_STEP_KEYS) {
  if (!BY_KEY.has(key)) throw new Error(`no step module registered for "${key}"`);
}

export function stepModule(key: string): StepModule | undefined {
  return BY_KEY.get(key);
}

export {
  adminsStep,
  appStep,
  backupStep,
  brandingStep,
  finishStep,
  logsStep,
  privacyStep,
  restoreStep,
  scopesStep,
  verifyStep,
  webStep,
  welcomeStep,
};
