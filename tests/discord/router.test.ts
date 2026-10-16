import { describe, expect, test } from "bun:test";
import { customID } from "../../src/discord/components/row.ts";
import {
  type AuthDecision,
  CustomIdParseError,
  type CustomIdSpec,
  DuplicateHandlerError,
  type InteractionIdentity,
  type JobRequest,
  parseCustomId,
  Router,
  UnhandledCustomIdsError,
} from "../../src/discord/interactions/router.ts";

const GUILD = "100000000000000001";
const OWNER = "200000000000000002";

const identity: InteractionIdentity = { userId: OWNER, guildId: GUILD, isOwner: true };

const allow = (): AuthDecision => ({ kind: "allow" });
const deny = (): AuthDecision => ({
  kind: "deny",
  reason: { code: "SB_NOT_ADMIN", message: "not permitted" },
});

describe("parseCustomId", () => {
  test("parses a well-formed id into its slots", () => {
    const id = parseCustomId(`sb:backup:${GUILD}:list:page:2`);
    expect(id.surface).toBe("backup");
    expect(id.guild).toBe(GUILD);
    expect(id.object).toBe("list");
    expect(id.action).toBe("page");
    expect(id.cursor).toBe("2");
  });

  test("allows an empty cursor", () => {
    expect(parseCustomId(`sb:setup:${GUILD}:wizard:open:`).cursor).toBe("");
  });

  test("fails closed on a malformed id", () => {
    const bad = [
      "",
      "not-a-snapback-id",
      "backup:1:2:3:4", // no prefix
      `SB:backup:${GUILD}:list:page:2`, // case-sensitive prefix
      `sb:backup:${GUILD}:list:page`, // five slots, not six
      `sb:backup:${GUILD}:list:page:2:extra`, // seven slots
      `sb:backup:${GUILD}:list:PAGE:2`, // action not a lowercase identifier
      `sb:backup::list:page:2`, // empty guild slot
      `sb:backup:1\u001f2:obj:page:2`, // the \x1f separator is banned
    ];
    for (const raw of bad) expect(() => parseCustomId(raw)).toThrow(CustomIdParseError);
  });

  test("rejects an overlong id", () => {
    const raw = `sb:backup:${GUILD}:list:page:${"9".repeat(120)}`;
    expect(() => parseCustomId(raw)).toThrow(CustomIdParseError);
  });
});

describe("handler registry", () => {
  test("a duplicate registration throws", () => {
    const router = new Router({ authorize: allow, enqueue: () => {} });
    router.register("backup", "page", () => ({ kind: "noop" }));
    expect(() => router.register("backup", "page", () => ({ kind: "noop" }))).toThrow(
      DuplicateHandlerError,
    );
  });

  test("the boot assertion reports every unhandled id at once", () => {
    const router = new Router({ authorize: allow, enqueue: () => {} });
    router.register("backup", "page", () => ({ kind: "noop" }));

    const produced: CustomIdSpec[] = [
      { surface: "backup", action: "page" },
      { surface: "restore", action: "start" },
      { surface: "verify", action: "refresh" },
      { surface: "restore", action: "start" }, // duplicate spec, counted once
    ];

    expect(router.missing(produced)).toEqual([
      { surface: "restore", action: "start" },
      { surface: "verify", action: "refresh" },
    ]);

    let thrown: UnhandledCustomIdsError | undefined;
    try {
      router.assertComplete(produced);
    } catch (error) {
      thrown = error as UnhandledCustomIdsError;
    }
    expect(thrown).toBeInstanceOf(UnhandledCustomIdsError);
    expect(thrown?.missing).toHaveLength(2);
    expect(thrown?.message).toContain("restore:start");
    expect(thrown?.message).toContain("verify:refresh");

    router.register("restore", "start", () => ({ kind: "noop" }));
    router.register("verify", "refresh", () => ({ kind: "noop" }));
    expect(() => router.assertComplete(produced)).not.toThrow();
  });
});

