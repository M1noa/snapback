// the boot invite link: the url shape is the contract, the permission integer
// is spelled out bit by bit so a new bit shows as a reviewed diff here.

import { describe, expect, test } from "bun:test";
import { inviteLink } from "../../src/discord/invite.ts";

describe("inviteLink", () => {
  test("carries the client id, both scopes, and the working permission set", () => {
    const url = new URL(inviteLink("123456789012345678"));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123456789012345678");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    // capture: view 1024 + history 65536
    // config: guild 32 + channels 16
    // rebuild: roles 268435456 + webhooks 536870912 + expressions 1073741824
    //          + events 8589934592
    // restore: threads 17179869184 + send 2048 + bans 2
    expect(url.searchParams.get("permissions")).toBe("27648920626");
  });
});
