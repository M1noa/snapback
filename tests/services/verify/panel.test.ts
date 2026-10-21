// tests/services/verify/panel.test.ts - the panel is a message in a channel
// with a button, and the row behind it is what an edit finds that message by.
//
// a real duckdb file in a temp dir and a client that records every request, so
// the test can prove the panel was posted once and edited in place afterwards.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentTypes, type ContainerComponent } from "oceanic.js";
import { openDuckDB } from "../../../src/db/duckdb.ts";
import { migrate } from "../../../src/db/migrate.ts";
import * as panelsDb from "../../../src/db/queries/verify-panels.ts";
import type { Database } from "../../../src/db/types.ts";
import { DiscordClient } from "../../../src/discord/client.ts";
import { IS_COMPONENTS_V2 } from "../../../src/discord/components/container.ts";
import { customID, parseCustomID } from "../../../src/discord/components/row.ts";
import { type Clock, RateLimiter } from "../../../src/discord/ratelimit.ts";
import { createLogger } from "../../../src/lib/log.ts";
import {
  createPanel,
  disablePanel,
  editPanel,
  type PanelInput,
  panelComponents,
  postPanel,
} from "../../../src/services/verify/panel.ts";

const GUILD = "144102483157850112";
const CHANNEL = "222222222222222222";
const REDIRECT = "https://verify.example/callback";
const MESSAGE_ID = "900100900100900100";

