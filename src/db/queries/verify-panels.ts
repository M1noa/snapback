// queries/verify-panels.ts. the panel a guild posted (D4PLAN 13.2). one row per
// panel: where it was posted, what it says, and what it asks discord for.
//
// the message id is the point of the row. an edit has to find the message the
// bot already sent, so editing a panel never posts a second one.

import {
  parseJson,
  type SqlValue,
  stringifyJson,
  toBool,
  toId,
  toNumber,
  toText,
} from "../rows.ts";
import type { Database, VerifyPanelRow } from "../types.ts";

const COLUMNS =
  "panel_id, guild_id, channel_id, message_id, title, description, color, thumbnail_url, button_label, button_style, scopes_json, redirect_uri, created_at, updated_at, enabled";

// one placeholder per column, in the same order.
const PLACEHOLDERS = COLUMNS.split(", ")
  .map(() => "?")
  .join(", ");

// the scope list is json, and a hand-edited column may hold anything. only the
// strings are kept, so a broken cell cannot reach the ui.
function toScopes(value: SqlValue): string[] {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function toPanelRow(raw: Record<string, SqlValue>): VerifyPanelRow {
  return {
    panel_id: toId(raw.panel_id) ?? "",
    guild_id: toId(raw.guild_id) ?? "",
    channel_id: toId(raw.channel_id) ?? "",
    message_id: toId(raw.message_id) ?? null,
    title: toText(raw.title) ?? "",
    description: toText(raw.description) ?? null,
    color: toNumber(raw.color) ?? 0,
    thumbnail_url: toText(raw.thumbnail_url) ?? null,
    button_label: toText(raw.button_label) ?? "",
    button_style: toNumber(raw.button_style) ?? 1,
    scopes_json: toScopes(raw.scopes_json),
    redirect_uri: toText(raw.redirect_uri) ?? "",
    created_at: toText(raw.created_at) ?? "",
    updated_at: toText(raw.updated_at) ?? "",
    enabled: toBool(raw.enabled) ?? false,
  };
}

function bind(row: VerifyPanelRow): (string | number | boolean | null)[] {
  return [
    row.panel_id,
    row.guild_id,
    row.channel_id,
    row.message_id,
    row.title,
    row.description,
    row.color,
    row.thumbnail_url,
    row.button_label,
    row.button_style,
    stringifyJson(row.scopes_json),
    row.redirect_uri,
    row.created_at,
    row.updated_at,
    row.enabled,
  ];
}

export async function insertPanel(db: Database, row: VerifyPanelRow): Promise<void> {
  await db.run(`INSERT INTO verify_panels (${COLUMNS}) VALUES (${PLACEHOLDERS})`, bind(row));
}

export async function getPanel(db: Database, panelId: string): Promise<VerifyPanelRow | null> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_panels WHERE panel_id = ?`,
    [panelId],
  );
  const first = rows[0];
  return first === undefined ? null : toPanelRow(first);
}

export async function listPanelsForGuild(db: Database, guildId: string): Promise<VerifyPanelRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_panels WHERE guild_id = ? ORDER BY created_at`,
    [guildId],
  );
  return rows.map(toPanelRow);
}

export async function listEnabledPanelsForGuild(
  db: Database,
  guildId: string,
): Promise<VerifyPanelRow[]> {
  const rows = await db.query<Record<string, SqlValue>>(
    `SELECT ${COLUMNS} FROM verify_panels WHERE guild_id = ? AND enabled = ? ORDER BY created_at`,
    [guildId, true],
  );
  return rows.map(toPanelRow);
}

// the full row. an edit changes the copy and the button, not the panel's id.
export async function updatePanel(db: Database, row: VerifyPanelRow): Promise<void> {
  await db.run(
    `UPDATE verify_panels SET
       guild_id = ?, channel_id = ?, message_id = ?, title = ?, description = ?,
       color = ?, thumbnail_url = ?, button_label = ?, button_style = ?, scopes_json = ?,
       redirect_uri = ?, created_at = ?, updated_at = ?, enabled = ?
     WHERE panel_id = ?`,
    [
      row.guild_id,
      row.channel_id,
      row.message_id,
      row.title,
      row.description,
      row.color,
      row.thumbnail_url,
      row.button_label,
      row.button_style,
      stringifyJson(row.scopes_json),
      row.redirect_uri,
      row.created_at,
      row.updated_at,
      row.enabled,
      row.panel_id,
    ],
  );
}

// the message id is written once, when the panel is posted.
export async function setPanelMessage(
  db: Database,
  panelId: string,
  messageId: string,
  updatedAt: string,
): Promise<void> {
  await db.run("UPDATE verify_panels SET message_id = ?, updated_at = ? WHERE panel_id = ?", [
    messageId,
    updatedAt,
    panelId,
  ]);
}

export async function setPanelEnabled(
  db: Database,
  panelId: string,
  enabled: boolean,
  updatedAt: string,
): Promise<void> {
  await db.run("UPDATE verify_panels SET enabled = ?, updated_at = ? WHERE panel_id = ?", [
    enabled,
    updatedAt,
    panelId,
  ]);
}
