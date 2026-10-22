// gateway listeners for the timeline. every handler is guarded: a failure is logged, never thrown
// at the gateway. the service decides whether a kind is allowed, so nothing here reads settings.
import type { Client } from "oceanic.js";
import type { JsonObject, TrackedEventKind, TrackedSubjectKind } from "../../db/types.ts";
import {
  type Change,
  channelShape,
  diffChannel,
  diffEmoji,
  diffGuild,
  diffMember,
  diffRole,
  type EmojiLike,
  guildShape,
  memberShape,
  roleShape,
  toIso,
} from "./diff.ts";
import type { TrackInput, TrackingService } from "./index.ts";

type Handler = (...args: unknown[]) => unknown;

// oceanic's emitter is typed per event; the guard erases the argument types on purpose.
interface Emitter {
  on(event: string, listener: Handler): unknown;
}

// live and old voice state share these key names, so a plain compare works.
const VOICE_FLAGS = [
  "selfMute",
  "selfDeaf",
  "selfStream",
  "selfVideo",
  "mute",
  "deaf",
  "suppress",
] as const;

export function attachHandlers(client: Client, tracking: TrackingService): void {
  listen(client, "guildMemberAdd", guard(tracking, "guildMemberAdd", memberAdded(tracking)));
  listen(
    client,
    "guildMemberRemove",
    guard(tracking, "guildMemberRemove", memberRemoved(tracking)),
  );
  listen(
    client,
    "guildMemberUpdate",
    guard(tracking, "guildMemberUpdate", memberUpdated(tracking)),
  );
  listen(client, "voiceStateUpdate", guard(tracking, "voiceStateUpdate", voiceUpdated(tracking)));
  listen(client, "guildUpdate", guard(tracking, "guildUpdate", guildUpdated(tracking)));
  listen(client, "guildRoleCreate", guard(tracking, "guildRoleCreate", roleCreated(tracking)));
  listen(client, "guildRoleUpdate", guard(tracking, "guildRoleUpdate", roleUpdated(tracking)));
  listen(client, "guildRoleDelete", guard(tracking, "guildRoleDelete", roleDeleted(tracking)));
  listen(client, "channelCreate", guard(tracking, "channelCreate", channelCreated(tracking)));
  listen(client, "channelUpdate", guard(tracking, "channelUpdate", channelUpdated(tracking)));
  listen(client, "channelDelete", guard(tracking, "channelDelete", channelDeleted(tracking)));
  listen(
    client,
    "guildEmojisUpdate",
    guard(tracking, "guildEmojisUpdate", assetsUpdated(tracking, "emoji_update")),
  );
  listen(
    client,
    "guildStickersUpdate",
    guard(tracking, "guildStickersUpdate", assetsUpdated(tracking, "sticker_update")),
  );
  listen(client, "guildBanAdd", guard(tracking, "guildBanAdd", banChanged(tracking, "ban_add")));
  listen(
    client,
    "guildBanRemove",
    guard(tracking, "guildBanRemove", banChanged(tracking, "ban_remove")),
  );
  listen(client, "messageDelete", guard(tracking, "messageDelete", messageDeleted(tracking)));
  listen(client, "messageUpdate", guard(tracking, "messageUpdate", messageUpdated(tracking)));
  listen(client, "threadCreate", guard(tracking, "threadCreate", threadCreated(tracking)));
  listen(client, "threadDelete", guard(tracking, "threadDelete", threadDeleted(tracking)));
}

// --- members ---

const memberAdded =
  (tracking: TrackingService) =>
  (member: unknown): Promise<boolean> | undefined => {
    const at = ids(member);
    if (at === null) return undefined;
    return tracking.record({
      guildId: at.guildId,
      subjectKind: "user",
      subjectId: at.userId,
      kind: isBot(member) ? "bot_join" : "member_join",
      at: toIso(read(member)?.joinedAt),
      after: memberShape(member),
      detail: { bot: isBot(member) },
    });
  };

