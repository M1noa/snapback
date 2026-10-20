// the verification panel (D4PLAN 13.2). a message in a channel with a button
// that sends the member into the oauth flow.
//
// the panel is the opt-in gate to a server, and the copy says what the
// verification is for. there is no reward, no gift and no "free" anything in
// here: the only thing on offer is access to the server the panel sits in.
//
// editing a panel edits the message the bot already sent. it never posts a
// second one, which is what the message id on the row is for.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import { DEFAULT_VERIFY_PANEL } from "../../config/defaults.ts";
import { getGuildSettings } from "../../db/queries/guilds.ts";
import * as panelsDb from "../../db/queries/verify-panels.ts";
import type { Database, VerifyPanelRow } from "../../db/types.ts";
import type { DiscordClient } from "../../discord/client.ts";
import { type ContainerChild, container, v2Message } from "../../discord/components/container.ts";
import { section, textDisplay, thumbnail } from "../../discord/components/fields.ts";
import { actionRow, button, customID } from "../../discord/components/row.ts";
import type { Logger } from "../../lib/log.ts";
import { boundedText, hexToInt, snowflake } from "../../lib/validate.ts";
import { lookupScope } from "../../setup/scopes.ts";

// every discord call gets a deadline. nothing here awaits unbounded.
const PANEL_TIMEOUT_MS = 10_000;

const HTTPS = /^https:\/\/\S+$/;

// the custom id namespace of this surface (D4PLAN 9.3).
export const VERIFY_SURFACE = "verify";
export const VERIFY_ACTION_OPEN = "open";

export type VerifyPanelErrorCode =
  | "SB_VERIFY_PANEL_INPUT"
  | "SB_VERIFY_PANEL_NOT_POSTED"
  | "SB_VERIFY_PANEL_NO_MESSAGE";

const PANEL_MESSAGES: Record<VerifyPanelErrorCode, string> = {
  SB_VERIFY_PANEL_INPUT: "the panel input is not usable",
  SB_VERIFY_PANEL_NOT_POSTED: "this panel has no message to edit",
  SB_VERIFY_PANEL_NO_MESSAGE: "discord posted the panel but returned no message id",
};

// our own errors. one code, one fixed message (AGENTS.md errors).
export class VerifyPanelError extends Error {
  readonly code: VerifyPanelErrorCode;
  constructor(code: VerifyPanelErrorCode, detail?: string) {
    super(
      detail === undefined
        ? `${code}: ${PANEL_MESSAGES[code]}`
        : `${code}: ${PANEL_MESSAGES[code]}: ${detail}`,
    );
    this.name = "VerifyPanelError";
    this.code = code;
  }
}

export interface PanelInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly title: string;
  readonly description: string;
  readonly buttonLabel: string;
  readonly buttonStyle: number;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly enabled: boolean;
  /** the accent, as a number. absent means the guild's own colour. */
  readonly color?: number;
  /** a thumbnail for the panel. absent means none. */
  readonly thumbnailUrl?: string | null;
}

export interface PanelDeps {
  readonly client: DiscordClient;
  readonly db: Database;
  readonly log: Logger;
  /** injectable clock in iso-8601. */
  readonly now?: () => string;
}

/** the button's custom id. built with the one factory, never by hand. */
export function verifyOpenId(guildId: string, panelId: string): string {
  return customID({
    surface: VERIFY_SURFACE,
    guild: guildId,
    object: panelId,
    action: VERIFY_ACTION_OPEN,
  });
}

/** what the panel asks discord for, in the words of the scope catalogue. the
 *  panel and the wizard checkbox read the same table, so they cannot drift. */
export function disclosureLine(scopes: readonly string[]): string {
  const asked = scopes
    .map((id) => lookupScope(id)?.consequence)
    .filter((line): line is string => line !== undefined);
  const what = asked.length === 0 ? "your discord account id" : asked.join("; ");
  return `this asks discord for: ${what}. the server's owner can read what this collects, and you can revoke it at any time.`;
}

