import { describe, expect, test } from "bun:test";
import {
  channelShape,
  diffChannel,
  diffEmoji,
  diffGuild,
  diffMember,
  guildShape,
  memberShape,
} from "../../../src/services/tracking/diff.ts";

const member = (over: Record<string, unknown> = {}) => ({
  guildID: "1",
  joinedAt: Date.UTC(2026, 0, 1),
  user: { id: "9", username: "mina", globalName: "mina", avatar: "a" },
  nick: null,
  roles: [],
  flags: 0,
  pending: false,
  ...over,
});

const shape = (over: Record<string, unknown> = {}) => memberShape(member(over)) ?? fail("shape");

describe("member diff", () => {
  test("profile fields become their own kinds", () => {
    const before = shape();
    const after = shape({
      user: { id: "9", username: "mina2", globalName: "m", avatar: "b" },
    });
    expect(diffMember(after, before).map((item) => item.kind)).toEqual([
      "member_username",
      "member_global_name",
      "member_avatar",
    ]);
  });

  test("a nickname change carries both values", () => {
    const [change] = diffMember(shape({ nick: "new" }), shape({ nick: "old" }));
    expect(change).toEqual({
      kind: "member_nickname",
      before: { nickname: "old" },
      after: { nickname: "new" },
      detail: { field: "nickname" },
    });
  });

  test("roles report what was added and removed", () => {
    const [change] = diffMember(shape({ roles: ["a", "c"] }), shape({ roles: ["a", "b"] }));
    expect(change!.kind).toBe("member_roles");
    expect(change!.detail).toEqual({ added: ["c"], removed: ["b"] });
  });

  test("an identical member diffs to nothing", () => {
    expect(diffMember(shape(), shape())).toEqual([]);
  });
});

describe("guild, channel and emoji diff", () => {
  test("a renamed guild", () => {
    const before = guildShape({ id: "1", name: "old" });
    const after = guildShape({ id: "1", name: "new" });
    expect(diffGuild(after!, before!)).toEqual([
      {
        kind: "guild_update",
        before: { name: "old" },
        after: { name: "new" },
        detail: { fields: ["name"] },
      },
    ]);
  });

  test("a channel topic change", () => {
    const before = channelShape({ guildID: "1", id: "2", name: "n", topic: "old" });
    const after = channelShape({ guildID: "1", id: "2", name: "n", topic: "new" });
    const [change] = diffChannel(after!, before!);
    expect(change!.kind).toBe("channel_update");
    expect(change!.after).toEqual({ topic: "new" });
  });

  test("emoji sets report added, removed and renamed", () => {
    const detail = diffEmoji(
      [
        { id: "1", name: "keep" },
        { id: "2", name: "gone" },
        { id: "3", name: "old" },
      ],
      [
        { id: "1", name: "keep" },
        { id: "3", name: "new" },
        { id: "4", name: "fresh" },
      ],
    );
    expect(detail).toEqual({
      added: [{ id: "4", name: "fresh" }],
      removed: [{ id: "2", name: "gone" }],
      renamed: [{ id: "3", from: "old", to: "new" }],
    });
  });

  test("an unchanged emoji set is null, not an empty change", () => {
    expect(diffEmoji([{ id: "1", name: "x" }], [{ id: "1", name: "x" }])).toBeNull();
  });
});

function fail(message: string): never {
  throw new Error(message);
}
