// the verification panel step (wizard step 8, D4PLAN 10.3). it edits the panel
// and validates it; the panel tree itself is built in ../panel.ts, once, so the
// summary here and the preview there describe the same object.

import {
  ButtonStyles,
  type CheckboxGroupOption,
  type ContainerComponent,
  TextInputStyles,
} from "oceanic.js";
import {
  DEFAULT_VERIFY_PANEL,
  type GuildSettings,
  type VerifyPanelSettings,
} from "../../config/defaults.ts";
import { STATUS } from "../../discord/components/colors.ts";
import { section, separator, textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import {
  actionRow,
  button,
  channelSelect,
  checkbox,
  checkboxGroup,
  label,
  textInput,
} from "../../discord/components/row.ts";
import {
  SETUP_OBJECT,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";
import {
  PANEL_CHANNEL_TYPES,
  panelAckId,
  panelChannelId,
  panelFieldId,
  panelFromValues,
  panelSummary,
  panelSwatchId,
  restrictionAcknowledged,
} from "../panel.ts";
import { RESTRICTED_SCOPE_IDS, requireAcknowledgement, SCOPE_CATALOGUE } from "../scopes.ts";

const STEP_KEY = "verify";

// the five preset swatches, one per status accent (D4PLAN 9.4). colour is not a
// sixth state, it is the panel's own accent, so the swatches are the statuses.
const SWATCHES: readonly string[] = Object.freeze(
  Object.values(STATUS).map((style) => `#${style.accent.toString(16).padStart(6, "0")}`),
);

const ACK_LABEL = `acknowledge ${RESTRICTED_SCOPE_IDS[0] ?? "the restricted scope"}`;
const ACK_DESCRIPTION = "restricted scope: needs Discord approval and the Social SDK terms";

function currentPanel(ctx: StepContext): VerifyPanelSettings {
  return ctx.settings.verify_panel ?? { ...DEFAULT_VERIFY_PANEL };
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

function render(ctx: StepContext): ContainerComponent {
  const guildId = ctx.guildId;
  const panel = currentPanel(ctx);
  const redirect = `${ctx.deps.web.publicBaseUrl}/callback`;
  const ackedAt = ctx.settings.acknowledged_restricted_scopes;
  const restrictedChosen = panel.scopes.some((id) =>
    SCOPE_CATALOGUE.some((entry) => entry.id === id && entry.restricted),
  );

  const summary = panelSummary(panel);
  const scopesLine = textDisplay(
    [
      `**scopes** ${panel.scopes.length > 0 ? panel.scopes.map((id) => `\`${id}\``).join(", ") : "none"}`,
      `-# restricted acknowledgement ${
        ackedAt !== null
          ? `saved ${ackedAt}`
          : restrictedChosen
            ? "not saved: a restricted scope cannot be requested until it is acknowledged on the scopes step"
            : "not saved"
      }`,
    ].join("\n"),
  );
  const redirectLine = textDisplay(
    `**redirect target** \`${redirect}\`\n-# paste this exact string into the Developer Panel under OAuth2 > Redirects. discord rejects the whole flow on a mismatch (D4PLAN 7.3).`,
  );

  return page({
    state: "info",
    title: "verification panel",
    sections: [
      // the edit button rides the summary as a section accessory, which keeps
      // the two control rows for the controls that need one (a select, a row).
      section({
        texts: [
          textDisplay(summary.join("\n")),
          textDisplay("-# edit the words, the colour, or the thumbnail; send it from the preview."),
        ],
        accessory: button({
          id: setupCustomId({ guildId, object: SETUP_OBJECT.modal, action: STEP_KEY }),
          label: "edit panel",
          style: ButtonStyles.PRIMARY,
        }),
      }),
      separator({ divider: true }),
      scopesLine,
      redirectLine,
    ],
    controls: [
      actionRow([
        channelSelect({
          id: panelChannelId(guildId),
          placeholder: "channel to post the panel in",
          channelTypes: [...PANEL_CHANNEL_TYPES],
          minValues: 1,
          maxValues: 1,
        }),
      ]),
      actionRow(
        SWATCHES.map((hex) =>
          button({
            id: panelSwatchId(guildId, hex),
            label: hex.toUpperCase(),
            style: ButtonStyles.SECONDARY,
            disabled: panel.colour.toLowerCase() === hex.toLowerCase(),
          }),
        ),
      ),
    ],
  });
}

function modal(ctx: StepContext): { title: string; components: ReturnType<typeof label>[] } {
  const guildId = ctx.guildId;
  const panel = currentPanel(ctx);
  return {
    title: "verification panel",
    components: [
      label({
        label: "title",
        component: textInput({
          id: panelFieldId(guildId, "title"),
          value: panel.title,
          maxLength: 256,
          required: false,
        }),
      }),
      label({
        label: "description",
        component: textInput({
          id: panelFieldId(guildId, "description"),
          style: TextInputStyles.PARAGRAPH,
          value: panel.description,
          maxLength: 2000,
          required: false,
        }),
      }),
      label({
        label: "button label",
        component: textInput({
          id: panelFieldId(guildId, "button_label"),
          value: panel.button_label,
          maxLength: 80,
          required: false,
        }),
      }),
      label({
        label: "colour",
        description: "accepted: #rrggbb, rrggbb, or 0xrrggbb",
        component: textInput({
          id: panelFieldId(guildId, "colour"),
          value: panel.colour,
          required: false,
        }),
      }),
      label({
        label: "thumbnail url",
        description: "https only. leave blank for none.",
        component: textInput({
          id: panelFieldId(guildId, "thumbnail"),
          value: panel.thumbnail_url ?? "",
          required: false,
        }),
      }),
      label({
        label: "scopes",
        component: checkboxGroup({
          id: panelFieldId(guildId, "scopes"),
          options: scopeOptions(panel.scopes),
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
  const panel = panelFromValues(currentPanel(ctx), values, {
    guildId,
    publicBaseUrl: ctx.deps.web.publicBaseUrl,
  });
  const acknowledgedAt = restrictionAcknowledged(values, guildId)
    ? isoNow(ctx)
    : ctx.settings.acknowledged_restricted_scopes;

  const missing = requireAcknowledgement(panel.scopes, acknowledgedAt);
  if (missing !== null) {
    throw new SetupInputError(
      "scopes",
      `${missing} is a restricted scope and needs the acknowledgement before it can be requested. acknowledge it on the scopes step.`,
    );
  }

  return {
    verify_panel: panel,
    acknowledged_restricted_scopes: acknowledgedAt,
  };
}

export const verifyStep: StepModule = {
  key: STEP_KEY,
  render,
  apply,
  modal,
};
