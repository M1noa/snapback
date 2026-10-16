// the /setup surface: one handler per produced action, plus the entry point the
// slash commands use (openSetup) and the two things boot needs from this file
// (registerSetupHandlers and SETUP_SPECS).
//
// the router keys a handler on (surface, action) and the object slot is not part
// of that key, so one handler serves every object reporting the same verb and
// dispatches on id.object plus the interaction's own kind (D4PLAN 9.3). a step's
// page control and the modal it opens can carry one customID, which is why
// surface.source exists.
//
// rule 8 lives here: every press re-reads the settings and re-checks that the
// person driving the wizard is the one who opened it. a control rendered for the
// owner last week fails closed today.

import { ButtonStyles, type ContainerComponent, type SelectOption } from "oceanic.js";
import {
  DEFAULT_VERIFY_PANEL,
  type GuildSettings,
  type VerifyPanelSettings,
  type WizardState,
} from "../config/defaults.ts";
import type { JsonValue } from "../db/types.ts";
import { relativeTimestamp } from "../discord/commands/types.ts";
import { textDisplay } from "../discord/components/fields.ts";
import { page } from "../discord/components/page.ts";
import { actionRow, button, stringSelect } from "../discord/components/row.ts";
import { DiscordApiError, formatDiscordError } from "../discord/errors.ts";
import { failurePage, stalePage } from "../discord/interactions/dispatch.ts";
import type {
  CustomIdSpec,
  Handler,
  HandlerContext,
  HandlerResult,
  Router,
  SubmittedValue,
} from "../discord/interactions/router.ts";
import { STATE_TTL_MS } from "../discord/interactions/state.ts";
import { snowflake } from "../lib/validate.ts";
import {
  type LogTestResult,
  SETUP_ACTION,
  SETUP_OBJECT,
  SETUP_SURFACE,
  type SetupDeps,
  SetupInputError,
  type StepContext,
  type StepValues,
  setupCustomId,
} from "./deps.ts";
import { GUIDE_DOCS, guideFilterId, guideIndex, guidePage } from "./guide.ts";
import { confirmPage, reportPage, withWizardChrome } from "./pages.ts";
import { panelPreviewPage } from "./panel.ts";
import {
  findStep,
  firstOpenStep,
  markStep,
  nextStep,
  pendingSteps,
  previousStep,
  stepState,
  verificationEnabled,
  WIZARD_STEP_KEYS,
  WIZARD_STEPS,
} from "./state.ts";
import { finishSummary } from "./steps/finish.ts";
import { stepModule } from "./steps/index.ts";

// ---- ids this file builds -------------------------------------------------

function stepId(guildId: string, key: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.step, action: key });
}

function modalId(guildId: string, key: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.modal, action: key });
}

function jumpId(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.nav, action: SETUP_ACTION.jump });
}

function navId(guildId: string, action: string, cursor = ""): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.nav, action, cursor });
}

// ---- small helpers --------------------------------------------------------

interface SurfaceInput {
  readonly guildId: string;
  readonly userId: string;
  readonly deps: SetupDeps;
}

function inputOf(ctx: HandlerContext, deps: SetupDeps): SurfaceInput {
  return { guildId: ctx.id.guild, userId: ctx.identity.userId, deps };
}

function stepContext(input: SurfaceInput, settings: GuildSettings): StepContext {
  return {
    guildId: input.guildId,
    userId: input.userId,
    settings,
    wizard: settings.wizard,
    deps: input.deps,
  };
}

function isoNow(deps: SetupDeps): string {
  return new Date(deps.now()).toISOString();
}

function firstValue(value: SubmittedValue): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === "string" && first !== "" ? first : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function panelOf(settings: GuildSettings): VerifyPanelSettings {
  return settings.verify_panel ?? { ...DEFAULT_VERIFY_PANEL };
}

type AnswerMode = "update" | "private";

async function answer(
  ctx: HandlerContext,
  message: ContainerComponent,
  mode: AnswerMode,
): Promise<HandlerResult> {
  if (mode === "update") await ctx.surface.reply({ message, update: true });
  else await ctx.surface.reply({ message, ephemeral: true });
  return { kind: "reply" };
}

// ---- pages this file owns -------------------------------------------------

/** the hub: every step and where it stands, with a select to open one. also what
 *  `/setup status` shows, without moving the wizard. */