const memberRemoved =
  (tracking: TrackingService) =>
  (member: unknown, guild: unknown): Promise<boolean> | undefined => {
    const source = read(member);
    const user = read(source?.user) ?? source;
    const guildId = str(source?.guildID) ?? str(read(guild)?.id);
    const userId = str(user?.id);
    if (guildId === null || userId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "user",
      subjectId: userId,
      kind: user?.bot === true ? "bot_leave" : "member_leave",
      // the state they left in. an uncached member arrives as a bare user, so this can be empty.
      before: memberShape(member),
      detail: { bot: user?.bot === true },
    });
  };

const memberUpdated =
  (tracking: TrackingService) =>
  (member: unknown, oldMember: unknown): Promise<void> | undefined => {
    const at = ids(member);
    const now = memberShape(member);
    const before = memberShape(oldMember);
    if (at === null || now === null || before === null) return undefined;
    return tracking.recordAll(changes(at.guildId, "user", at.userId, diffMember(now, before)));
  };

// --- voice ---

const voiceUpdated =
  (tracking: TrackingService) =>
  (member: unknown, oldState: unknown): Promise<unknown> | undefined => {
    const at = ids(member);
    const state = read(read(member)?.voiceState);
    if (at === null || state === null) return undefined;

    const now = voiceShape(state);
    const previous = read(oldState);
    const from = str(previous?.channelID);
    const to = str(now.channelID);
    const base = { guildId: at.guildId, subjectKind: "user" as const, subjectId: at.userId };

    // no prior state means we saw a join, not a transition. mark it as an observation.
    if (previous === null) {
      if (to === null) return undefined;
      return tracking.record({ ...base, kind: "voice_join", channelId: to, after: now });
    }

    if (from === null && to !== null) {
      return tracking.record({
        ...base,
        kind: "voice_join",
        channelId: to,
        before: { channelID: from },
        after: { channelID: to },
      });
    }
    if (from !== null && to === null) {
      return tracking.record({
        ...base,
        kind: "voice_leave",
        channelId: from,
        before: { channelID: from },
        after: { channelID: to },
      });
    }
    if (from !== null && to !== null && from !== to) {
      return tracking.record({
        ...base,
        kind: "voice_move",
        channelId: to,
        before: { channelID: from },
        after: { channelID: to },
      });
    }

    const flags = diffVoice(now, voiceShape(previous));
    if (flags === null || to === null) return undefined;
    return tracking.record({
      ...base,
      kind: "voice_state",
      channelId: to,
      before: flags.before,
      after: flags.after,
    });
  };

// --- guild ---

const guildUpdated =
  (tracking: TrackingService) =>
  (guild: unknown, oldGuild: unknown): Promise<void> | undefined => {
    const guildId = str(read(guild)?.id);
    const now = guildShape(guild);
    const before = guildShape(oldGuild);
    if (guildId === null || now === null || before === null) return undefined;
    return tracking.recordAll(changes(guildId, "guild", guildId, diffGuild(now, before)));
  };

const roleCreated =
  (tracking: TrackingService) =>
  (role: unknown): Promise<boolean> | undefined => {
    const guildId = str(read(role)?.guildID);
    const roleId = str(read(role)?.id);
    if (guildId === null || roleId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      kind: "role_create",
      after: roleShape(role),
      detail: { role_id: roleId },
    });
  };

const roleUpdated =
  (tracking: TrackingService) =>
  (role: unknown, oldRole: unknown): Promise<void> | undefined => {
    const guildId = str(read(role)?.guildID);
    const roleId = str(read(role)?.id);
    const now = roleShape(role);
    const before = roleShape(oldRole);
    if (guildId === null || roleId === null || now === null || before === null) return undefined;
    return tracking.recordAll(
      changes(guildId, "guild", guildId, diffRole(now, before), { role_id: roleId }),
    );
  };

const roleDeleted =
  (tracking: TrackingService) =>
  (role: unknown, guild: unknown): Promise<boolean> | undefined => {
    const guildId = str(read(role)?.guildID) ?? str(read(guild)?.id);
    const roleId = str(read(role)?.id);
    if (guildId === null || roleId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      kind: "role_delete",
      before: roleShape(role),
      detail: { role_id: roleId },
    });
  };