class FakeClock implements Clock {
  #now = 0;
  async sleep(ms: number): Promise<void> {
    this.#now += ms;
  }
  now(): number {
    return this.#now;
  }
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

// the client records what it sent and answers with a message id, so a test can
// see exactly which routes were touched.
function recordingClient(): { client: DiscordClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify({ id: MESSAGE_ID }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new DiscordClient({
    token: "test-token",
    fetchImpl,
    limiter: new RateLimiter({ clock: new FakeClock() }),
  });
  return { client, calls };
}

// the one button the panel carries, found by walking the tree.
// the button union includes the premium variant, which has no custom id, so the
// helper returns the ordinary one.
interface PlainButton {
  readonly customID?: string;
}

function findButton(tree: ContainerComponent): PlainButton {
  for (const child of tree.components) {
    if (child.type !== ComponentTypes.ACTION_ROW) continue;
    for (const item of child.components) {
      // the button union includes the premium variant, which has no custom id.
      if (item.type === ComponentTypes.BUTTON && "customID" in item) {
        return item as PlainButton;
      }
    }
  }
  throw new Error("the panel has no button");
}

let dir: string;
let db: Database;
let client: DiscordClient;
let calls: Call[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snapback-verify-panel-"));
  db = await openDuckDB(join(dir, "snapback.duckdb"));
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  const recorded = recordingClient();
  client = recorded.client;
  calls = recorded.calls;
});

function deps(): { client: DiscordClient; db: Database; log: ReturnType<typeof createLogger> } {
  return { client, db, log: createLogger({ level: "error", dir: null }) };
}

function input(overrides: Partial<PanelInput> = {}): PanelInput {
  return {
    guildId: GUILD,
    channelId: CHANNEL,
    title: "verify to join",
    description: "verify with discord to get access to this server.",
    buttonLabel: "Verify",
    buttonStyle: 1,
    scopes: ["identify", "email"],
    redirectUri: REDIRECT,
    enabled: true,
    ...overrides,
  };
}

describe("the verify panel", () => {
  test("the row carries the channel, the message, the scopes and the redirect uri", async () => {
    const panel = await createPanel(deps(), input());

    expect(panel.guild_id).toBe(GUILD);
    expect(panel.channel_id).toBe(CHANNEL);
    expect(panel.scopes_json).toEqual(["identify", "email"]);
    expect(panel.redirect_uri).toBe(REDIRECT);
    // nothing is posted until postPanel runs, so there is no message yet.
    expect(panel.message_id).toBeNull();

    const posted = await postPanel(deps(), panel);
    expect(posted).toEqual({ channelId: CHANNEL, messageId: MESSAGE_ID });

    const stored = await panelsDb.getPanel(db, panel.panel_id);
    expect(stored?.message_id).toBe(MESSAGE_ID);
    expect(stored?.scopes_json).toEqual(["identify", "email"]);
    expect(stored?.redirect_uri).toBe(REDIRECT);
  });

  test("the panel is a components v2 container", async () => {
    const panel = await createPanel(deps(), input());
    await postPanel(deps(), panel);

    const post = calls.find((call) => call.method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(post?.body ?? "{}") as {
      flags?: number;
      components?: { type?: number }[];
    };
    expect(body.flags).toBe(IS_COMPONENTS_V2);
    expect(body.components?.[0]?.type).toBe(ComponentTypes.CONTAINER);
  });

  test("the button's custom id is built with the factory and parses", async () => {
    const panel = await createPanel(deps(), input());
    const found = findButton(panelComponents(panel));

    expect(found.customID).toBe(
      customID({ surface: "verify", guild: GUILD, object: panel.panel_id, action: "open" }),
    );

    const parsed = parseCustomID(found.customID ?? "");
    expect(parsed?.surface).toBe("verify");
    expect(parsed?.guild).toBe(GUILD);
    expect(parsed?.object).toBe(panel.panel_id);
    expect(parsed?.action).toBe("open");
  });

  test("the copy only points at the consent screen", () => {
    const panel = {
      panel_id: "p",
      guild_id: GUILD,
      channel_id: CHANNEL,
      message_id: null,
      title: "verify to join",
      description: "verify with discord to get access to this server.",
      color: 0x5865f2,
      thumbnail_url: null,
      button_label: "Verify",
      button_style: 1,
      scopes_json: ["identify", "email"],
      redirect_uri: REDIRECT,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      enabled: true,
    };
    const texts = panelComponents(panel)
      .components.filter((child) => child.type === ComponentTypes.TEXT_DISPLAY)
      .map((child) => (child.type === ComponentTypes.TEXT_DISPLAY ? child.content : ""));

    const body = texts.join("\n");
    expect(body).toContain("verify to join");
    expect(body).toContain("consent screen");
    // no lure, no reward, no list of what is kept: the panel defers to discord's
    // own consent screen for what it asks for.
    expect(body).not.toContain("nitro");
    expect(body).not.toContain("free");
    expect(body).not.toContain("gift");
    expect(body).not.toContain("revoke");
  });

  test("editing the panel edits the message it posted, and posts no second one", async () => {
    const panel = await createPanel(deps(), input());
    await postPanel(deps(), panel);

    const edited = await editPanel(deps(), panel, {
      title: "verify to join the server",
      buttonLabel: "Check in",
    });

    const posts = calls.filter((call) => call.method === "POST");
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain(`/channels/${CHANNEL}/messages/${MESSAGE_ID}`);
    expect(patches[0]?.body).toContain("verify to join the server");
    expect(patches[0]?.body).toContain("Check in");

    expect(edited.title).toBe("verify to join the server");
    const stored = await panelsDb.getPanel(db, panel.panel_id);
    expect(stored?.title).toBe("verify to join the server");
    expect(stored?.message_id).toBe(MESSAGE_ID);
  });

  test("a panel that was never posted has no message to edit", async () => {
    const panel = await createPanel(deps(), input());
    await expect(editPanel(deps(), panel, { title: "new" })).rejects.toThrow(
      /SB_VERIFY_PANEL_NOT_POSTED/,
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("disabling it flips the row's flag", async () => {
    const panel = await createPanel(deps(), input());
    expect((await panelsDb.getPanel(db, panel.panel_id))?.enabled).toBe(true);

    await disablePanel({ db, log: createLogger({ level: "error", dir: null }) }, panel.panel_id);

    const stored = await panelsDb.getPanel(db, panel.panel_id);
    expect(stored?.enabled).toBe(false);
    // disabling is a row, not a message: the panel stays where it was posted.
    expect(calls).toHaveLength(0);
  });
});
