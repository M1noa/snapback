// turns an outcome into a reply. the router decides what happens; this decides
// what the user sees.
//
// every message built here is a components v2 container, so the v2 flag is set in
// exactly one place (AGENTS.md rule 1) and the ephemeral flag is added here rather
// than by each caller. the payload builders are pure, so their shapes are testable
// without a gateway; the oceanic responder at the bottom is the only part that
// touches it.

import {
  type CommandInteraction,
  type ComponentInteraction,
  type ContainerComponent,
  MessageFlags,
  type ModalSubmitInteraction,
} from "oceanic.js";
import type { CommandResult } from "../commands/types.ts";
import { IS_COMPONENTS_V2 } from "../components/container.ts";
import { textDisplay } from "../components/fields.ts";
import { page } from "../components/page.ts";
import type { DenialReason, RouteOutcome } from "./router.ts";

// the interactions that can be answered with a message. an autocomplete cannot,
// so it is not in the union and cannot reach the responder by accident.
export type RespondableInteraction =
  | CommandInteraction
  | ComponentInteraction
  | ModalSubmitInteraction;

export interface V2Payload {
  flags: number;
  components: ContainerComponent[];
}

/** the v2 flag, plus ephemeral when the reply is private. */
export function v2Payload(message: ContainerComponent, ephemeral: boolean): V2Payload {
  return {
    flags: IS_COMPONENTS_V2 | (ephemeral ? MessageFlags.EPHEMERAL : 0),
    components: [message],
  };
}

// every failure surface carries the same three parts (AGENTS.md consistency):
// what happened, what discord said, what to do. an empty part is dropped rather
// than shown blank.
export function failurePage(
  title: string,
  happened: string,
  said?: string,
  fix?: string,
): ContainerComponent {
  const sections = [textDisplay(happened)];
  if (said !== undefined && said !== "") sections.push(textDisplay(said));
  if (fix !== undefined && fix !== "") sections.push(textDisplay(`-# ${fix}`));
  return page({ state: "danger", title, sections });
}

/** a denied interaction. the reason is ours, not discord's, so it is not dressed as one. */
export function deniedPage(reason: DenialReason): ContainerComponent {
  return page({
    state: "warning",
    title: "not permitted",
    sections: [
      textDisplay(reason.message),
      textDisplay(`-# ${reason.code}`),
      textDisplay(
        `-# ${reason.fix ?? "ask the server owner or a current snapback admin to change this."}`,
      ),
    ],
  });
}

/** a control from a build of the bot that no longer exists. */
export function stalePage(): ContainerComponent {
  return page({
    state: "warning",
    title: "this control is out of date",
    sections: [
      textDisplay("the button or menu you used is from an older version of snapback."),
      textDisplay("-# run the command again to get a current page."),
    ],
  });
}

export function commandResultPayload(result: CommandResult): V2Payload {
  return v2Payload(result.page, result.ephemeral);
}

export interface OutcomeReply {
  readonly payload: V2Payload;
  /** true when this should edit the message the control sits on, not post a new one. */
  readonly update: boolean;
}

/** the reply for a component interaction. null when the handler answered itself. */
export function outcomeReply(outcome: RouteOutcome): OutcomeReply | null {
  switch (outcome.kind) {
    case "handled":
      return null;
    case "denied":
      return { payload: v2Payload(deniedPage(outcome.reason), true), update: false };
    case "unregistered":
    case "invalid_id":
      return { payload: v2Payload(stalePage(), true), update: true };
    case "auth_error":
      return {
        payload: v2Payload(
          failurePage(
            "could not check your permissions",
            "the permission check failed before your control ran.",
            outcome.message,
            "try again. if it keeps failing, run /snapback diagnostics.",
          ),
          true,
        ),
        update: false,
      };
    case "handler_error":
      return {
        payload: v2Payload(
          failurePage(
            "that control failed",
            "the handler for this control threw before it could answer.",
            outcome.message,
            "run /snapback diagnostics and copy the report.",
          ),
          true,
        ),
        update: false,
      };
  }
}

export interface InteractionResponder {
  /** reply to a fresh interaction. */
  reply(interaction: RespondableInteraction, payload: V2Payload): Promise<void>;
  /** edit the message a component or modal came from. */
  update(interaction: RespondableInteraction, payload: V2Payload): Promise<void>;
  /** a private message after the interaction was already answered. */
  followUp(interaction: RespondableInteraction, payload: V2Payload): Promise<void>;
  /** answer with a modal. a component interaction can only be answered once. */
  openModal(
    interaction: RespondableInteraction,
    modal: { customID: string; title: string; components: readonly unknown[] },
  ): Promise<void>;
  /** take the interaction out of the 3-second window without answering it yet. */
  defer(interaction: RespondableInteraction): Promise<void>;
}

/** the oceanic adapter. */
export const oceanicResponder: InteractionResponder = {
  async reply(interaction, payload) {
    // an already-acknowledged interaction has no initial response left, so the
    // only place left to put the message is a followup.
    if (interaction.acknowledged) {
      await interaction.createFollowup(payload);
      return;
    }
    await interaction.createMessage(payload);
  },
  async update(interaction, payload) {
    // only a control on a message can edit one; a command has nothing to edit.
    if (interaction.isComponentInteraction() || interaction.isModalSubmitInteraction()) {
      await interaction.editParent(payload);
      return;
    }
    await interaction.createMessage(payload);
  },
  async followUp(interaction, payload) {
    await interaction.createFollowup(payload);
  },
  async openModal(interaction, modal) {
    if (!interaction.isComponentInteraction()) {
      throw new Error("only a component interaction can open a modal");
    }
    // the library's ModalData does not take camelCase components, so the modal
    // body is passed through as the raw object it already is.
    await interaction.createModal(modal as Parameters<typeof interaction.createModal>[0]);
  },
  async defer(interaction) {
    // a modal reply cannot be deferred, and a command has its own defer path that
    // the handler calls before it enqueues.
    if (interaction.isComponentInteraction() || interaction.isModalSubmitInteraction()) {
      await interaction.deferUpdate();
    }
  },
};
