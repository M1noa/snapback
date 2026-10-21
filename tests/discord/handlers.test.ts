import { describe, expect, test } from "bun:test";
import type { AnyInteractionGateway } from "oceanic.js";
import type { SlashCommand } from "../../src/discord/commands/types.ts";
import { IS_COMPONENTS_V2 } from "../../src/discord/components/container.ts";
import { textDisplay } from "../../src/discord/components/fields.ts";
import { countComponents, page } from "../../src/discord/components/page.ts";
import type { V2Payload } from "../../src/discord/interactions/dispatch.ts";
import {
  createAuthorizer,
  createInteractionHandler,
} from "../../src/discord/interactions/handlers.ts";
import { Router } from "../../src/discord/interactions/router.ts";
import type { LogFields, Logger, LogLevel } from "../../src/lib/log.ts";

const OWNER = "100000000000000001";
const GUILD = "200000000000000002";
const OTHER_GUILD = "300000000000000003";

function quietLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const sink = {
    level: "debug" as LogLevel,
    debug: (msg: string) => lines.push(`debug ${msg}`),
    info: (msg: string) => lines.push(`info ${msg}`),
    warn: (msg: string) => lines.push(`warn ${msg}`),
    error: (msg: string, _fields?: LogFields) => lines.push(`error ${msg}`),
    async flush() {},
    lines,
  };
  return sink;
}

// the page text, flattened: the assertions are about what the user reads.
function textOf(payload: V2Payload): string {
  const parts: string[] = [];
  for (const child of payload.components) {
    for (const node of child.components ?? []) {
      if (node.type === 10) parts.push(node.content);
    }
  }
  return parts.join("\n");
}

function echoCommand(): SlashCommand {
  return {
    group: "snapback",
    subcommand: "status",
    description: "test command",
    run: () => ({
      page: page({ state: "success", title: "ok", sections: [textDisplay("fine")] }),
      ephemeral: true,
    }),
  };
}

interface Reply {
  payload: V2Payload;
  mode: "reply" | "update" | "defer";
}

function fakeInteraction(
  overrides: {
    userId?: string;
    guildId?: string | null;
    commandName?: string;
    raw?: unknown[];
    customId?: string;
    /** the member's computed perms, as oceanic exposes them on every guild
     *  interaction. null is the dm shape and reads as unknown. */
    memberPermissions?: bigint | null;
  } = {},
): { interaction: AnyInteractionGateway; replies: Reply[] } {
  const replies: Reply[] = [];
  const userId = overrides.userId ?? OWNER;
  const guildId = overrides.guildId === undefined ? GUILD : overrides.guildId;
  const customId = overrides.customId;

  const interaction = {
    acknowledged: false,
    user: { id: userId },
    memberPermissions: overrides.memberPermissions ?? null,
    guildID: guildId,
    isCommandInteraction: () => customId === undefined,
    isComponentInteraction: () => customId !== undefined,
    isModalSubmitInteraction: () => false,
    // a button, not a select: the surface reads values from a select only, and
    // this is what tells the two apart.
    isSelectMenuComponentInteraction: () => false,
    data:
      customId === undefined
        ? {
            name: overrides.commandName ?? "snapback",
            // discord always nests a subcommand option; the default mirrors that.
            options: { raw: overrides.raw ?? [{ name: "status", type: 1, options: [] }] },
          }
        : { customID: customId },
    async createMessage(payload: V2Payload) {
      replies.push({ payload, mode: "reply" });
    },
    async editParent(payload: V2Payload) {
      replies.push({ payload, mode: "update" });
    },
    async deferUpdate() {
      replies.push({ payload: { flags: 0, components: [] }, mode: "defer" });
    },
  };
  return { interaction: interaction as unknown as AnyInteractionGateway, replies };
}

