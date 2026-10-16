// the scopes step (wizard step 9, D4PLAN 7.2 and 10.1). it is the scope choice
// on its own, with the consequence of every scope spelled out, so the operator
// ticks the restricted acknowledgement knowingly rather than clicking past it.

import { ButtonStyles, type CheckboxGroupOption, type ContainerComponent } from "oceanic.js";
import type { GuildSettings } from "../../config/defaults.ts";
import { separator, textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button, checkbox, checkboxGroup, label } from "../../discord/components/row.ts";
import {
  SETUP_OBJECT,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";
import { panelAckId, panelFieldId, restrictionAcknowledged } from "../panel.ts";
import {
  DEFAULT_SCOPE_IDS,
  RESTRICTED_SCOPE_IDS,
  requireAcknowledgement,
  SCOPE_CATALOGUE,
} from "../scopes.ts";

const STEP_KEY = "scopes";

const ACK_LABEL = `acknowledge ${RESTRICTED_SCOPE_IDS[0] ?? "the restricted scope"}`;
const ACK_DESCRIPTION = "restricted scope: needs Discord approval and the Social SDK terms";

function currentScopes(ctx: StepContext): readonly string[] {
  return ctx.settings.verify_panel?.scopes ?? DEFAULT_SCOPE_IDS;
}

function isoNow(ctx: StepContext): string {
  return new Date(ctx.deps.now()).toISOString();
}

function scopeOptions(selected: readonly string[]): CheckboxGroupOption[] {
  return SCOPE_CATALOGUE.map((entry) => ({
    label: entry.restricted ? `${entry.id} (restricted)` : entry.id,
    value: entry.id,
    description: entry.consequence.slice(0, 100),
    default: selected.includes(entry.id),
  }));
}

function asScopes(value: string | readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? [value] : value;
}

function render(ctx: StepContext): ContainerComponent {
  const guildId = ctx.guildId;
  const selected = currentScopes(ctx);
  const ackedAt = ctx.settings.acknowledged_restricted_scopes;

  const lines = SCOPE_CATALOGUE.map(
    (entry) =>
      `- \`${entry.id}\` ${entry.consequence}${entry.restricted ? " **(restricted)**" : ""}`,
  );

  return page({
    state: "info",
    title: "scopes",
    sections: [
      textDisplay(
        ["what the verification asks for, and what each scope reveals:", "", ...lines].join("\n"),
      ),
      separator({ divider: true }),
      textDisplay(
        `**selected** ${selected.length > 0 ? selected.map((id) => `\`${id}\``).join(", ") : "none"}`,
      ),
      textDisplay(
        `**restricted acknowledgement** ${ackedAt !== null ? `saved ${ackedAt}` : "not saved"}`,
      ),
      textDisplay(
        "-# if a restricted scope is chosen without the acknowledgement, saving is refused and no panel is built that requests it (D4PLAN 7.2).",
      ),
    ],
    controls: [
      actionRow([
        button({
          id: setupCustomId({ guildId, object: SETUP_OBJECT.modal, action: STEP_KEY }),
          label: "choose scopes",
          style: ButtonStyles.PRIMARY,
        }),
      ]),
    ],
  });
}

function modal(ctx: StepContext): { title: string; components: ReturnType<typeof label>[] } {
  const guildId = ctx.guildId;
  return {
    title: "scopes",
    components: [
      label({
        label: "scopes",
        component: checkboxGroup({
          id: panelFieldId(guildId, "scopes"),
          options: scopeOptions(currentScopes(ctx)),
        }),
      }),
      label({
        label: ACK_LABEL,
        description: ACK_DESCRIPTION,
        component: checkbox({
          id: panelAckId(guildId),
          default: ctx.settings.acknowledged_restricted_scopes !== null,
        }),
      }),
    ],
  };
}

function apply(ctx: StepContext, values: StepValues): Partial<GuildSettings> {
  const guildId = ctx.guildId;
  const submitted = asScopes(values[panelFieldId(guildId, "scopes")]);
  const scopes =
    submitted === undefined
      ? currentScopes(ctx)
      : SCOPE_CATALOGUE.filter((entry) => submitted.includes(entry.id)).map((entry) => entry.id);

  const acknowledged = restrictionAcknowledged(values, guildId);
  const missing = requireAcknowledgement(scopes, acknowledged ? isoNow(ctx) : null);
  if (missing !== null) {
    throw new SetupInputError(
      "scopes",
      `${missing} is a restricted scope and needs the acknowledgement before it can be saved.`,
    );
  }

  const panel = ctx.settings.verify_panel;
  return {
    ...(panel !== null ? { verify_panel: { ...panel, scopes } } : {}),
    acknowledged_restricted_scopes: acknowledged ? isoNow(ctx) : null,
  };
}

export const scopesStep: StepModule = {
  key: STEP_KEY,
  render,
  apply,
  modal,
};
