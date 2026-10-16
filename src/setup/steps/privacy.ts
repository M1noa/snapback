// the privacy wizard step (D4PLAN 10.1 #10, 14.5). shows the ip storage mode
// and its meaning, the retention stance, and the disclosure sentence. the one
// thing it saves is privacy_disclosure_text, written from a modal.
//
// the storage mode lives in .env and needs a restart, so it is shown, never
// edited here. retention is a table the retention engine owns, so this step
// points at it rather than inventing a setting.

import {
  ButtonStyles,
  type ContainerComponent,
  type ModalComponent,
  TextInputStyles,
} from "oceanic.js";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button, label, modal, textInput } from "../../discord/components/row.ts";
import { boundedText } from "../../lib/validate.ts";
import {
  SETUP_OBJECT,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";

// the sentence the verify page and /legal show until the operator replaces it.
// lives here because the stored field defaults to null (defaults.ts); exported
// so the web disclosure page and this step render the same words.
export const PRIVACY_DISCLOSURE_DEFAULT =
  "we collect your discord id, username, and avatar to verify you; your email address only if the email scope is on; and your ip address and browser user agent for abuse prevention. records follow this server's retention policy and can be removed on request.";

const MODAL_ACTION = "privacy";

// the meaning and the stored form of each ip mode, from D4PLAN 14.5.
const IP_MODE_MEANING: Readonly<Record<string, string>> = {
  hash: "a sha-512 hash of a pepper plus the address, with a short prefix kept for grouping. not reversible, and the default.",
  encrypted: "aes-256-gcm ciphertext, reversible with the key, stored beside the hash.",
  plaintext:
    "the address itself, stored as-is. local testing only, and the bot prints a warning at boot.",
};

function modeLine(mode: string): string {
  const meaning = IP_MODE_MEANING[mode] ?? "unrecognised mode, check `IP_STORAGE` in `.env`.";
  return `**ip storage** \`${mode}\`\n${meaning}`;
}

// plaintext is the only mode that weakens a record, so it is the only warning.
function stateFor(mode: string): "success" | "info" | "warning" {
  if (mode === "plaintext") return "warning";
  if (mode === "hash") return "success";
  return "info";
}

export const privacyStep: StepModule = {
  key: "privacy",

  render(ctx: StepContext): ContainerComponent {
    const edit = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.modal,
      action: MODAL_ACTION,
    });
    const { ipStorage, tokenStorage } = ctx.deps.privacy;

    return page({
      state: stateFor(ipStorage),
      title: "privacy",
      sections: [
        textDisplay(modeLine(ipStorage)),
        textDisplay(
          `**token storage** ${tokenStorage ? "on, tokens are always encrypted at rest" : "off, no oauth tokens are stored"}`,
        ),
        textDisplay(
          [
            `**storage mode** set in \`.env\` as \`IP_STORAGE\`, and only changes on restart. to change it, edit this line:`,
            "```",
            `IP_STORAGE=${ipStorage}`,
            "```",
          ].join("\n"),
        ),
        textDisplay(
          "**retention** policies live in the `retention_policies` table and are edited from `/admin retention` once the retention engine ships. this step does not set one.",
        ),
        textDisplay(
          [
            "**disclosure text** the verify page and `/legal` show this sentence unless you replace it:",
            `> ${PRIVACY_DISCLOSURE_DEFAULT}`,
          ].join("\n"),
        ),
      ],
      controls: [
        actionRow([button({ id: edit, label: "edit disclosure", style: ButtonStyles.PRIMARY })]),
      ],
    });
  },

  modal(ctx: StepContext): { title: string; components: ModalComponent[] } {
    const id = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.modal,
      action: MODAL_ACTION,
    });
    const built = modal({
      id,
      title: "privacy disclosure",
      components: [
        label({
          label: "disclosure text",
          description: "shown above the verify panel and on the /legal page",
          component: textInput({
            id,
            style: TextInputStyles.PARAGRAPH,
            maxLength: 2000,
            required: false,
            // the stored custom text, or the shipped default so they edit from a
            // starting point rather than a blank box.
            value: ctx.settings.privacy_disclosure_text ?? PRIVACY_DISCLOSURE_DEFAULT,
          }),
        }),
      ],
    });
    return { title: built.title, components: built.components };
  },

  apply(ctx: StepContext, values: StepValues): Partial<{ privacy_disclosure_text: string | null }> {
    const id = setupCustomId({
      guildId: ctx.guildId,
      object: SETUP_OBJECT.modal,
      action: MODAL_ACTION,
    });
    const raw = values[id];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const text = typeof value === "string" ? value : "";
    const length = text.trim().length;
    if (length > 2000) {
      throw new SetupInputError(
        "privacy_disclosure_text",
        `the disclosure text is ${length} characters; the limit is 2000. shorten it and open the editor again.`,
      );
    }
    // boundedText trims and returns null when nothing is left, which clears the
    // custom text and falls the verify page back to the shipped default.
    return { privacy_disclosure_text: boundedText(text, 2000) };
  },
};