export function statusPage(guildId: string, settings: GuildSettings): ContainerComponent {
  const verify = verificationEnabled(settings);
  const rows = WIZARD_STEPS.filter((step) => !step.verifyOnly || verify).map((step) => {
    const state = stepState(settings.wizard, step.key);
    const mark = state.done ? "done" : state.skipped ? "skipped" : "open";
    return `- **${step.title}** ${mark}${step.required ? " (required)" : ""}`;
  });
  const left = pendingSteps(settings).length;

  return page({
    state: left === 0 ? "success" : "info",
    title: "setup status",
    sections: [
      textDisplay(
        left === 0
          ? "every required step is done. opening a step below reopens the wizard on it."
          : `${left} step${left === 1 ? "" : "s"} still to deal with. opening one below moves the wizard there.`,
      ),
      textDisplay(rows.join("\n")),
    ],
    controls: [
      actionRow([
        stringSelect({
          id: jumpId(guildId),
          placeholder: "open a step",
          options: stepOptions(settings),
        }),
      ]),
    ],
  });
}

function stepOptions(settings: GuildSettings): SelectOption[] {
  const verify = verificationEnabled(settings);
  return WIZARD_STEPS.filter((step) => !step.verifyOnly || verify).map((step) => {
    const state = stepState(settings.wizard, step.key);
    const mark = state.done ? "done" : state.skipped ? "skipped" : "open";
    return {
      label: step.title,
      value: step.key,
      description: `${mark} - ${step.summary}`.slice(0, 100),
      default: step.key === settings.wizard.current,
    };
  });
}

/** where the wizard finished: what is done, and what is still open. */
function completePage(guildId: string, settings: GuildSettings): ContainerComponent {
  const doneAt = settings.wizard.done_at;
  const outstanding = finishSummary(settings);
  return page({
    state: "success",
    title: "setup finished",
    sections: [
      textDisplay(
        `the wizard is closed${doneAt === null ? "" : `, finished ${relativeTimestamp(Date.parse(doneAt))}`}. everything it wrote is live now.`,
      ),
      textDisplay(
        outstanding.length === 0
          ? "every required step is done."
          : ["still outstanding:", ...outstanding].join("\n"),
      ),
      textDisplay(
        "-# `/setup` reopens the wizard on any step, `/setup status` shows this list, and `/setup guide` reads the operator docs.",
      ),
    ],
    controls: [
      actionRow([
        button({
          id: navId(guildId, SETUP_ACTION.status),
          label: "setup status",
          style: ButtonStyles.SECONDARY,
        }),
      ]),
    ],
  });
}

async function stepPage(
  input: SurfaceInput,
  settings: GuildSettings,
  key: string,
): Promise<ContainerComponent> {
  const module = stepModule(key);
  if (module === undefined) return stalePage();
  const body = await module.render(stepContext(input, settings));
  return withWizardChrome({
    guildId: input.guildId,
    stepKey: key,
    wizard: settings.wizard,
    body,
  });
}

/** where a step's save lands. the finish step closes the wizard, so it lands on
 *  the completion page, and the panel step shows the real preview the operator is
 *  about to post rather than the step's own summary (D4PLAN 10.3). */
async function afterApply(
  input: SurfaceInput,
  settings: GuildSettings,
  key: string,
): Promise<ContainerComponent> {
  if (settings.wizard.done_at !== null) return completePage(input.guildId, settings);
  if (key === "verify") {
    return panelPreviewPage(panelOf(settings), {
      guildId: input.guildId,
      publicBaseUrl: input.deps.web.publicBaseUrl,
    });
  }
  return await stepPage(input, settings, key);
}

// ---- writes ---------------------------------------------------------------

/** the one path a step's values take: validate, save with an audit action, and
 *  mark the step done. a patch that carries its own wizard state keeps it (the
 *  finish step completes the wizard rather than marking a step). */
async function runApply(
  ctx: HandlerContext,
  deps: SetupDeps,
  settings: GuildSettings,
  key: string,
  values: StepValues,
): Promise<
  | { readonly ok: true; readonly settings: GuildSettings }
  | { readonly ok: false; readonly result: HandlerResult }
> {
  const module = stepModule(key);
  const input = inputOf(ctx, deps);
  if (module?.apply === undefined) return { ok: true, settings };

  let patch: Partial<GuildSettings>;
  try {
    patch = await module.apply(stepContext(input, settings), values);
  } catch (error) {
    // a validation failure is the operator's to fix, and the step's own message
    // is the fix. anything else is a real failure: it reaches the wrapper, which
    // logs the stack.
    if (error instanceof SetupInputError) {
      return {
        ok: false,
        result: await answer(ctx, failurePage("nothing was saved", error.message), "private"),
      };
    }
    throw error;
  }

  const saved = await deps.store.save({
    guildId: input.guildId,
    actorUserId: input.userId,
    action: `setup.${key}`,
    patch: {
      ...patch,
      wizard: patch.wizard ?? markStep(settings.wizard, key, "done", { now: isoNow(deps) }),
    },
  });
  return { ok: true, settings: saved.settings };
}