describe("authorisation before the handler", () => {
  test("the hook runs first, then the handler", async () => {
    const order: string[] = [];
    const router = new Router({
      authorize: () => {
        order.push("auth");
        return { kind: "allow" };
      },
      enqueue: () => {},
    });
    router.register("backup", "page", () => {
      order.push("handler");
      return { kind: "noop" };
    });

    const outcome = await router.route(`sb:backup:${GUILD}:list:page:1`, identity);
    expect(outcome.kind).toBe("handled");
    expect(order).toEqual(["auth", "handler"]);
  });

  test("a deny short-circuits and the handler never runs", async () => {
    let ran = false;
    const router = new Router({ authorize: deny, enqueue: () => {} });
    router.register("backup", "page", () => {
      ran = true;
      return { kind: "noop" };
    });

    const outcome = await router.route(`sb:backup:${GUILD}:list:page:1`, identity);
    expect(outcome.kind).toBe("denied");
    expect(ran).toBe(false);
  });

  test("a thrown hook is an auth_error, distinguishable from a deny", async () => {
    const router = new Router({
      authorize: () => {
        throw new Error("db down");
      },
      enqueue: () => {},
    });
    router.register("backup", "page", () => ({ kind: "noop" }));

    const outcome = await router.route(`sb:backup:${GUILD}:list:page:1`, identity);
    expect(outcome.kind).toBe("auth_error");
  });
});

describe("routing outcomes fail closed", () => {
  test("a malformed id is invalid_id, not a crash", async () => {
    const router = new Router({ authorize: allow, enqueue: () => {} });
    const outcome = await router.route("not-a-snapback-id", identity);
    expect(outcome.kind).toBe("invalid_id");
  });

  test("an id with no handler is unregistered, without running auth", async () => {
    let authRan = false;
    const router = new Router({
      authorize: () => {
        authRan = true;
        return { kind: "allow" };
      },
      enqueue: () => {},
    });
    const outcome = await router.route(`sb:backup:${GUILD}:list:page:1`, identity);
    expect(outcome.kind).toBe("unregistered");
    expect(authRan).toBe(false);
  });

  test("a handler can defer long work through enqueue", async () => {
    const queued: JobRequest[] = [];
    const router = new Router({
      authorize: allow,
      enqueue: (job) => {
        queued.push(job);
      },
    });
    router.register("backup", "create", ({ enqueue, id }) => {
      enqueue({ kind: "backup", guildId: id.guild, payload: {} });
      return { kind: "deferred" };
    });

    const outcome = await router.route(`sb:backup:${GUILD}:new:create:create`, identity);
    expect(outcome).toEqual({ kind: "handled", result: { kind: "deferred" } });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("backup");
    expect(queued[0]?.guildId).toBe(GUILD);
  });

  test("a throwing handler is a handler_error, not a process crash", async () => {
    const router = new Router({ authorize: allow, enqueue: () => {} });
    router.register("backup", "page", () => {
      throw new Error("boom");
    });

    const outcome = await router.route(`sb:backup:${GUILD}:list:page:1`, identity);
    expect(outcome.kind).toBe("handler_error");
  });
});

// the two halves of the customID format live in different modules: components/
// row.ts builds, this router parses. a builder that emitted five segments would
// pass its own round trip and fail here, so the pair is asserted together.
describe("custom id format, builder against parser", () => {
  test("an id with no cursor still round-trips through the router", () => {
    const built = customID({ surface: "backup", guild: "1", object: "2", action: "list" });
    expect(built.split(":")).toHaveLength(6);
    const parsed = parseCustomId(built);
    expect(parsed.surface).toBe("backup");
    expect(parsed.cursor).toBe("");
  });

  test("an id with a cursor round-trips with the cursor intact", () => {
    const built = customID({
      surface: "backup",
      guild: "1",
      object: "2",
      action: "page",
      cursor: "3",
    });
    const parsed = parseCustomId(built);
    expect(parsed.cursor).toBe("3");
    expect(parsed.action).toBe("page");
  });
});
