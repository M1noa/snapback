import { describe, expect, test } from "bun:test";
import {
  BACKUP_INCLUDE_KEYS,
  DEFAULT_BACKUP_INCLUDE,
  DEFAULT_GUILD_SETTINGS,
  DEFAULT_VERIFY_PANEL,
  LOG_EVENT_FAMILIES,
  mergeGuildSettings,
  readGuildSettings,
} from "../../src/config/defaults.ts";

describe("readGuildSettings", () => {
  test("an empty row is all defaults", () => {
    expect(readGuildSettings(null)).toEqual(DEFAULT_GUILD_SETTINGS);
    expect(readGuildSettings(undefined)).toEqual(DEFAULT_GUILD_SETTINGS);
    expect(readGuildSettings({})).toEqual(DEFAULT_GUILD_SETTINGS);
  });

  test("a stored key overrides the default", () => {
    // a real-shaped snowflake, because an id field now rejects anything that is
    // not one: the old "42" fixture was passing only while ids were unchecked.
    const channelId = "123456789012345678";
    const settings = readGuildSettings({ ephemeral_default: false, log_channel_id: channelId });
    expect(settings.ephemeral_default).toBe(false);
    expect(settings.log_channel_id).toBe(channelId);
    expect(settings.auto_backup_enabled).toBe(false);
  });

  test("web_display_name only stores text, blank means unset", () => {
    expect(readGuildSettings({}).web_display_name).toBeNull();
    expect(readGuildSettings({ web_display_name: 42 }).web_display_name).toBeNull();
    expect(readGuildSettings({ web_display_name: "  " }).web_display_name).toBeNull();
    // trimmed on the way in, and clamped to the same ceiling the modal clamps to.
    expect(readGuildSettings({ web_display_name: " nightly " }).web_display_name).toBe("nightly");
    expect(readGuildSettings({ web_display_name: "x".repeat(140) }).web_display_name).toHaveLength(
      100,
    );
  });

  test("a value of the wrong type is ignored, not coerced", () => {
    const settings = readGuildSettings({
      ephemeral_default: "false",
      auto_backup_interval_hours: "24",
    });
    expect(settings.ephemeral_default).toBe(true);
    expect(settings.auto_backup_interval_hours).toBe(24);
  });

  test("a non object row is all defaults", () => {
    expect(readGuildSettings("nonsense")).toEqual(DEFAULT_GUILD_SETTINGS);
    expect(readGuildSettings([1, 2])).toEqual(DEFAULT_GUILD_SETTINGS);
  });

  test("a hint is never read as a snowflake number", () => {
    const settings = readGuildSettings({ log_channel_id: 123456789012345678n });
    expect(settings.log_channel_id).toBeNull();
  });

  test("returned settings do not alias the frozen defaults", () => {
    const settings = readGuildSettings({});
    settings.auto_backup_enabled = true;
    expect(DEFAULT_GUILD_SETTINGS.auto_backup_enabled).toBe(false);
  });
});

describe("the wizard and panel fields", () => {
  test("every family is on by default, and an unknown one is dropped", () => {
    expect(DEFAULT_GUILD_SETTINGS.log_events).toEqual(LOG_EVENT_FAMILIES);
    const settings = readGuildSettings({ log_events: ["backup", "nonsense", 7] });
    expect(settings.log_events).toEqual(["backup"]);
  });

  test("a panel of the wrong shape is no panel at all", () => {
    expect(readGuildSettings({ verify_panel: "yes please" }).verify_panel).toBeNull();
    expect(readGuildSettings({ verify_panel: [] }).verify_panel).toBeNull();
    expect(
      readGuildSettings({ verify_panel: { channel_id: 7 } }).verify_panel?.channel_id,
    ).toBeNull();
  });

  test("a panel round trips, and a bad colour falls back to the default", () => {
    const stored = readGuildSettings({
      verify_panel: {
        channel_id: "123456789012345678",
        title: "  verify here  ",
        colour: "naughty",
        button_label: "let me in",
        button_style: "link",
        button_url: "https://example.com/verify",
        button_mode: "embed",
        scopes: ["identify", "identify", 3],
      },
    });
    const panel = stored.verify_panel!;
    expect(panel.channel_id).toBe("123456789012345678");
    expect(panel.title).toBe("verify here");
    expect(panel.colour).toBe(DEFAULT_VERIFY_PANEL.colour);
    expect(panel.button_label).toBe("let me in");
    expect(panel.button_style).toBe("link");
    expect(panel.button_mode).toBe("embed");
    expect(panel.scopes).toEqual(["identify"]);
  });

  test("a non-https button url is refused, not stored", () => {
    expect(
      readGuildSettings({ verify_panel: { button_url: "http://example.com" } }).verify_panel
        ?.button_url,
    ).toBeNull();
    expect(
      readGuildSettings({ verify_panel: { button_url: "javascript:alert(1)" } }).verify_panel
        ?.button_url,
    ).toBeNull();
    expect(
      readGuildSettings({ verify_panel: { button_url: "https://example.com/verify" } }).verify_panel
        ?.button_url,
    ).toBe("https://example.com/verify");
  });

  test("branding keeps the display name and the two flags", () => {
    const branding = readGuildSettings({
      branding: { display_name: "  snapback  ", avatar_set: true, banner_set: "yes" },
    }).branding;
    expect(branding.display_name).toBe("snapback");
    expect(branding.avatar_set).toBe(true);
    expect(branding.banner_set).toBe(false);
  });

  test("the restricted-scope acknowledgement keeps only a real timestamp", () => {
    expect(
      readGuildSettings({ acknowledged_restricted_scopes: "yesterday" })
        .acknowledged_restricted_scopes,
    ).toBeNull();
    expect(
      readGuildSettings({ acknowledged_restricted_scopes: "2026-10-16T12:00:00.000Z" })
        .acknowledged_restricted_scopes,
    ).toBe("2026-10-16T12:00:00.000Z");
  });

  test("a number out of range is clamped on read, so a hand-edited row cannot exceed the limit", () => {
    expect(readGuildSettings({ auto_backup_interval_hours: 9999 }).auto_backup_interval_hours).toBe(
      168,
    );
    expect(readGuildSettings({ auto_backup_interval_hours: 0 }).auto_backup_interval_hours).toBe(1);
    expect(
      readGuildSettings({ auto_backup_message_count: 999_999 }).auto_backup_message_count,
    ).toBe(10_000);
  });
});

