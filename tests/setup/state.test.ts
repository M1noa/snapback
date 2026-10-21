import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_VERIFY_PANEL,
  type GuildSettings,
  readGuildSettings,
} from "../../src/config/defaults.ts";
import {
  completeWizard,
  findStep,
  firstOpenStep,
  isComplete,
  isHandled,
  markStep,
  nextStep,
  pendingSteps,
  previousStep,
  stepState,
  verificationEnabled,
  WIZARD_STEP_KEYS,
  WIZARD_STEPS,
  type WizardStep,
} from "../../src/setup/state.ts";

const NOW = "2026-10-16T12:00:00.000Z";

function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...patch } as GuildSettings;
}

function withVerification(settings_: GuildSettings): GuildSettings {
  return {
    ...settings_,
    verify_panel: { ...DEFAULT_VERIFY_PANEL, channel_id: "123456789012345678" },
  };
}

/** every step handled, in the fixed order. */
function everythingHandled(base: GuildSettings): GuildSettings {
  let wizard = base.wizard;
  for (const step of WIZARD_STEPS) wizard = markStep(wizard, step.key, "done", { now: NOW });
  return { ...base, wizard };
}

describe("the step table", () => {
  test("twelve steps, in order, with unique keys and indices", () => {
    expect(WIZARD_STEPS.length).toBe(12);
    expect(WIZARD_STEP_KEYS.length).toBe(12);
    expect(new Set(WIZARD_STEP_KEYS).size).toBe(12);
    for (const [index, step] of WIZARD_STEPS.entries()) {
      expect(step.index).toBe(index);
    }
  });

  test("every step carries a title and a summary to render", () => {
    for (const step of WIZARD_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.summary.length).toBeGreaterThan(0);
    }
  });

  test("the three required steps are the ones D4PLAN 10.1 marks required", () => {
    const required = WIZARD_STEPS.filter((step) => step.required).map((step) => step.key);
    expect(required).toEqual(["welcome", "app", "finish"]);
  });

  test("only the verify steps are verify-only", () => {
    const verifyOnly = WIZARD_STEPS.filter((step) => step.verifyOnly).map((step) => step.key);
    expect(verifyOnly).toEqual(["web", "verify", "policy", "scopes"]);
  });

  test("findStep is exact, not a substring match", () => {
    expect(findStep("web")?.index).toBe(2);
    expect(findStep("we")).toBeUndefined();
    expect(findStep("")).toBeUndefined();
  });
});

describe("pending steps", () => {
  test("a fresh install does not owe the verification steps", () => {
    const pending = pendingSteps(settings()).map((step) => step.key);
    expect(pending.includes("web")).toBe(false);
    expect(pending.includes("verify")).toBe(false);
    expect(pending.includes("scopes")).toBe(false);
    expect(pending.length).toBe(8);
  });

  test("turning verification on adds the three it needs", () => {
    const pending = pendingSteps(withVerification(settings())).map((step) => step.key);
    expect(pending).toContain("web");
    expect(pending).toContain("verify");
    expect(pending).toContain("policy");
    expect(pending).toContain("scopes");
    expect(pending.length).toBe(12);
  });

  test("the panel is what turns verification on", () => {
    expect(verificationEnabled(withVerification(settings()))).toBe(true);
    expect(verificationEnabled(settings())).toBe(false);
  });

  test("a skipped step is handled, and drops out of the list", () => {
    const wizard = markStep(settings().wizard, "branding", "skipped", { now: NOW });
    const pending = pendingSteps(settings({ wizard })).map((step) => step.key);
    expect(pending).not.toContain("branding");
    expect(isHandled(wizard, findStep("branding") as WizardStep)).toBe(true);
  });
});

describe("firstOpenStep", () => {
  test("opens at welcome on a fresh install", () => {
    expect(firstOpenStep(settings()).key).toBe("welcome");
  });

  test("resumes at the first thing still outstanding", () => {
    let wizard = settings().wizard;
    wizard = markStep(wizard, "welcome", "done", { now: NOW });
    wizard = markStep(wizard, "app", "done", { now: NOW });
    wizard = markStep(wizard, "branding", "skipped", { now: NOW });
    expect(firstOpenStep(settings({ wizard })).key).toBe("admins");
  });

  test("sits on finish once everything is handled", () => {
    const done = everythingHandled(settings());
    expect(firstOpenStep(done).key).toBe("finish");
    expect(isComplete(done)).toBe(true);
  });
});