async function markStepOutcome(
  ctx: HandlerContext,
  deps: SetupDeps,
  settings: GuildSettings,
  key: string,
  outcome: "done" | "skipped",
): Promise<GuildSettings> {
  const saved = await deps.store.save({
    guildId: ctx.id.guild,
    actorUserId: ctx.identity.userId,
    action: `setup.${key}.${outcome}`,
    patch: { wizard: markStep(settings.wizard, key, outcome, { now: isoNow(deps) }) },
  });
  return saved.settings;
}

/** rule 8, the wizard's half: the person who opened the wizard drives it. */
async function refuseUnlessOpener(
  ctx: HandlerContext,
  wizard: WizardState,
): Promise<HandlerResult | null> {
  const openedBy = wizard.opened_by;
  if (openedBy === null || openedBy === ctx.identity.userId) return null;
  return await answer(
    ctx,
    reportPage(
      "this setup is someone else's",
      [
        `<@${openedBy}> opened this setup and has not finished it. every control in the wizard belongs to whoever opened it.`,
        "-# run `/setup` to take it over. nothing is locked, it is only attributed.",
      ],
      "warning",
    ),
    "private",
  );
}

// ---- the step handler -----------------------------------------------------

function stepAction(deps: SetupDeps, key: string): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    const module = stepModule(key);
    if (module === undefined) return await answer(ctx, stalePage(), "private");

    const values = ctx.surface.values;
    const submit = async (): Promise<HandlerResult> => {
      const outcome = await runApply(ctx, deps, settings, key, values);
      if (!outcome.ok) return outcome.result;
      return await answer(ctx, await afterApply(input, outcome.settings, key), "update");
    };

    // a modal submission is a submission. so is a page control that carries a
    // value or a cursor: those are the step's fields.
    if (ctx.surface.source === "modal") return await submit();
    if (Object.keys(values).length > 0 || ctx.id.cursor !== "") return await submit();

    // the control with no cursor is the step's primary action: open the modal it
    // edits, apply what it has, or show the step.
    if (module.modal !== undefined) {
      const built = await module.modal(stepContext(input, settings));
      if (built !== null) {
        await ctx.surface.openModal({
          customID: modalId(input.guildId, key),
          title: built.title,
          components: built.components,
        });
        return { kind: "reply" };
      }
    }
    if (module.apply !== undefined) return await submit();
    return await answer(ctx, await stepPage(input, settings, key), "update");
  };
}

// ---- navigation -----------------------------------------------------------

function currentStepKey(ctx: HandlerContext, settings: GuildSettings): string | null {
  // the nav row carries the step it was rendered for; the welcome page's first
  // continue button has no cursor yet, so the wizard's own cursor stands in.
  const fromCursor = findStep(ctx.id.cursor);
  if (fromCursor !== undefined) return fromCursor.key;
  const fromWizard = findStep(settings.wizard.current);
  if (fromWizard !== undefined) return fromWizard.key;
  const pending = pendingSteps(settings);
  return pending.length > 0 ? firstOpenStep(settings).key : null;
}

function navAction(deps: SetupDeps, action: string): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    if (action === SETUP_ACTION.status) {
      return await answer(ctx, statusPage(input.guildId, settings), "update");
    }
    if (action === SETUP_ACTION.probe) {
      return await answer(ctx, await stepPage(input, settings, "web"), "update");
    }
    if (action === SETUP_ACTION.jump) {
      const chosen = firstValue(ctx.surface.values[jumpId(input.guildId)]);
      const target = chosen === undefined ? undefined : findStep(chosen);
      if (target === undefined) return await answer(ctx, stalePage(), "private");
      return await answer(ctx, await stepPage(input, settings, target.key), "update");
    }

    const from = currentStepKey(ctx, settings);
    const step = from === null ? undefined : findStep(from);
    if (from === null || step === undefined) return await answer(ctx, stalePage(), "private");

    if (action === SETUP_ACTION.prev) {
      return await answer(ctx, await stepPage(input, settings, previousStep(from).key), "update");
    }
    if (action === SETUP_ACTION.skip) {
      if (step.required) {
        return await answer(
          ctx,
          failurePage(
            "this step cannot be skipped",
            `${step.title} has to be filled in before the wizard can finish.`,
            undefined,
            "press next to leave it open and come back to it, or run /setup status to see what is outstanding.",
          ),
          "private",
        );
      }
      const after = await markStepOutcome(ctx, deps, settings, from, "skipped");
      return await answer(ctx, await stepPage(input, after, nextStep(from).key), "update");
    }

    // next: a step with nothing to submit is finished by pressing forward.
    const module = stepModule(from);
    const after =
      module !== undefined && module.apply === undefined
        ? await markStepOutcome(ctx, deps, settings, from, "done")
        : settings;
    return await answer(ctx, await stepPage(input, after, nextStep(from).key), "update");
  };
}