// the panel button is interactive, so the link and premium styles do not apply.
// an unknown number falls back to the primary style rather than to a link.
function buttonStyle(value: number): ButtonStyles {
  if (value === ButtonStyles.SECONDARY) return ButtonStyles.SECONDARY;
  if (value === ButtonStyles.SUCCESS) return ButtonStyles.SUCCESS;
  if (value === ButtonStyles.DANGER) return ButtonStyles.DANGER;
  return ButtonStyles.PRIMARY;
}

// a hand-edited colour must not break the post, so it is clamped into the
// range discord accepts instead of being passed through.
function accentFor(color: number): number {
  if (!Number.isInteger(color) || color < 0x000000 || color > 0xffffff) {
    return hexToInt(DEFAULT_VERIFY_PANEL.colour);
  }
  return color;
}

/** the panel's component tree: one container, the title, the copy, what it asks
 *  for, and the one button that starts the flow. */
export function panelComponents(panel: VerifyPanelRow): ContainerComponent {
  // an empty text display is a payload discord rejects, so a panel with no
  // copy shows the title, the disclosure and the button, and nothing else.
  const description = (panel.description ?? "").trim();
  const children: ContainerChild[] = [textDisplay(`## ${panel.title}`)];
  if (description !== "") {
    const body = textDisplay(description);
    if (panel.thumbnail_url !== null) {
      children.push(section({ texts: [body], accessory: thumbnail(panel.thumbnail_url) }));
    } else {
      children.push(body);
    }
  }
  children.push(textDisplay(disclosureLine(panel.scopes_json)));
  children.push(
    actionRow([
      button({
        id: verifyOpenId(panel.guild_id, panel.panel_id),
        label: panel.button_label,
        style: buttonStyle(panel.button_style),
      }),
    ]),
  );
  return container({ accent: accentFor(panel.color), children });
}

// the accent the operator chose in /setup. the wizard preview and the posted
// panel are the same tree (D4PLAN 10.3), so the guild's own colour is used and
// the shipped default is the fallback.
async function panelColour(db: Database, guildId: string): Promise<number> {
  const settings = await getGuildSettings(db, guildId);
  const colour = settings?.verify_panel?.colour ?? DEFAULT_VERIFY_PANEL.colour;
  return hexToInt(colour);
}

/** record a panel. the message comes later: postPanel is what puts it on a
 *  channel, and the row is how an edit finds that message again. */
export async function createPanel(deps: PanelDeps, input: PanelInput): Promise<VerifyPanelRow> {
  const at = deps.now?.() ?? new Date().toISOString();
  const guildId = snowflake(input.guildId);
  const channelId = snowflake(input.channelId);
  if (guildId === null || channelId === null) {
    throw new VerifyPanelError(
      "SB_VERIFY_PANEL_INPUT",
      "the guild and channel ids must be discord ids",
    );
  }
  const title = boundedText(input.title, 256);
  const buttonLabel = boundedText(input.buttonLabel, 80);
  if (title === null || buttonLabel === null) {
    throw new VerifyPanelError(
      "SB_VERIFY_PANEL_INPUT",
      "the panel needs a title and a button label",
    );
  }
  if (!HTTPS.test(input.redirectUri)) {
    throw new VerifyPanelError("SB_VERIFY_PANEL_INPUT", "the redirect uri must be an https url");
  }

  const row: VerifyPanelRow = {
    panel_id: Bun.randomUUIDv7(),
    guild_id: guildId,
    channel_id: channelId,
    message_id: null,
    title,
    description: boundedText(input.description, 2000),
    color: input.color ?? (await panelColour(deps.db, guildId)),
    thumbnail_url: input.thumbnailUrl ?? null,
    button_label: buttonLabel,
    button_style: input.buttonStyle,
    scopes_json: [...input.scopes],
    redirect_uri: input.redirectUri,
    created_at: at,
    updated_at: at,
    enabled: input.enabled,
  };
  await panelsDb.insertPanel(deps.db, row);
  deps.log.info("verify panel recorded", {
    panelId: row.panel_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
  });
  return row;
}

