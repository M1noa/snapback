// pure shape readers and diffs for the timeline. no gateway classes, no db.
import type { JsonObject, JsonValue, TrackedEventKind } from "../../db/types.ts";

export interface Change {
  kind: TrackedEventKind;
  before: JsonObject;
  after: JsonObject;
  detail: JsonObject | null;
}

export type MemberShape = {
  nickname: string | null;
  username: string;
  globalName: string | null;
  avatar: string | null;
  guildAvatar: string | null;
  flags: number;
  pending: boolean;
  timeoutUntil: string | null;
  boostSince: string | null;
  roles: string[];
};

export type GuildShape = {
  name: string;
  icon: string | null;
  banner: string | null;
  description: string | null;
  ownerId: string | null;
  preferredLocale: string | null;
};

export type RoleShape = {
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  icon: string | null;
  unicodeEmoji: string | null;
};

export type ChannelShape = {
  name: string | null;
  parentId: string | null;
  topic: string | null;
  nsfw: boolean;
  position: number;
  bitrate: number | null;
  userLimit: number | null;
  rateLimitPerUser: number | null;
  archived: boolean;
  locked: boolean;
};

export interface EmojiLike {
  id: string;
  name: string | null;
}

// a live member carries dates, the json twin of it carries epoch ms. accept both.
export const toIso = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number")
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  return str(value);
};

export function memberShape(member: unknown): MemberShape | null {
  const source = record(member);
  const user = record(source?.user);
  if (!source || !user) return null;
  const username = str(user.username);
  if (username === null) return null;
  return {
    nickname: str(source.nick),
    username,
    globalName: str(user.globalName),
    avatar: str(user.avatar),
    guildAvatar: str(source.avatar),
    flags: num(source.flags) ?? 0,
    pending: bool(source.pending) ?? false,
    timeoutUntil: toIso(source.communicationDisabledUntil),
    boostSince: toIso(source.premiumSince),
    roles: strings(source.roles),
  };
}

export function guildShape(guild: unknown): GuildShape | null {
  const source = record(guild);
  if (!source) return null;
  const name = str(source.name);
  if (name === null) return null;
  return {
    name,
    icon: str(source.icon),
    banner: str(source.banner),
    description: str(source.description),
    ownerId: str(source.ownerID),
    preferredLocale: str(source.preferredLocale),
  };
}

export function roleShape(role: unknown): RoleShape | null {
  const source = record(role);
  if (!source) return null;
  const name = str(source.name);
  if (name === null) return null;
  return {
    name,
    color: roleColor(source),
    hoist: bool(source.hoist) ?? false,
    mentionable: bool(source.mentionable) ?? false,
    permissions: permissions(source.permissions),
    icon: str(source.icon),
    unicodeEmoji: str(source.unicodeEmoji),
  };
}

export function channelShape(channel: unknown): ChannelShape | null {
  const source = record(channel);
  if (!source) return null;
  const name = str(source.name);
  if (name === null) return null;
  const thread = record(source.threadMetadata);
  return {
    name,
    parentId: str(source.parentID),
    topic: str(source.topic),
    nsfw: bool(source.nsfw) ?? false,
    position: num(source.position) ?? 0,
    bitrate: num(source.bitrate),
    userLimit: num(source.userLimit),
    rateLimitPerUser: num(source.rateLimitPerUser),
    archived: bool(thread?.archived) ?? false,
    locked: bool(thread?.locked) ?? false,
  };
}