// ---- admins ---------------------------------------------------------------

function firstUser(ctx: HandlerContext, guildId: string): string | null {
  const addId = setupCustomId({ guildId, object: SETUP_OBJECT.admin, action: SETUP_ACTION.add });
  return snowflake(firstValue(ctx.surface.values[addId])) ?? snowflake(ctx.id.cursor);
}

function adminAdd(deps: SetupDeps): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    const target = firstUser(ctx, input.guildId);
    if (target === null) {
      return await answer(
        ctx,
        failurePage(
          "no user selected",
          "the control arrived without a user attached to it.",
          undefined,
          "pick a user from the select, then try again.",
        ),
        "private",
      );
    }
    await deps.admins.add(input.guildId, target, input.userId);
    return await answer(ctx, await stepPage(input, settings, "admins"), "update");
  };
}

/** the payload a removal confirmation carries. a json record, read defensively:
 *  the row is ours, but a shape change must fail closed, not throw. */
function payloadTarget(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, JsonValue>).target;
  return typeof value === "string" ? snowflake(value) : null;
}

function adminRemove(deps: SetupDeps): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    // a nonce is a stored row, a target is a snowflake. looking the cursor up
    // first settles which one this press is, whatever the string looks like.
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce !== null) {
      // one press, one removal: the row goes before the write, so a double press
      // cannot remove twice.
      await deps.state.delete(ctx.id.cursor);
      if (nonce.userId !== input.userId || nonce.guildId !== input.guildId) {
        return await answer(
          ctx,
          failurePage(
            "that confirmation is not yours",
            "it was minted for a different user or server, so it will not be used.",
            undefined,
            "press remove again to get a fresh confirmation.",
          ),
          "private",
        );
      }
      const target = payloadTarget(nonce.payload);
      if (target === null) return await answer(ctx, stalePage(), "private");
      await deps.admins.remove(input.guildId, target);
      return await answer(ctx, await stepPage(input, settings, "admins"), "update");
    }

    const target = snowflake(ctx.id.cursor);
    if (target === null) return await answer(ctx, stalePage(), "private");
    if (target === deps.app.ownerId) {
      return await answer(
        ctx,
        failurePage(
          "the instance owner always has access",
          `\`${target}\` owns this snapback instance, so removing an admin row for them changes nothing.`,
          undefined,
          "remove a different admin, or change DISCORD_OWNER_ID in .env and restart.",
        ),
        "private",
      );
    }

    const minted = await deps.state.put({
      guildId: input.guildId,
      userId: input.userId,
      surface: SETUP_SURFACE,
      payload: { target },
    });
    return await answer(
      ctx,
      confirmPage({
        guildId: input.guildId,
        title: "remove an admin",
        what: `remove <@${target}> from this server's snapback admins.`,
        consequence:
          "they lose access to every snapback command here on their next interaction. their rows in this server's records are untouched.",
        object: SETUP_OBJECT.admin,
        action: SETUP_ACTION.remove,
        nonce: minted,
        cancel: navId(input.guildId, SETUP_ACTION.jump, "admins"),
        expiresAt: deps.now() + STATE_TTL_MS,
      }),
      "update",
    );
  };
}

// ---- logging and the app self test ---------------------------------------

function logTestPage(guildId: string, result: LogTestResult): ContainerComponent {
  const tail =
    result.fix ??
    (result.posted ? "the log channel received one test event." : "nothing was posted.");
  // the fix is a command, so it gets a button: one press fires the test again.
  return page({
    state: result.posted ? "success" : "warning",
    title: result.posted ? "log test posted" : "the log test did not post",
    sections: [textDisplay(result.said), textDisplay(`-# ${tail}`)],
    controls: [
      actionRow([
        button({
          id: setupCustomId({
            guildId,
            object: SETUP_OBJECT.log,
            action: SETUP_ACTION.testfire,
          }),
          label: "test again",
          style: ButtonStyles.SECONDARY,
        }),
      ]),
    ],
  });
}