describe("markStep", () => {
  test("done records a timestamp and moves the cursor forward", () => {
    const wizard = markStep(settings().wizard, "welcome", "done", { now: NOW });
    expect(stepState(wizard, "welcome")).toEqual({ done: true, skipped: false, at: NOW });
    expect(wizard.current).toBe("app");
    expect(wizard.started_at).toBe(NOW);
  });

  test("skipped is not done, and is recorded separately", () => {
    const wizard = markStep(settings().wizard, "logs", "skipped", { now: NOW });
    expect(stepState(wizard, "logs")).toEqual({ done: false, skipped: true, at: NOW });
  });

  test("reopened clears done and stays on the step", () => {
    let wizard = markStep(settings().wizard, "welcome", "done", { now: NOW });
    wizard = markStep(wizard, "welcome", "reopened", { now: NOW });
    expect(stepState(wizard, "welcome").done).toBe(false);
    expect(wizard.current).toBe("welcome");
  });

  test("marking a step after the wizard finished keeps it finished", () => {
    const done = completeWizard(everythingHandled(settings()).wizard, NOW);
    const edited = markStep(done, "logs", "done", { now: NOW });
    expect(edited.done_at).toBe(NOW);
  });

  test("reopening a step un-finishes the wizard", () => {
    const done = completeWizard(everythingHandled(settings()).wizard, NOW);
    const reopened = markStep(done, "logs", "reopened", { now: NOW });
    expect(reopened.done_at).toBeNull();
  });

  test("the first mark sets started_at, and later marks do not overwrite it", () => {
    const wizard = markStep(settings().wizard, "welcome", "done", { now: NOW });
    const later = markStep(wizard, "app", "done", { now: "2026-10-17T00:00:00.000Z" });
    expect(later.started_at).toBe(NOW);
  });

  test("it is pure: the input state is untouched", () => {
    const before = settings().wizard;
    const snapshot = JSON.stringify(before);
    markStep(before, "scopes", "done", { now: NOW });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("completeWizard", () => {
  test("writes done_at, finishes the finish step, and stays on it", () => {
    const done = completeWizard(settings().wizard, NOW);
    expect(done.done_at).toBe(NOW);
    expect(done.current).toBe("finish");
    expect(stepState(done, "finish").done).toBe(true);
  });

  test("isComplete only once nothing is pending", () => {
    expect(isComplete(settings())).toBe(false);
    const halfway = settings({
      wizard: markStep(settings().wizard, "welcome", "done", { now: NOW }),
    });
    expect(isComplete(halfway)).toBe(false);
    expect(isComplete(everythingHandled(settings()))).toBe(true);
  });
});

describe("step order helpers", () => {
  test("next and previous clamp at the ends instead of wrapping", () => {
    expect(nextStep("welcome").key).toBe("app");
    expect(previousStep("finish").key).toBe("scopes");
    expect(nextStep("finish").key).toBe("finish");
    expect(previousStep("welcome").key).toBe("welcome");
  });

  test("an unknown key falls back to the first step", () => {
    expect(nextStep("nope").key).toBe("welcome");
    expect(previousStep("nope").key).toBe("welcome");
  });
});

describe("the wizard survives the settings round trip", () => {
  test("a stored wizard blob comes back intact", () => {
    const wizard = markStep(settings().wizard, "welcome", "done", { now: NOW });
    const stored = readGuildSettings({ wizard });
    expect(stored.wizard.current).toBe("app");
    expect(stored.wizard.started_at).toBe(NOW);
    expect(stepState(stored.wizard, "welcome")).toEqual({ done: true, skipped: false, at: NOW });
  });

  test("a stored step with a junk timestamp loses the timestamp, not the step", () => {
    const stored = readGuildSettings({
      wizard: { current: "logs", steps: { logs: { done: true, skipped: false, at: "whenever" } } },
    });
    expect(stepState(stored.wizard, "logs")).toEqual({ done: true, skipped: false, at: null });
  });

  test("a wizard blob of the wrong shape is the default, not thrown on", () => {
    expect(readGuildSettings({ wizard: "half way" }).wizard.current).toBe("welcome");
    expect(readGuildSettings({ wizard: [1, 2, 3] }).wizard.current).toBe("welcome");
    expect(readGuildSettings({ wizard: null }).wizard.done_at).toBeNull();
  });

  test("the default step state is not aliased into a returned row", () => {
    const first = readGuildSettings({});
    const second = readGuildSettings({});
    expect(first.wizard.steps).not.toBe(second.wizard.steps);
  });
});