function handler(
  options: {
    isGuildAdmin?: (u: string, g: string) => boolean;
    guildOwner?: string | null;
    log?: Logger;
  } = {},
) {
  const log = options.log ?? quietLogger();
  const router = new Router({
    authorize: createAuthorizer({
      ownerId: OWNER,
      guildOwnerId: async () => options.guildOwner ?? null,
      isGuildAdmin: options.isGuildAdmin ?? (() => false),
    }),
  });
  return {
    onInteraction: createInteractionHandler({
      commands: [echoCommand()],
      router,
      ownerId: OWNER,
      guildOwnerId: async () => options.guildOwner ?? null,
      log,
      isGuildAdmin: options.isGuildAdmin ?? (() => false),
    }),
    router,
    log,
  };
}

describe("slash commands", () => {
  test("the owner gets the page", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction();
    await onInteraction(interaction);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.mode).toBe("reply");
    expect(textOf(replies[0]!.payload)).toContain("fine");
  });

  test("a granted admin gets the page", async () => {
    const { onInteraction } = handler({ isGuildAdmin: () => true });
    const { interaction, replies } = fakeInteraction({ userId: "900000000000000009" });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("fine");
  });

  test("a demoted admin is refused", async () => {
    // the same user, with the grant no longer in guild_admins.
    const { onInteraction } = handler({ isGuildAdmin: () => false });
    const { interaction, replies } = fakeInteraction({ userId: "900000000000000009" });
    await onInteraction(interaction);

    const payload = replies[0]!.payload;
    expect(textOf(payload)).toContain("not permitted");
    expect(textOf(payload)).toContain("not a Snapback admin");
    expect(textOf(payload)).toContain("SB_ACCESS_DENIED");
  });

  test("a refusal is ephemeral and carries the v2 flag", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({ userId: "900000000000000009" });
    await onInteraction(interaction);

    const flags = replies[0]!.payload.flags;
    expect(flags & IS_COMPONENTS_V2).toBe(IS_COMPONENTS_V2);
    expect(flags & 64).toBe(64);
  });

  test("a command this build does not have fails closed", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({ commandName: "ghost" });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("unknown command");
  });

  test("a command with no guild is refused, not crashed", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({ guildId: null });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("commands work in a server");
  });

  test("a discord administrator passes the gate without a db grant", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({
      userId: "900000000000000009",
      memberPermissions: 8n,
    });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("fine");
  });

  test("the server's owner passes the gate without a db grant", async () => {
    const { onInteraction } = handler({ guildOwner: "900000000000000009" });
    const { interaction, replies } = fakeInteraction({ userId: "900000000000000009" });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("fine");
  });

  test("a member with no trusted bit and no db grant is refused", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({
      userId: "900000000000000009",
      memberPermissions: 2048n,
    });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("not permitted");
  });

  test("a command that throws is logged and not rethrown", async () => {
    const log = quietLogger();
    const router = new Router({ authorize: () => ({ kind: "allow" }) });
    const onInteraction = createInteractionHandler({
      commands: [
        {
          group: "snapback",
          subcommand: "status",
          description: "boom",
          run: () => {
            throw new Error("command exploded");
          },
        },
      ],
      router,
      ownerId: OWNER,
      guildOwnerId: async () => null,
      log,
      isGuildAdmin: () => false,
    });

    const { interaction } = fakeInteraction();
    await onInteraction(interaction); // must resolve, not reject
    expect(log.lines.some((line) => line.includes("interaction handler threw"))).toBe(true);
    expect(log.lines.some((line) => line.includes("command exploded"))).toBe(false);
  });

  test("subcommand options are flattened for the command", async () => {
    const seen: Record<string, unknown>[] = [];
    const router = new Router({ authorize: () => ({ kind: "allow" }) });
    const onInteraction = createInteractionHandler({
      commands: [
        {
          group: "snapback",
          subcommand: "status",
          description: "records options",
          run: (ctx) => {
            seen.push(ctx.options);
            return { page: page({ state: "info", title: "ok", sections: [] }), ephemeral: true };
          },
        },
      ],
      router,
      ownerId: OWNER,
      guildOwnerId: async () => null,
      log: quietLogger(),
      isGuildAdmin: () => false,
    });

    const { interaction } = fakeInteraction({
      raw: [
        {
          name: "status",
          type: 1,
          options: [{ name: "backup", type: 3, value: "b-1" }],
        },
      ],
    });
    await onInteraction(interaction);

    expect(seen[0]).toEqual({ backup: "b-1" });
  });
});