function testfire(deps: SetupDeps): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    const result = await deps.logs(input.guildId);
    return await answer(ctx, logTestPage(input.guildId, result), "private");
  };
}

async function selfTestPage(guildId: string, deps: SetupDeps): Promise<ContainerComponent> {
  const lines = await deps.app.selfTest();
  const failed = lines.filter((line) => !line.passed);
  const sections = [
    textDisplay(
      lines
        .map((line) => `${line.passed ? "pass" : "fail"}  ${line.step}\n-# ${line.said}`)
        .join("\n"),
    ),
    failed.length === 0
      ? textDisplay("every check passed. nothing to fix.")
      : textDisplay(
          [
            "**what to do**",
            ...failed.map((line) => `- ${line.step}: ${line.fix ?? "no fix recorded"}`),
          ].join("\n"),
        ),
  ];
  return page({
    state: failed.length === 0 ? "success" : "danger",
    title: "self test",
    sections,
    controls: [
      actionRow([
        button({
          id: stepId(guildId, "app"),
          label: "back to app check",
          style: ButtonStyles.SECONDARY,
        }),
      ]),
    ],
  });
}

function appTest(deps: SetupDeps): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    return await answer(ctx, await selfTestPage(input.guildId, deps), "private");
  };
}

// ---- the verification panel ----------------------------------------------

/** a swatch button submits no value of its own: the colour is in the cursor, and
 *  panelFromValues() finds it by seeing the pressed id among the submission's
 *  keys. so the press's own id is added to what the step reads. a control that
 *  did submit a value keeps it: only the swatch is a key without a payload. */
function withSelf(values: StepValues, id: { readonly raw: string }): StepValues {
  return values[id.raw] === undefined ? { ...values, [id.raw]: "set" } : values;
}

function panelAction(deps: SetupDeps, action: string): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const settings = await deps.store.read(input.guildId);
    const denied = await refuseUnlessOpener(ctx, settings.wizard);
    if (denied !== null) return denied;

    if (action === SETUP_ACTION.discard) {
      return await answer(ctx, await stepPage(input, settings, "verify"), "update");
    }

    // a swatch submits no value and the channel select does: either way the panel
    // is saved from what arrived, and the preview shows the result.
    if (action === SETUP_ACTION.preview || Object.keys(ctx.surface.values).length > 0) {
      const outcome = await runApply(
        ctx,
        deps,
        settings,
        "verify",
        withSelf(ctx.surface.values, ctx.id),
      );
      if (!outcome.ok) return outcome.result;
      return await answer(ctx, await afterApply(input, outcome.settings, "verify"), "update");
    }

    // the send button: no values, so this is the post.
    const panel = settings.verify_panel;
    if (panel === null) {
      return await answer(
        ctx,
        failurePage(
          "no panel to post",
          "the verification panel has not been built yet, so there is nothing to send.",
          undefined,
          "open /setup verify and press edit panel.",
        ),
        "private",
      );
    }
    const channelId = panel.channel_id;
    if (channelId === null) {
      return await answer(
        ctx,
        failurePage(
          "no channel chosen",
          "the panel has no channel yet, so there is nowhere to post it.",
          undefined,
          "pick a channel on this page, then press send to channel.",
        ),
        "private",
      );
    }

    try {
      await deps.postPanel(panel, channelId);
    } catch (error) {
      // discord's own code and message, verbatim, whenever discord said it.
      const report = error instanceof DiscordApiError ? formatDiscordError(error) : null;
      return await answer(
        ctx,
        failurePage(
          "the panel was not posted",
          `posting to <#${channelId}> failed.`,
          report === null ? messageOf(error) : report.said,
          report?.fix ??
            "check that snapback can view that channel and send messages in it, then try again.",
        ),
        "private",
      );
    }

    return await answer(
      ctx,
      reportPage(
        "panel posted",
        [
          `the verification panel is in <#${channelId}>.`,
          "-# sending again posts a second panel. this build does not track the message it posted, so delete the old one by hand.",
        ],
        "success",
      ),
      "update",
    );
  };
}

// ---- the guides -----------------------------------------------------------

