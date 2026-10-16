// the verification panel: the one place its component tree is built, so the
// wizard preview and (later) the verify surface post the same thing (D4PLAN
// 10.3). this module builds and validates only; it never posts.

import { ButtonStyles, ChannelTypes, type ContainerComponent } from "oceanic.js";
import { DEFAULT_VERIFY_PANEL, type VerifyPanelSettings } from "../config/defaults.ts";
import { type ContainerChild, container } from "../discord/components/container.ts";
import { section, separator, textDisplay, thumbnail } from "../discord/components/fields.ts";
import { page } from "../discord/components/page.ts";
import { actionRow, button, channelSelect, parseCustomID } from "../discord/components/row.ts";
import { boundedText, hexToInt, normaliseHex, snowflake } from "../lib/validate.ts";
import {
  SETUP_ACTION,
  SETUP_OBJECT,
  SETUP_SURFACE,
  SetupInputError,
  type StepValues,
  setupCustomId,
} from "./deps.ts";
import { SCOPE_CATALOGUE } from "./scopes.ts";

export interface PanelContext {
  readonly guildId: string;
  readonly publicBaseUrl: string;
}

// a panel is posted in a channel people read, so text and announcement channels
// only (D4PLAN 10.3, "type 0 and 5").
export const PANEL_CHANNEL_TYPES: readonly ChannelTypes[] = Object.freeze([
  ChannelTypes.GUILD_TEXT,
  ChannelTypes.GUILD_ANNOUNCEMENT,
]);

const HTTPS = /^https:\/\/\S+$/;
const HEX_BODY = /^[0-9a-f]{6}$/i;

export type PanelField =
  | "title"
  | "description"
  | "colour"
  | "thumbnail"
  | "button_label"
  | "scopes"
  | "ack"
  | "redirect";

/** the key a panel field's control submits under. one builder, so a step's
 *  control and panelFromValues() can never disagree about an id. */
export function panelFieldId(guildId: string, field: PanelField): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.panel,
    action: SETUP_ACTION.preview,
    cursor: field,
  });
}

/** the channel choice, shared by the step and the preview page: it is one
 *  action, so it carries one id (SETUP_ACTION.send, cursor "channel"). */
export function panelChannelId(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.panel,
    action: SETUP_ACTION.send,
    cursor: "channel",
  });
}

/** a preset swatch button carries its colour in the cursor, so a click is the
 *  value: no selection payload in the customID, just the hex (D4PLAN 9.3). */
export function panelSwatchId(guildId: string, hex: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.panel,
    action: SETUP_ACTION.preview,
    cursor: hex.replace(/^#/, "").toLowerCase(),
  });
}

export function panelSendId(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.panel, action: SETUP_ACTION.send });
}

export function panelDiscardId(guildId: string): string {
  return setupCustomId({ guildId, object: SETUP_OBJECT.panel, action: SETUP_ACTION.discard });
}

export function panelAckId(guildId: string): string {
  return panelFieldId(guildId, "ack");
}

/** the real panel tree. one container, the panel colour as accent, the title as
 *  a heading, the body, an optional thumbnail accessory, and one link button. */
export function panelComponents(panel: VerifyPanelSettings, ctx: PanelContext): ContainerComponent {
  const url = panel.button_url ?? `${ctx.publicBaseUrl}/verify`;
  const body = textDisplay(panel.description);
  const children: ContainerChild[] = [textDisplay(`## ${panel.title}`)];
  if (panel.thumbnail_url !== null) {
    children.push(section({ texts: [body], accessory: thumbnail(panel.thumbnail_url) }));
  } else {
    children.push(body);
  }
  // v1 ships a link button: it needs no interaction handler, works before the
  // bot has ever seen the user, and survives a restart (D4PLAN 9.5, 13.1).
  children.push(actionRow([button({ style: ButtonStyles.LINK, url, label: panel.button_label })]));
  const colour = normaliseHex(panel.colour) ?? DEFAULT_VERIFY_PANEL.colour;
  return container({ accent: hexToInt(colour), children });
}

/** validate and normalise a panel submission. an unset field keeps its current
 *  value, so a step only has to submit what the operator touched. */