export function diffMember(now: MemberShape, before: MemberShape): Change[] {
  const changes: Change[] = [];
  if (!same(now.nickname, before.nickname))
    changes.push(change("member_nickname", "nickname", before.nickname, now.nickname));
  if (!same(now.username, before.username))
    changes.push(change("member_username", "username", before.username, now.username));
  if (!same(now.globalName, before.globalName))
    changes.push(change("member_global_name", "global_name", before.globalName, now.globalName));
  if (!same(now.avatar, before.avatar))
    changes.push(change("member_avatar", "avatar", before.avatar, now.avatar, { scope: "user" }));
  if (!same(now.guildAvatar, before.guildAvatar))
    changes.push(
      change("member_avatar", "avatar", before.guildAvatar, now.guildAvatar, { scope: "guild" }),
    );
  if (!same(now.flags, before.flags))
    changes.push(change("member_flags", "flags", before.flags, now.flags));
  if (!same(now.pending, before.pending))
    changes.push(change("member_pending", "pending", before.pending, now.pending));
  if (!same(now.timeoutUntil, before.timeoutUntil))
    changes.push(change("member_timeout", "timeout_until", before.timeoutUntil, now.timeoutUntil));
  if (!same(now.boostSince, before.boostSince))
    changes.push(change("member_boost", "boost_since", before.boostSince, now.boostSince));

  const added = now.roles.filter((id) => !before.roles.includes(id));
  const removed = before.roles.filter((id) => !now.roles.includes(id));
  if (added.length > 0 || removed.length > 0)
    changes.push(change("member_roles", "roles", before.roles, now.roles, { added, removed }));
  return changes;
}

const GUILD_FIELDS = [
  "name",
  "icon",
  "banner",
  "description",
  "ownerId",
  "preferredLocale",
] as const;
const ROLE_FIELDS = [
  "name",
  "color",
  "hoist",
  "mentionable",
  "permissions",
  "icon",
  "unicodeEmoji",
] as const;
const CHANNEL_FIELDS = [
  "name",
  "parentId",
  "topic",
  "nsfw",
  "position",
  "bitrate",
  "userLimit",
  "rateLimitPerUser",
  "archived",
  "locked",
] as const;

export function diffGuild(now: GuildShape, before: GuildShape): Change[] {
  return diffFields("guild_update", GUILD_FIELDS, now, before);
}

export function diffRole(now: RoleShape, before: RoleShape): Change[] {
  return diffFields("role_update", ROLE_FIELDS, now, before);
}

export function diffChannel(now: ChannelShape, before: ChannelShape): Change[] {
  return diffFields("channel_update", CHANNEL_FIELDS, now, before);
}

export function diffEmoji(
  before: readonly EmojiLike[],
  after: readonly EmojiLike[],
): JsonObject | null {
  const old = new Map(before.map((item) => [item.id, item.name]));
  const next = new Map(after.map((item) => [item.id, item.name]));
  const added: JsonObject[] = [];
  const removed: JsonObject[] = [];
  const renamed: JsonObject[] = [];

  for (const [id, name] of next) {
    if (!old.has(id)) added.push({ id, name });
    else if (old.get(id) !== name) renamed.push({ id, from: old.get(id) ?? null, to: name });
  }
  for (const [id, name] of old) if (!next.has(id)) removed.push({ id, name });

  if (added.length === 0 && removed.length === 0 && renamed.length === 0) return null;
  return { added, removed, renamed };
}

function diffFields<Key extends string, Shape extends Record<Key, JsonValue>>(
  kind: TrackedEventKind,
  fields: readonly Key[],
  now: Shape,
  before: Shape,
): Change[] {
  const changed = fields.filter((field) => !same(now[field], before[field]));
  if (changed.length === 0) return [];
  const from: JsonObject = {};
  const to: JsonObject = {};
  for (const field of changed) {
    from[field] = before[field];
    to[field] = now[field];
  }
  return [{ kind, before: from, after: to, detail: { fields: changed } }];
}

function change(
  kind: TrackedEventKind,
  field: string,
  before: JsonValue,
  after: JsonValue,
  detail?: JsonObject,
): Change {
  return {
    kind,
    before: { [field]: before },
    after: { [field]: after },
    detail: detail ?? { field },
  };
}

// role colors moved to colors.primaryColor; the old field is deprecated.
function roleColor(role: Record<string, unknown>): number {
  const colors = record(role.colors);
  const primary = num(colors?.primaryColor);
  if (primary !== null) return primary;
  return num(role.color) ?? 0;
}

// live roles carry a Permission instance, raw payloads carry a bitfield string.
function permissions(value: unknown): string {
  const direct = record(value);
  if (direct) return text(direct.allow);
  return text(value);
}

function text(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return BigInt(value).toString();
  return "0";
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