function guideAction(deps: SetupDeps, action: string): Handler {
  return async (ctx) => {
    const input = inputOf(ctx, deps);
    const name = ctx.id.object;
    const docs = { docs: deps.docs, guildId: input.guildId };

    if (action === "filter") {
      const chosen = firstValue(ctx.surface.values[guideFilterId(input.guildId, name)]);
      const known = chosen !== undefined && GUIDE_DOCS.some((doc) => doc.name === chosen);
      return await answer(
        ctx,
        known ? await guidePage(docs, chosen, 1) : guideIndex(input.guildId, name),
        "update",
      );
    }

    // the list row writes the target page into the cursor.
    const wanted = Number.parseInt(ctx.id.cursor, 10);
    return await answer(ctx, await guidePage(docs, name, wanted), "update");
  };
}

// ---- registration ---------------------------------------------------------

/** every action this surface produces. boot asserts each one has a handler, so a
 *  control added without a handler fails at startup rather than in front of an
 *  operator. */
export const SETUP_SPECS: readonly CustomIdSpec[] = Object.freeze(
  [
    // step keys: the step's own page control, its modal, and its submission
    ...WIZARD_STEP_KEYS,
    // navigation
    SETUP_ACTION.jump,
    SETUP_ACTION.next,
    SETUP_ACTION.prev,
    SETUP_ACTION.skip,
    SETUP_ACTION.status,
    SETUP_ACTION.probe,
    // admins
    SETUP_ACTION.add,
    SETUP_ACTION.remove,
    // logging
    SETUP_ACTION.toggle,
    SETUP_ACTION.testfire,
    // app
    SETUP_ACTION.test,
    // panel
    SETUP_ACTION.preview,
    SETUP_ACTION.send,
    SETUP_ACTION.discard,
    // guides
    "page-prev",
    "page",
    "page-next",
    "filter",
  ].map((action) => ({ surface: SETUP_SURFACE, action })),
);

/** registers every handler this surface needs and returns the router. */
export function registerSetupHandlers(router: Router, deps: SetupDeps): Router {
  const handlers = new Map<string, Handler>();

  // one handler per step key, so a new control on any step cannot produce an id
  // the router does not know.
  for (const key of WIZARD_STEP_KEYS) handlers.set(key, stepAction(deps, key));

  for (const action of [
    SETUP_ACTION.jump,
    SETUP_ACTION.next,
    SETUP_ACTION.prev,
    SETUP_ACTION.skip,
    SETUP_ACTION.status,
    SETUP_ACTION.probe,
  ]) {
    handlers.set(action, navAction(deps, action));
  }
  handlers.set(SETUP_ACTION.add, adminAdd(deps));
  handlers.set(SETUP_ACTION.remove, adminRemove(deps));
  handlers.set(SETUP_ACTION.testfire, testfire(deps));
  // the log channel select and the family checkboxes report under "toggle", and
  // they are the logging step's fields.
  handlers.set(SETUP_ACTION.toggle, stepAction(deps, "logs"));
  handlers.set(SETUP_ACTION.test, appTest(deps));
  for (const action of [SETUP_ACTION.preview, SETUP_ACTION.send, SETUP_ACTION.discard]) {
    handlers.set(action, panelAction(deps, action));
  }
  for (const action of ["page-prev", "page", "page-next", "filter"]) {
    handlers.set(action, guideAction(deps, action));
  }

  for (const [action, handler] of handlers) router.register(SETUP_SURFACE, action, handler);
  return router;
}

// ---- the slash command's entry point -------------------------------------

export interface OpenSetupInput {
  readonly deps: SetupDeps;
  readonly guildId: string;
  readonly userId: string;
  /** a step key from the command's choice, when one was given. */
  readonly stepKey?: string | undefined;
}

/** the page `/setup` opens, and the hand-over: whoever runs the command takes the
 *  wizard over, which is how a setup opened by someone else is resumed. */
export async function openSetup(input: OpenSetupInput): Promise<ContainerComponent> {
  const { deps, guildId, userId } = input;
  let settings = await deps.store.read(guildId);

  if (settings.wizard.opened_by !== userId) {
    const saved = await deps.store.save({
      guildId,
      actorUserId: userId,
      action: "setup.open",
      patch: { wizard: { ...settings.wizard, opened_by: userId } },
      detail: { step: input.stepKey ?? null },
    });
    settings = saved.settings;
  }

  const requested = input.stepKey === undefined ? undefined : findStep(input.stepKey);
  const key = requested?.key ?? firstOpenStep(settings).key;
  return await stepPage({ guildId, userId, deps }, settings, key);
}