describe("component interactions", () => {
  test("a discord admin presses a control without a db grant", async () => {
    let ran = false;
    const { onInteraction, router } = handler();
    router.register("setup", "save", () => {
      ran = true;
      return { kind: "noop" };
    });

    const { interaction } = fakeInteraction({
      userId: "900000000000000009",
      customId: `sb:setup:${GUILD}:x:save:`,
      memberPermissions: 32n,
    });
    await onInteraction(interaction);

    expect(ran).toBe(true);
  });

  test("a member with no trusted lane stays out of the controls", async () => {
    let ran = false;
    const { onInteraction, router } = handler();
    router.register("setup", "save", () => {
      ran = true;
      return { kind: "noop" };
    });

    const { interaction, replies } = fakeInteraction({
      userId: "900000000000000009",
      customId: `sb:setup:${GUILD}:x:save:`,
      memberPermissions: 2048n,
    });
    await onInteraction(interaction);

    expect(ran).toBe(false);
    expect(textOf(replies[0]!.payload)).toContain("not permitted");
  });

  test("an id minted for another guild is refused before the handler runs", async () => {
    let ran = false;
    const { onInteraction, router } = handler();
    router.register("setup", "save", () => {
      ran = true;
      return { kind: "noop" };
    });

    const { interaction, replies } = fakeInteraction({
      customId: `sb:setup:${OTHER_GUILD}:x:save:`,
    });
    await onInteraction(interaction);

    expect(ran).toBe(false);
    expect(textOf(replies[0]!.payload)).toContain("different server");
  });

  test("an unregistered surface shows the stale page by editing the message", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({ customId: `sb:setup:${GUILD}:x:ghost:` });
    await onInteraction(interaction);

    expect(replies[0]?.mode).toBe("update");
    expect(textOf(replies[0]!.payload)).toContain("out of date");
  });

  test("a malformed id is stale, not a crash", async () => {
    const { onInteraction } = handler();
    const { interaction, replies } = fakeInteraction({ customId: "sb:not-enough" });
    await onInteraction(interaction);

    expect(textOf(replies[0]!.payload)).toContain("out of date");
  });

  test("a handler that throws reports the message verbatim", async () => {
    const log = quietLogger();
    const { onInteraction, router } = handler({ log });
    router.register("setup", "save", () => {
      throw new Error("discord said no");
    });

    const { interaction, replies } = fakeInteraction({ customId: `sb:setup:${GUILD}:x:save:` });
    await onInteraction(interaction);

    const text = textOf(replies[0]!.payload);
    expect(text).toContain("that control failed");
    expect(text).toContain("discord said no");
    expect(log.lines.some((line) => line.includes("handler threw"))).toBe(true);
  });

  test("a deferred handler is acknowledged without a second reply", async () => {
    const { onInteraction, router } = handler();
    router.register("backup", "create", () => ({ kind: "deferred", jobId: "j-1" }));

    const { interaction, replies } = fakeInteraction({
      customId: `sb:backup:${GUILD}:new:create:`,
    });
    await onInteraction(interaction);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.mode).toBe("defer");
  });

  test("a handler that answered itself is not answered twice", async () => {
    const { onInteraction, router } = handler();
    router.register("backup", "create", () => ({ kind: "reply" }));

    const { interaction, replies } = fakeInteraction({
      customId: `sb:backup:${GUILD}:new:create:`,
    });
    await onInteraction(interaction);

    expect(replies).toHaveLength(0);
  });

  test("every refusal stays inside the 40 component cap", async () => {
    const { onInteraction } = handler();
    for (const customId of [
      `sb:setup:${GUILD}:x:ghost:`,
      `sb:setup:${OTHER_GUILD}:x:save:`,
      "sb:broken",
    ]) {
      const { interaction, replies } = fakeInteraction({ customId });
      await onInteraction(interaction);
      expect(countComponents(replies[0]!.payload.components[0])).toBeLessThanOrEqual(40);
    }
  });
});