export function panelFromValues(
  current: VerifyPanelSettings,
  values: StepValues,
  ctx: PanelContext,
): VerifyPanelSettings {
  const guildId = ctx.guildId;

  const title = boundedText(values[panelFieldId(guildId, "title")], 256);
  const description = boundedText(values[panelFieldId(guildId, "description")], 2000);
  const label = boundedText(values[panelFieldId(guildId, "button_label")], 80);
  const thumbnailUrl = httpsUrl(values[panelFieldId(guildId, "thumbnail")]);
  const colour = colourFromValues(guildId, values);

  const chosen = asStringArray(values[panelFieldId(guildId, "scopes")]);
  const scopes =
    chosen === undefined
      ? current.scopes
      : SCOPE_CATALOGUE.filter((entry) => chosen.includes(entry.id)).map((entry) => entry.id);

  const channel = snowflake(values[panelChannelId(guildId)]);

  // the redirect target always resolves to an https url: the caller's own value
  // when it is https, otherwise the derived one. the oauth flow needs the exact
  // registered string (D4PLAN 7.3, 13.3), so it is never left null.
  const redirect = httpsUrl(values[panelFieldId(guildId, "redirect")]);

  return {
    ...current,
    title: title ?? current.title,
    description: description ?? current.description,
    button_label: label ?? current.button_label,
    colour: colour ?? current.colour,
    thumbnail_url: thumbnailUrl ?? current.thumbnail_url,
    scopes,
    channel_id: channel ?? current.channel_id,
    redirect_target: redirect ?? `${ctx.publicBaseUrl}/callback`,
  };
}

/** short lines describing the current panel, for a page body. */
export function panelSummary(panel: VerifyPanelSettings): string[] {
  return [
    `**title** ${panel.title}`,
    `**description** ${panel.description}`,
    `**colour** ${panel.colour}`,
    `**button** ${panel.button_label}`,
    `**thumbnail** ${panel.thumbnail_url ?? "none"}`,
    `**channel** ${panel.channel_id ?? "not chosen"}`,
    `**scopes** ${panel.scopes.length > 0 ? panel.scopes.join(", ") : "none"}`,
  ];
}

/** true when the restricted-scope acknowledgement was ticked this submission. a
 *  checkbox group contributes an array, a single checkbox a string, and a
 *  component left unticked is absent from the payload. */
export function restrictionAcknowledged(values: StepValues, guildId: string): boolean {
  const raw = values[panelAckId(guildId)];
  if (raw === undefined) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  return raw !== "";
}

/** the wizard page that wraps the preview. the real tree sits inside the page
 *  container rather than a nested one (containers never nest, D4PLAN 9.1), and
 *  the panel is posted nowhere until "send to channel" is pressed (10.3). */
export function panelPreviewPage(
  panel: VerifyPanelSettings,
  ctx: PanelContext,
): ContainerComponent {
  const preview = panelComponents(panel, ctx);
  return page({
    state: "info",
    title: "verification panel preview",
    sections: [
      textDisplay(
        "-# this is the real panel, not a mock: what you see is what ships. it posts to this wizard channel only until you send it (D4PLAN 10.3).",
      ),
      separator({ divider: true }),
      ...preview.components,
    ],
    controls: [
      actionRow([
        button({
          id: panelSendId(ctx.guildId),
          label: "send to channel",
          style: ButtonStyles.PRIMARY,
        }),
        button({
          id: panelDiscardId(ctx.guildId),
          label: "discard",
          style: ButtonStyles.SECONDARY,
        }),
      ]),
      actionRow([
        channelSelect({
          id: panelChannelId(ctx.guildId),
          placeholder: "channel to post the panel in",
          channelTypes: [...PANEL_CHANNEL_TYPES],
          minValues: 1,
          maxValues: 1,
        }),
      ]),
    ],
  });
}

function httpsUrl(value: string | readonly string[] | undefined): string | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return HTTPS.test(trimmed) ? trimmed : undefined;
}

function asString(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function asStringArray(
  value: string | readonly string[] | undefined,
): readonly string[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value !== "") return [value];
  return undefined;
}

// the modal hex wins; otherwise a preset swatch button id present in the
// submission carries the pick in its cursor. a non-empty non-hex value is a
// rejection, never a silent fall back to the old colour.
function colourFromValues(guildId: string, values: StepValues): string | undefined {
  const typed = asString(values[panelFieldId(guildId, "colour")]);
  if (typed !== undefined && typed.trim() !== "") {
    const hex = normaliseHex(typed);
    if (hex === null) {
      throw new SetupInputError("colour", "colour must look like #5865f2, 5865f2, or 0x5865f2");
    }
    return hex;
  }
  for (const key of Object.keys(values)) {
    const parts = parseCustomID(key);
    if (parts === null) continue;
    if (parts.surface !== SETUP_SURFACE) continue;
    if (parts.object !== SETUP_OBJECT.panel || parts.action !== SETUP_ACTION.preview) continue;
    const cursor = parts.cursor;
    if (cursor !== undefined && HEX_BODY.test(cursor)) return normaliseHex(cursor) ?? undefined;
  }
  return undefined;
}