const channelCreated =
  (tracking: TrackingService) =>
  (channel: unknown): Promise<boolean> | undefined => {
    const guildId = str(read(channel)?.guildID);
    const channelId = str(read(channel)?.id);
    if (guildId === null || channelId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      channelId,
      kind: "channel_create",
      after: channelShape(channel),
      detail: { channel_id: channelId, type: read(channel)?.type ?? null },
    });
  };

const channelUpdated =
  (tracking: TrackingService) =>
  (channel: unknown, oldChannel: unknown): Promise<void> | undefined => {
    const guildId = str(read(channel)?.guildID);
    const channelId = str(read(channel)?.id);
    const now = channelShape(channel);
    const before = channelShape(oldChannel);
    if (guildId === null || channelId === null || now === null || before === null) {
      return undefined;
    }
    const list = changes(guildId, "guild", guildId, diffChannel(now, before), {
      channel_id: channelId,
    }).map((input) => ({ ...input, channelId }));
    return tracking.recordAll(list);
  };

const channelDeleted =
  (tracking: TrackingService) =>
  (channel: unknown): Promise<boolean> | undefined => {
    const guildId = str(read(channel)?.guildID);
    const channelId = str(read(channel)?.id);
    if (guildId === null || channelId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      channelId,
      kind: "channel_delete",
      before: channelShape(channel),
      detail: { channel_id: channelId, type: read(channel)?.type ?? null },
    });
  };

// emojis and stickers share a listener shape: (guild, now, before).
const assetsUpdated =
  (tracking: TrackingService, kind: TrackedEventKind) =>
  (guild: unknown, now: unknown, before: unknown): Promise<boolean> | undefined => {
    const guildId = str(read(guild)?.id);
    if (guildId === null) return undefined;
    const detail = diffEmoji(list(before), list(now));
    if (detail === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      kind,
      detail,
    });
  };

const banChanged =
  (tracking: TrackingService, kind: TrackedEventKind) =>
  (guild: unknown, user: unknown): Promise<boolean> | undefined => {
    const guildId = str(read(guild)?.id);
    const userId = str(read(user)?.id);
    if (guildId === null || userId === null) return undefined;
    const banned = kind === "ban_add";
    const source = read(user);
    return tracking.record({
      guildId,
      subjectKind: "user",
      subjectId: userId,
      kind,
      before: { banned: !banned },
      after: { banned },
      detail: { username: str(source?.username), bot: source?.bot === true },
    });
  };

// --- messages. never the text, only that it happened and how long it was ---

const messageDeleted =
  (tracking: TrackingService) =>
  (message: unknown): Promise<boolean> | undefined => {
    const source = read(message);
    const guildId = str(source?.guildID);
    const channelId = str(source?.channelID);
    if (guildId === null || channelId === null) return undefined;
    const author = read(source?.author);
    const authorId = str(author?.id);
    return tracking.record({
      guildId,
      channelId,
      // an uncached delete has no author, so the row is a guild record, not a user one.
      subjectKind: authorId === null ? "guild" : "user",
      subjectId: authorId ?? guildId,
      kind: "message_delete",
      detail: {
        message_id: str(source?.id),
        author_id: authorId,
        bot: author === null ? null : author.bot === true,
        content_length: length(source?.content),
      },
    });
  };

const messageUpdated =
  (tracking: TrackingService) =>
  (message: unknown, oldMessage: unknown): Promise<boolean> | undefined => {
    const source = read(message);
    const guildId = str(source?.guildID);
    const channelId = str(source?.channelID);
    // discord's own edit time is the only reliable signal. embed and reaction updates
    // reach this handler too, and they bump nothing.
    const editedAt = stamp(source?.editedTimestamp);
    if (guildId === null || channelId === null || editedAt === null) return undefined;
    if (stamp(read(oldMessage)?.editedTimestamp) === editedAt) return undefined;
    const authorId = str(read(source?.author)?.id);
    return tracking.record({
      guildId,
      channelId,
      subjectKind: authorId === null ? "guild" : "user",
      subjectId: authorId ?? guildId,
      kind: "message_edit",
      at: toIso(editedAt),
      after: { edited_at: toIso(editedAt) },
      detail: {
        message_id: str(source?.id),
        author_id: authorId,
        content_length: length(source?.content),
      },
    });
  };

