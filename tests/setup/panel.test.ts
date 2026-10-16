import { describe, expect, test } from "bun:test";
import { ButtonStyles, ComponentTypes } from "oceanic.js";
import { DEFAULT_VERIFY_PANEL, type VerifyPanelSettings } from "../../src/config/defaults.ts";
import { countComponents, PAGE_LIMIT } from "../../src/discord/components/page.ts";
import { parseCustomId } from "../../src/discord/interactions/router.ts";
import { SetupInputError } from "../../src/setup/deps.ts";
import {
  type PanelContext,
  panelChannelId,
  panelComponents,
  panelDiscardId,
  panelFieldId,
  panelFromValues,
  panelPreviewPage,
  panelSendId,
  panelSummary,
  panelSwatchId,
} from "../../src/setup/panel.ts";

const GUILD = "123456789012345678";
const CTX: PanelContext = { guildId: GUILD, publicBaseUrl: "https://verify.example.com" };
const BASE: VerifyPanelSettings = { ...DEFAULT_VERIFY_PANEL };

interface Walked {
  readonly ids: string[];
  readonly links: string[];
  readonly buttonStyles: number[];
}

function walk(value: unknown, out: Walked): Walked {
  if (value === null || typeof value !== "object") return out;
  const node = value as Record<string, unknown>;
  if (typeof node.customID === "string") out.ids.push(node.customID);
  if (typeof node.url === "string") out.links.push(node.url);
  if (node.type === ComponentTypes.BUTTON && typeof node.style === "number") {
    out.buttonStyles.push(node.style);
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) for (const item of child) walk(item, out);
    else if (typeof child === "object") walk(child, out);
  }
  return out;
}

function inspect(value: unknown): Walked {
  return walk(value, { ids: [], links: [], buttonStyles: [] });
}

describe("panelComponents", () => {
  test("one container, accented with the panel colour", () => {
    const tree = panelComponents(BASE, CTX);
    expect(tree.type).toBe(ComponentTypes.CONTAINER);
    expect(tree.accentColor).toBe(0x5865f2);
  });

  test("exactly one link button, pointing at the derived url", () => {
    const tree = panelComponents(BASE, CTX);
    const seen = inspect(tree);
    expect(seen.links).toEqual(["https://verify.example.com/verify"]);
    expect(seen.buttonStyles).toEqual([ButtonStyles.LINK]);
  });

  test("an explicit button_url wins over the derived one", () => {
    const tree = panelComponents({ ...BASE, button_url: "https://example.com/go" }, CTX);
    expect(inspect(tree).links).toEqual(["https://example.com/go"]);
  });

  test("a link button carries no interactive customID", () => {
    expect(inspect(panelComponents(BASE, CTX)).ids).toEqual([]);
  });

  test("the thumbnail is a section accessory when set, and absent otherwise", () => {
    expect(countComponents(panelComponents(BASE, CTX))).toBe(5);
    const withThumb = panelComponents(
      { ...BASE, thumbnail_url: "https://cdn.example.com/panel.png" },
      CTX,
    );
    expect(countComponents(withThumb)).toBe(7);
    const gallery = walk(withThumb, { ids: [], links: [], buttonStyles: [] });
    expect(gallery.links).toContain("https://cdn.example.com/panel.png");
  });
});

describe("panelFromValues", () => {
  test("rejects a colour that is not a colour", () => {
    expect(() => panelFromValues(BASE, { [panelFieldId(GUILD, "colour")]: "blue" }, CTX)).toThrow(
      SetupInputError,
    );
  });

  test("keeps fields it was not given", () => {
    const panel = panelFromValues(BASE, { [panelFieldId(GUILD, "title")]: "hello" }, CTX);
    expect(panel.title).toBe("hello");
    expect(panel.description).toBe(BASE.description);
    expect(panel.button_label).toBe(BASE.button_label);
    expect(panel.colour).toBe(BASE.colour);
  });

  test("applies a preset swatch carried in the customID", () => {
    const values = { [panelSwatchId(GUILD, "#57f287")]: "1" };
    expect(panelFromValues(BASE, values, CTX).colour).toBe("#57f287");
  });

  test("a non-https thumbnail is ignored, keeping the current one", () => {
    const current: VerifyPanelSettings = { ...BASE, thumbnail_url: "https://a.example.com/x.png" };
    const panel = panelFromValues(
      current,
      { [panelFieldId(GUILD, "thumbnail")]: "http://a.example.com/x.png" },
      CTX,
    );
    expect(panel.thumbnail_url).toBe("https://a.example.com/x.png");
  });

  test("scopes are filtered through the catalogue", () => {
    const values = { [panelFieldId(GUILD, "scopes")]: ["identify", "bogus", "relationships.read"] };
    expect(panelFromValues(BASE, values, CTX).scopes).toEqual(["identify", "relationships.read"]);
  });

  test("the redirect target is always an https url", () => {
    expect(panelFromValues(BASE, {}, CTX).redirect_target).toBe(
      "https://verify.example.com/callback",
    );
    const taken = panelFromValues(
      BASE,
      { [panelFieldId(GUILD, "redirect")]: "https://other.example.com/callback" },
      CTX,
    );
    expect(taken.redirect_target).toBe("https://other.example.com/callback");
    const bad = panelFromValues(
      BASE,
      { [panelFieldId(GUILD, "redirect")]: "http://insecure/callback" },
      CTX,
    );
    expect(bad.redirect_target).toBe("https://verify.example.com/callback");
  });

  test("a channel selection is kept as a string snowflake", () => {
    const panel = panelFromValues(BASE, { [panelChannelId(GUILD)]: "111111111111111111" }, CTX);
    expect(panel.channel_id).toBe("111111111111111111");
  });
});

describe("panelPreviewPage", () => {
  test("stays inside the 40-component cap, thumbnail and all", () => {
    const withThumb: VerifyPanelSettings = { ...BASE, thumbnail_url: "https://cdn/x.png" };
    expect(countComponents(panelPreviewPage(BASE, CTX))).toBeLessThanOrEqual(PAGE_LIMIT);
    expect(countComponents(panelPreviewPage(withThumb, CTX))).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  test("carries send, discard, and a channel select, all on the setup surface", () => {
    const seen = inspect(panelPreviewPage(BASE, CTX));
    const parsed = seen.ids.map((id) => parseCustomId(id));
    for (const parts of parsed) expect(parts.surface).toBe("setup");
    expect(seen.ids).toContain(panelSendId(GUILD));
    expect(seen.ids).toContain(panelDiscardId(GUILD));
    expect(seen.ids).toContain(panelChannelId(GUILD));
  });

  test("previews the real tree: one link button, pointed at the derived url", () => {
    expect(inspect(panelPreviewPage(BASE, CTX)).links).toEqual([
      "https://verify.example.com/verify",
    ]);
  });
});

describe("panelSummary", () => {
  test("describes the panel in short labelled lines", () => {
    const lines = panelSummary(BASE);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes(BASE.title))).toBe(true);
    expect(lines.some((line) => line.includes(BASE.colour))).toBe(true);
  });
});
