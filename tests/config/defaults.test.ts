import { describe, expect, test } from "bun:test";
import { DEFAULT_GUILD_SETTINGS, readGuildSettings } from "../../src/config/defaults.ts";

describe("readGuildSettings", () => {
  test("an empty row is all defaults", () => {
    expect(readGuildSettings(null)).toEqual(DEFAULT_GUILD_SETTINGS);
    expect(readGuildSettings(undefined)).toEqual(DEFAULT_GUILD_SETTINGS);
    expect(readGuildSettings({})).toEqual(DEFAULT_GUILD_SETTINGS);
  });

  test("a stored key overrides the default", () => {
    const settings = readGuildSettings({ ephemeral_default: false, log_channel_id: "42" });
    expect(settings.ephemeral_default).toBe(false);
    expect(settings.log_channel_id).toBe("42");
    expect(settings.auto_backup_enabled).toBe(false);
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