const threadCreated =
  (tracking: TrackingService) =>
  (thread: unknown): Promise<boolean> | undefined => {
    const source = read(thread);
    const guildId = str(source?.guildID);
    const threadId = str(source?.id);
    if (guildId === null || threadId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      channelId: threadId,
      kind: "thread_create",
      after: channelShape(thread),
      detail: { thread_id: threadId, parent_id: str(source?.parentID) },
    });
  };

const threadDeleted =
  (tracking: TrackingService) =>
  (thread: unknown): Promise<boolean> | undefined => {
    const source = read(thread);
    const guildId = str(source?.guildID);
    const threadId = str(source?.id);
    if (guildId === null || threadId === null) return undefined;
    return tracking.record({
      guildId,
      subjectKind: "guild",
      subjectId: guildId,
      channelId: threadId,
      kind: "thread_delete",
      before: channelShape(thread),
      detail: { thread_id: threadId, parent_id: str(source?.parentID) },
    });
  };

// --- plumbing ---

const guard =
  (tracking: TrackingService, event: string, run: Handler): Handler =>
  (...args: unknown[]): void => {
    try {
      const result = run(...args);
      if (result instanceof Promise) {
        result.catch((error: unknown) => tracking.reportFailure(event, error));
      }
    } catch (error) {
      tracking.reportFailure(event, error);
    }
  };

const listen = (client: Client, event: string, handler: Handler): void => {
  (client as unknown as Emitter).on(event, handler);
};

const changes = (
  guildId: string,
  subjectKind: TrackedSubjectKind,
  subjectId: string,
  list: readonly Change[],
  extra: JsonObject = {},
): TrackInput[] =>
  list.map((item) => {
    const detail = { ...(item.detail ?? {}), ...extra };
    return {
      guildId,
      subjectKind,
      subjectId,
      kind: item.kind,
      before: item.before,
      after: item.after,
      detail: Object.keys(detail).length === 0 ? null : detail,
    };
  });

// the flags that changed, and only those. the channel is a separate event.
const diffVoice = (
  now: JsonObject,
  before: JsonObject,
): { before: JsonObject; after: JsonObject } | null => {
  const was: JsonObject = {};
  const is: JsonObject = {};
  for (const flag of VOICE_FLAGS) {
    if (now[flag] === before[flag]) continue;
    was[flag] = before[flag];
    is[flag] = now[flag];
  }
  return Object.keys(is).length === 0 ? null : { before: was, after: is };
};

const voiceShape = (state: Record<string, unknown> | null): JsonObject => ({
  channelID: str(state?.channelID),
  selfMute: state?.selfMute === true,
  selfDeaf: state?.selfDeaf === true,
  selfStream: state?.selfStream === true,
  selfVideo: state?.selfVideo === true,
  mute: state?.mute === true,
  deaf: state?.deaf === true,
  suppress: state?.suppress === true,
});

// the member's own ids. guildID and user.id are one level down.
const ids = (member: unknown): { guildId: string; userId: string } | null => {
  const source = read(member);
  const guildId = str(source?.guildID);
  const userId = str(read(source?.user)?.id);
  return guildId === null || userId === null ? null : { guildId, userId };
};

const list = (value: unknown): EmojiLike[] => {
  if (!Array.isArray(value)) return [];
  const items: EmojiLike[] = [];
  for (const entry of value) {
    const source = read(entry);
    const id = str(source?.id);
    if (id === null) continue;
    items.push({ id, name: str(source?.name) });
  }
  return items;
};

const isBot = (member: unknown): boolean => read(read(member)?.user)?.bot === true;

const length = (value: unknown): number | null => (typeof value === "string" ? value.length : null);

// a message edit stamp is a date on a live message and epoch ms on an uncached one.
const stamp = (value: unknown): number | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const read = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