describe("the backup fields", () => {
  test("every category is captured by default", () => {
    const settings = readGuildSettings({});
    for (const key of BACKUP_INCLUDE_KEYS) {
      expect(settings.backup_include[key]).toBe(true);
    }
  });

  test("one category can be turned off without touching the others", () => {
    const include = readGuildSettings({
      backup_include: { messages: false, members: false },
    }).backup_include;
    expect(include.messages).toBe(false);
    expect(include.members).toBe(false);
    expect(include.roles).toBe(true);
    expect(include.bans).toBe(true);
  });

  test("a non-boolean category falls back to on, and an unknown key is dropped", () => {
    const include = readGuildSettings({
      backup_include: { roles: "no", sounds: false },
    }).backup_include;
    expect(include.roles).toBe(true);
    expect(Object.keys(include).sort()).toEqual([...BACKUP_INCLUDE_KEYS].sort());
  });

  test("message types default to conversation only", () => {
    expect(readGuildSettings({}).backup_message_types).toEqual([0, 19, 20]);
  });

  test("message types are deduped, sorted, and kept inside the discord range", () => {
    expect(
      readGuildSettings({ backup_message_types: [20, 0, 20, 19] }).backup_message_types,
    ).toEqual([0, 19, 20]);
    expect(readGuildSettings({ backup_message_types: [7, 999, -1] }).backup_message_types).toEqual([
      7,
    ]);
    expect(readGuildSettings({ backup_message_types: "all" }).backup_message_types).toEqual([
      0, 19, 20,
    ]);
    // a fractional id is not a type, and dropping is not the same as defaulting
    expect(readGuildSettings({ backup_message_types: [19.5, 0] }).backup_message_types).toEqual([
      0,
    ]);
    expect(readGuildSettings({ backup_message_types: [] }).backup_message_types).toEqual([]);
  });

  test("the two backup fields survive a patch like any other field", () => {
    const merged = mergeGuildSettings(readGuildSettings({}), {
      backup_include: { ...DEFAULT_BACKUP_INCLUDE, messages: false },
      backup_message_types: [0, 7, 19, 20],
    });
    expect(merged.backup_include.messages).toBe(false);
    expect(merged.backup_message_types).toEqual([0, 7, 19, 20]);
  });
});

describe("mergeGuildSettings", () => {
  test("a patch goes through the same validation as a stored row", () => {
    const merged = mergeGuildSettings(readGuildSettings({}), {
      log_channel_id: "123456789012345678",
      auto_backup_interval_hours: 5000,
    });
    expect(merged.log_channel_id).toBe("123456789012345678");
    expect(merged.auto_backup_interval_hours).toBe(168);
  });

  test("fields the patch does not name are left alone", () => {
    const current = readGuildSettings({ notify_on_join: true });
    const merged = mergeGuildSettings(current, { ephemeral_default: false });
    expect(merged.notify_on_join).toBe(true);
    expect(merged.ephemeral_default).toBe(false);
  });

  test("a patch cannot smuggle in an unknown key", () => {
    const merged = mergeGuildSettings(readGuildSettings({}), {
      something_else: true,
    } as never);
    expect(Object.hasOwn(merged, "something_else")).toBe(false);
  });
});
