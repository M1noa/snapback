import { describe, expect, test } from "bun:test";
import {
  diagnoseCloseCode,
  GATEWAY_INTENTS,
  INTENTS_CHECKLIST,
  LIVE_REACTIONS_INTENT,
} from "../../src/discord/gateway.ts";

// the pure parts of the gateway: the close-code diagnosis table and the intent
// list. the connection itself needs a live token and is not exercised here.

describe("gateway close-code diagnosis (D4PLAN 18.4)", () => {
  test("a known code keeps the code and reason and adds a diagnosis", () => {
    const result = diagnoseCloseCode(4004, "Authentication failed.");
    expect(result.code).toBe(4004);
    expect(result.reason).toBe("Authentication failed.");
    expect(result.diagnosis).toBeString();
    expect(result.diagnosis).toContain("token");
    expect(result.intentsChecklist).toBe(false);
  });

  test("the shard codes get a diagnosis without the intents pointer", () => {
    const invalid = diagnoseCloseCode(4010, "Invalid sharding specified.");
    const required = diagnoseCloseCode(4011, "Shard would handle too many guilds.");
    expect(invalid.diagnosis).toBeString();
    expect(required.diagnosis).toBeString();
    expect(invalid.intentsChecklist).toBe(false);
    expect(required.intentsChecklist).toBe(false);
  });

  test("4013 and 4014 carry the intents checklist pointer", () => {
    const invalid = diagnoseCloseCode(4013, "Invalid intents specified.");
    expect(invalid.intentsChecklist).toBe(true);
    expect(invalid.diagnosis).toContain(INTENTS_CHECKLIST);

    const disallowed = diagnoseCloseCode(4014, "Disallowed intents specified.");
    expect(disallowed.intentsChecklist).toBe(true);
    expect(disallowed.diagnosis).toContain(INTENTS_CHECKLIST);
    // 4014 is the GUILD_MEMBERS toggle; the diagnosis names it, not just the code.
    expect(disallowed.diagnosis).toContain("GUILD_MEMBERS");
  });

  test("an unmapped code is shown raw with the code and reason intact", () => {
    const result = diagnoseCloseCode(4999, "some new close reason");
    expect(result.code).toBe(4999);
    expect(result.reason).toBe("some new close reason");
    expect(result.diagnosis).toBeNull();
    expect(result.intentsChecklist).toBe(false);
  });
});

describe("gateway intents (D4PLAN 7.1)", () => {
  test("requests exactly the seven documented intents", () => {
    expect([...GATEWAY_INTENTS]).toEqual([
      "GUILDS",
      "GUILD_MEMBERS",
      "GUILD_MODERATION",
      "GUILD_EMOJIS_AND_STICKERS",
      "GUILD_VOICE_STATES",
      "GUILD_SCHEDULED_EVENTS",
      "GUILD_MESSAGES",
    ]);
  });

  test("never requests GUILD_PRESENCES or DIRECT_MESSAGES", () => {
    expect(GATEWAY_INTENTS).not.toContain("GUILD_PRESENCES");
    expect(GATEWAY_INTENTS).not.toContain("DIRECT_MESSAGES");
  });

  test("reaction capture is opt-in, off by default", () => {
    expect(GATEWAY_INTENTS).not.toContain("GUILD_MESSAGE_REACTIONS");
    expect(LIVE_REACTIONS_INTENT).toBe("GUILD_MESSAGE_REACTIONS");
  });

  test("has no duplicates", () => {
    expect(new Set(GATEWAY_INTENTS).size).toBe(GATEWAY_INTENTS.length);
  });
});
