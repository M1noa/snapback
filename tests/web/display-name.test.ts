import { describe, expect, test } from "bun:test";
import { DEFAULT_GUILD_SETTINGS } from "../../src/config/defaults.ts";
import { displayName } from "../../src/web/display-name.ts";

// the two web routes both pick the name for a page with this one function, so
// the choice lives in one test: override, then the row, then nothing.

const ROW = {
  guild_id: "144102483157850112",
  name: "nightly",
  icon_url: null,
  owner_user_id: null,
  added_at: null,
  removed_at: null,
  settings_json: null,
};

describe("displayName", () => {
  test("the operator's setting wins over the server's own name", () => {
    const settings = { ...DEFAULT_GUILD_SETTINGS, web_display_name: "the old one" };
    expect(displayName(settings, ROW)).toBe("the old one");
  });

  test("without a setting it is the server's own name", () => {
    expect(displayName(DEFAULT_GUILD_SETTINGS, ROW)).toBe("nightly");
  });

  test("a server the bot knows nothing about names nothing", () => {
    expect(displayName(DEFAULT_GUILD_SETTINGS, null)).toBeNull();
    expect(displayName(null, null)).toBeNull();
  });
});