/** post the panel into its channel and remember the message it sent. */
export async function postPanel(
  deps: PanelDeps,
  panel: VerifyPanelRow,
): Promise<{ channelId: string; messageId: string }> {
  const at = deps.now?.() ?? new Date().toISOString();
  const sent = await deps.client.request<{ id?: unknown }>({
    method: "POST",
    route: `/channels/${panel.channel_id}/messages`,
    body: v2Message(panelComponents(panel)),
    timeoutMs: PANEL_TIMEOUT_MS,
  });
  const messageId = typeof sent.id === "string" ? sent.id : null;
  if (messageId === null) {
    throw new VerifyPanelError("SB_VERIFY_PANEL_NO_MESSAGE");
  }
  await panelsDb.setPanelMessage(deps.db, panel.panel_id, messageId, at);
  deps.log.info("verify panel posted", {
    panelId: panel.panel_id,
    guildId: panel.guild_id,
    channelId: panel.channel_id,
  });
  return { channelId: panel.channel_id, messageId };
}

/** change the panel. the message the bot sent is edited in place; a panel that
 *  was never posted has no message to edit and says so. */
export async function editPanel(
  deps: PanelDeps,
  panel: VerifyPanelRow,
  patch: Partial<PanelInput>,
): Promise<VerifyPanelRow> {
  const at = deps.now?.() ?? new Date().toISOString();
  if (patch.channelId !== undefined && snowflake(patch.channelId) !== panel.channel_id) {
    throw new VerifyPanelError(
      "SB_VERIFY_PANEL_INPUT",
      "the channel cannot change: the panel message lives where it was posted",
    );
  }

  // the message id is the row's fact. the copy the caller holds may be the one
  // from before the panel was posted, so the row is read when it carries none.
  const stored = await panelsDb.getPanel(deps.db, panel.panel_id);
  const messageId = panel.message_id ?? stored?.message_id ?? null;
  if (messageId === null) {
    throw new VerifyPanelError("SB_VERIFY_PANEL_NOT_POSTED");
  }

  const next: VerifyPanelRow = {
    ...panel,
    message_id: messageId,
    title: patch.title === undefined ? panel.title : (boundedText(patch.title, 256) ?? panel.title),
    description:
      patch.description === undefined ? panel.description : boundedText(patch.description, 2000),
    button_label:
      patch.buttonLabel === undefined
        ? panel.button_label
        : (boundedText(patch.buttonLabel, 80) ?? panel.button_label),
    button_style: patch.buttonStyle === undefined ? panel.button_style : patch.buttonStyle,
    scopes_json: patch.scopes === undefined ? panel.scopes_json : [...patch.scopes],
    redirect_uri: patch.redirectUri === undefined ? panel.redirect_uri : patch.redirectUri,
    enabled: patch.enabled === undefined ? panel.enabled : patch.enabled,
    updated_at: at,
  };

  await deps.client.request({
    method: "PATCH",
    route: `/channels/${panel.channel_id}/messages/${messageId}`,
    body: v2Message(panelComponents(next)),
    timeoutMs: PANEL_TIMEOUT_MS,
  });
  await panelsDb.updatePanel(deps.db, next);
  deps.log.info("verify panel edited", {
    panelId: next.panel_id,
    guildId: next.guild_id,
    messageId,
  });
  return next;
}

/** turn the panel off. the message stays where it is; the row is what the
 *  server reads, and a disabled panel no longer opens the flow. */
export async function disablePanel(
  deps: { db: Database; log: Logger; now?: () => string },
  panelId: string,
): Promise<void> {
  const at = deps.now?.() ?? new Date().toISOString();
  await panelsDb.setPanelEnabled(deps.db, panelId, false, at);
  deps.log.info("verify panel disabled", { panelId });
}
