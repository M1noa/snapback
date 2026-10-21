// the fixture guild (AGENTS.md: "fixture guild generator is the source of truth
// for shapes"). every capture test drives these payloads instead of hand-built
// objects, so a shape change lands in one place.
//
// ids are 19-digit strings above 2^53 on purpose: an accidental Number() in a
// capture module shows up as a wrong value here rather than silently in prod.

import { DEFAULT_GUILD_SETTINGS, type GuildSettings } from "../../src/config/defaults.ts";
import type { Database } from "../../src/db/types.ts";
import type { DiscordClient, RequestOptions } from "../../src/discord/client.ts";
import { DiscordApiError } from "../../src/discord/errors.ts";
import { createLogger } from "../../src/lib/log.ts";
import {
  type AssetStore,
  type BackupContext,
  type CaptureCounts,
  createSkipList,
} from "../../src/services/backup/types.ts";

// 19 digits, always the same width, so ids sort usefully and none is a safe int.
function id(n: number): string {
  return `10000000000000000${String(n).padStart(2, "0")}`;
}

export const FIXTURE_GUILD_ID = id(1);
export const FIXTURE_BACKUP_ID = "0190a000-0000-7000-8000-0000000000f1";

const T0 = "2024-01-01T00:00:00.000Z";
const T1 = "2024-02-01T00:00:00.000Z";

/** the raw payloads one guild's captures read, keyed the way the endpoints are. */
export interface FixtureGuild {
  guild: Record<string, unknown>;
  roles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  threads: { active: Record<string, unknown>[]; archived: Record<string, unknown>[] };
  members: Record<string, unknown>[];
  messagesByChannel: Record<string, Record<string, unknown>[]>;
  bans: Record<string, unknown>[];
  emojis: Record<string, unknown>[];
  stickers: Record<string, unknown>[];
  sounds: Record<string, unknown>[];
  automod: Record<string, unknown>[];
  events: Record<string, unknown>[];
  onboarding: Record<string, unknown>;
  welcomeScreen: Record<string, unknown>;
  widget: Record<string, unknown>;
  vanityUrl: Record<string, unknown>;
}

export const ROLE_MODS = id(2);
export const ROLE_MEMBERS = id(3);
export const ROLE_BOT = id(4);
export const CATEGORY_ID = id(10);
export const CHANNEL_GENERAL = id(20);
export const CHANNEL_MEMES = id(21);
export const CHANNEL_VOICE = id(22);
export const THREAD_ACTIVE = id(30);
export const THREAD_ARCHIVED = id(31);
export const USER_BOT = id(40);
export const USER_NICK = id(41);
export const USER_PENDING = id(42);

/** the whole guild: 4 roles, 4 channels, 2 threads, 3 members, 5 messages, a ban. */
export function makeGuild(overrides: Partial<FixtureGuild> = {}): FixtureGuild {
  const base: FixtureGuild = {
    guild: {
      id: FIXTURE_GUILD_ID,
      name: "fixture guild",
      icon: "a_iconhash",
      splash: null,
      banner: "bannerhash",
      discovery_splash: "splashhash",
      owner_id: id(41),
      member_count: 3,
      verification_level: 1,
      explicit_content_filter: 0,
      default_message_notifications: 0,
      locale: "en-US",
      preferred_locale: "en-US",
      premium_tier: 0,
      system_channel_id: CHANNEL_GENERAL,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
      system_channel_flags: 0,
      afk_channel_id: CHANNEL_VOICE,
      afk_timeout: 300,
      features: ["WELCOME_SCREEN_ENABLED", "COMMUNITY"],
    },

    // the everyone role's id is the guild id: that is the invariant, and the
    // fixture renames a *different* role to prove a name is not what identifies it.
    roles: [
      {
        id: FIXTURE_GUILD_ID,
        name: "@everyone",
        color: 0,
        hoist: false,
        mentionable: false,
        position: 0,
        permissions: "9223372036854775807",
        managed: false,
        icon: null,
        unicode_emoji: null,
        tags: {},
        flags: 0,
      },
      {
        id: ROLE_MODS,
        name: "mods",
        color: 16711680,
        hoist: true,
        mentionable: true,
        position: 2,
        permissions: "8",
        managed: false,
        icon: "roleiconhash",
        unicode_emoji: null,
        tags: {},
        flags: 0,
      },
      {
        id: ROLE_MEMBERS,
        name: "members",
        color: 3066993,
        hoist: false,
        mentionable: true,
        position: 1,
        permissions: "1024",
        managed: false,
        icon: null,
        unicode_emoji: "\u{1F44B}",
        tags: {},
        flags: 0,
      },
      {
        id: ROLE_BOT,
        name: "snapbot",
        color: 5793266,
        hoist: false,
        mentionable: false,
        position: 3,
        permissions: "104324673",
        managed: true,
        icon: null,
        unicode_emoji: null,
        tags: { bot_id: USER_BOT, integration_id: id(45) },
        flags: 0,
      },
    ],

    channels: [
      {
        id: CATEGORY_ID,
        type: 4,
        name: "text channels",
        position: 0,
        parent_id: null,
        permission_overwrites: [],
      },
      {
        id: CHANNEL_GENERAL,
        type: 0,
        name: "general",
        position: 0,
        parent_id: CATEGORY_ID,
        topic: "the fixture channel",
        nsfw: false,
        rate_limit_per_user: 5,
        default_auto_archive_duration: 1440,
        flags: 0,
        permission_overwrites: [
          { id: ROLE_MODS, type: 0, allow: "1024", deny: "2048" },
          { id: ROLE_MEMBERS, type: 0, allow: "66560", deny: "0" },
          { id: USER_PENDING, type: 1, allow: "0", deny: "2048" },
        ],
      },
      {
        id: CHANNEL_MEMES,
        type: 0,
        name: "memes",
        position: 1,
        parent_id: CATEGORY_ID,
        topic: null,
        nsfw: true,
        permission_overwrites: [],
      },
      {
        id: CHANNEL_VOICE,
        type: 2,
        name: "voice",
        position: 0,
        parent_id: CATEGORY_ID,
        bitrate: 64000,
        user_limit: 0,
        rtc_region: null,
        video_quality_mode: 1,
        permission_overwrites: [],
      },
    ],

    threads: {
      active: [
        {
          id: THREAD_ACTIVE,
          type: 11,
          parent_id: CHANNEL_GENERAL,
          name: "an active thread",
          rate_limit_per_user: 0,
          thread_metadata: { archived: false, locked: false, auto_archive_duration: 1440 },
        },
      ],
      archived: [
        {
          id: THREAD_ARCHIVED,
          type: 10,
          parent_id: CHANNEL_GENERAL,
          name: "an archived thread",
          rate_limit_per_user: null,
          applied_tags: [],
          thread_metadata: {
            archived: true,
            locked: true,
            auto_archive_duration: 4320,
            archive_timestamp: T0,
          },
        },
      ],
    },

    members: [
      {
        user: {
          id: USER_BOT,
          username: "snapbot",
          global_name: null,
          discriminator: "0001",
          avatar: "bothash",
          bot: true,
        },
        nick: null,
        joined_at: T0,
        roles: [ROLE_BOT],
        pending: false,
        premium_since: null,
        flags: 0,
      },
      {
        user: {
          id: USER_NICK,
          username: "nickname",
          global_name: "Nick Name",
          discriminator: "0",
          avatar: "a_animatedhash",
          bot: false,
        },
        nick: "nick in this guild",
        joined_at: T0,
        roles: [ROLE_MODS, ROLE_MEMBERS],
        pending: false,
        communication_disabled_until: T1,
        premium_since: T0,
        flags: 0,
      },
      {
        user: {
          id: USER_PENDING,
          username: "pending",
          global_name: null,
          discriminator: "0",
          // no avatar: stored null, never the discriminator % 5 guess (11.4)
          avatar: null,
          bot: false,
        },
        nick: null,
        joined_at: T1,
        roles: [],
        pending: true,
        premium_since: null,
        flags: 0,
      },
    ],

    // newest first, the order discord returns them in.
    messagesByChannel: {
      [CHANNEL_GENERAL]: [
        { ...message(54, 0, "the newest message"), pin: false, pinned: false },
        {
          ...message(53, 19, "a reply"),
          message_reference: { message_id: id(52), channel_id: CHANNEL_GENERAL },
        },
        {
          ...message(52, 0, "with an attachment"),
          attachments: [
            {
              id: id(99),
              filename: "shot.png",
              size: 4096,
              content_type: "image/png",
              url: `https://cdn.discordapp.com/attachments/${CHANNEL_GENERAL}/${id(99)}/shot.png`,
            },
          ],
        },
        {
          ...message(51, 0, ""),
          reactions: [{ emoji: { id: null, name: "\u{1F44D}" }, count: 2 }],
        },
        { ...message(50, 7, ""), author: user(USER_PENDING, "pending") },
      ],
      // an empty channel and an empty thread are part of the fixture: a walk that
      // finds nothing is normal, and a 404 for them would be a lie about discord.
      [CHANNEL_MEMES]: [],
      [THREAD_ACTIVE]: [],
      [THREAD_ARCHIVED]: [],
    },

    bans: [{ user: user(USER_NICK, "nickname"), reason: "fixture ban" }],

    emojis: [
      { id: id(60), name: "party", animated: false, managed: false, available: true, roles: [] },
      {
        id: id(61),
        name: "blob",
        animated: true,
        managed: false,
        available: true,
        roles: [ROLE_MODS],
      },
    ],

    stickers: [{ id: id(70), name: "wave", description: "a wave", tags: "wave", format_type: 1 }],

    sounds: [{ sound_id: id(80), name: "boop", volume: 1, emoji_id: id(60), emoji_name: "party" }],

    automod: [
      {
        id: id(90),
        name: "no invites",
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: { keyword_filter: ["discord.gg"] },
        actions: [{ type: 1, metadata: { custom_message: "no" } }],
        enabled: true,
        exempt_roles: [ROLE_MODS],
        exempt_channels: [CHANNEL_MEMES],
      },
    ],

    events: [
      {
        id: id(95),
        name: "fixture event",
        description: "a scheduled event",
        scheduled_start_time: T1,
        scheduled_end_time: null,
        privacy_level: 2,
        entity_type: 3,
        entity_metadata: { location: "somewhere" },
        status: 1,
        image: "eventhash",
      },
    ],

    onboarding: {
      guild_id: FIXTURE_GUILD_ID,
      prompts: [
        {
          id: id(96),
          type: 0,
          title: "what brings you here",
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            { id: id(97), title: "the memes", description: null, emoji: null, role_ids: [] },
          ],
        },
      ],
      default_channel_ids: [CHANNEL_GENERAL],
      mode: 1,
      enabled: true,
    },

    welcomeScreen: {
      description: "welcome to the fixture",
      welcome_channels: [
        { channel_id: CHANNEL_MEMES, description: "memes", emoji_id: null, emoji_name: null },
      ],
    },

    widget: { enabled: true, channel_id: CHANNEL_GENERAL },
    vanityUrl: { code: "fixture", uses: 0 },
  };

  return { ...base, ...overrides };
}

function user(n: string, username: string): Record<string, unknown> {
  return { id: n, username, global_name: null, discriminator: "0", avatar: null, bot: false };
}

function message(n: number, type: number, content: string): Record<string, unknown> {
  return {
    id: id(n),
    type,
    content,
    channel_id: CHANNEL_GENERAL,
    author: user(USER_NICK, "nickname"),
    attachments: [],
    embeds: [],
    stickers: [],
    components: [],
    reactions: [],
    pinned: false,
    flags: 0,
    timestamp: T0,
    edited_timestamp: null,
  };
}

/** the exact totals a capture test asserts on. */
export function counts(fixture: FixtureGuild): {
  roles: number;
  channels: number;
  threads: number;
  overwrites: number;
  members: number;
  messages: number;
  bans: number;
  emojis: number;
  stickers: number;
  sounds: number;
  automod: number;
  events: number;
} {
  return {
    roles: fixture.roles.length,
    channels: fixture.channels.length,
    threads: fixture.threads.active.length + fixture.threads.archived.length,
    overwrites: fixture.channels.reduce(
      (total, channel) =>
        total + ((channel.permission_overwrites as unknown[] | undefined)?.length ?? 0),
      0,
    ),
    members: fixture.members.length,
    messages: Object.values(fixture.messagesByChannel).reduce(
      (total, list) => total + list.length,
      0,
    ),
    bans: fixture.bans.length,
    emojis: fixture.emojis.length,
    stickers: fixture.stickers.length,
    sounds: fixture.sounds.length,
    automod: fixture.automod.length,
    events: fixture.events.length,
  };
}

export interface RestStub {
  /** shaped like the real client, so a capture module cannot tell the difference. */
  readonly client: DiscordClient;
  routes(): string[];
  calls(): { method: string; route: string; body: unknown }[];
  fail(route: string, error: unknown): void;
}

// one deep copy per call: a capture that mutates a payload must not poison the
// next test, and a test asserting on counts must see fresh arrays.
function copy<T>(value: T): T {
  return structuredClone(value);
}

function pathOf(route: string): string {
  const query = route.indexOf("?");
  return query === -1 ? route : route.slice(0, query);
}

function queryOf(route: string): URLSearchParams {
  const query = route.indexOf("?");
  return new URLSearchParams(query === -1 ? "" : route.slice(query + 1));
}

export function restStub(fixture: FixtureGuild): RestStub {
  const seen: string[] = [];
  const calls: { method: string; route: string; body: unknown }[] = [];
  const failures = new Map<string, unknown>();
  const guildId = String(fixture.guild.id);

  const handlers: Record<string, (query: URLSearchParams) => unknown> = {
    [`GET /guilds/${guildId}`]: () => copy(fixture.guild),
    [`GET /guilds/${guildId}/roles`]: () => copy(fixture.roles),
    [`GET /guilds/${guildId}/emojis`]: () => copy(fixture.emojis),
    [`GET /guilds/${guildId}/stickers`]: () => copy(fixture.stickers),
    [`GET /guilds/${guildId}/soundboard-sounds`]: () => ({ items: copy(fixture.sounds) }),
    [`GET /guilds/${guildId}/channels`]: () => copy(fixture.channels),
    [`GET /guilds/${guildId}/threads/active`]: () => ({
      threads: copy(fixture.threads.active),
      has_more: false,
    }),
    [`GET /guilds/${guildId}/onboarding`]: () => copy(fixture.onboarding),
    [`GET /guilds/${guildId}/welcome-screen`]: () => copy(fixture.welcomeScreen),
    [`GET /guilds/${guildId}/widget`]: () => copy(fixture.widget),
    [`GET /guilds/${guildId}/vanity-url`]: () => copy(fixture.vanityUrl),
    [`GET /guilds/${guildId}/auto-moderation/rules`]: () => copy(fixture.automod),
    [`GET /guilds/${guildId}/scheduled-events`]: () => copy(fixture.events),
    [`GET /guilds/${guildId}/members`]: (query) => page(fixture.members, query, "after", userId),
    [`GET /guilds/${guildId}/bans`]: (query) => page(fixture.bans, query, "after", userId),
  };

  for (const channelId of Object.keys(fixture.messagesByChannel)) {
    handlers[`GET /channels/${channelId}/messages`] = (query) =>
      page(fixture.messagesByChannel[channelId] ?? [], query, "before");
  }
  for (const channel of fixture.channels) {
    const channelId = String(channel.id);
    handlers[`GET /channels/${channelId}/threads/archived/public`] = () => ({
      threads: copy(fixture.threads.archived),
      has_more: false,
    });
    handlers[`GET /channels/${channelId}/threads/archived/private`] = () => ({
      threads: [],
      has_more: false,
    });
  }

  const client = {
    async request<T>(options: RequestOptions): Promise<T> {
      const key = `${options.method} ${pathOf(options.route)}`;
      calls.push({ method: options.method, route: options.route, body: options.body });
      seen.push(key);

      const failure = failures.get(key);
      if (failure !== undefined) throw failure;

      const handler = handlers[key];
      if (handler === undefined) {
        // an unhandled route is a 404 from discord, not a silent undefined: a
        // missing fixture entry should fail loudly in the capture that asked.
        throw new DiscordApiError({
          status: 404,
          route: key,
          method: options.method,
          body: JSON.stringify({ code: 10003, message: "Unknown Route" }),
        });
      }
      return handler(queryOf(options.route)) as T;
    },
  } as unknown as DiscordClient;

  return {
    client,
    routes: () => [...seen],
    calls: () => [...calls],
    fail: (route, error) => {
      failures.set(route, error);
    },
  };
}

// the id a row is sorted by. a member and a ban carry theirs inside the user
// object; a message carries its own.
type IdOf = (row: Record<string, unknown>) => string;

const ownId: IdOf = (row) => String(row.id ?? "");
const userId: IdOf = (row) => String((row.user as { id?: string } | undefined)?.id ?? "");

// the `limit`/`after` and `limit`/`before` walks both stop on a short page, so one
// helper serves members, bans and messages. messages arrive newest first.
function page(
  rows: Record<string, unknown>[],
  query: URLSearchParams,
  cursor: "after" | "before",
  idOf: IdOf = ownId,
): unknown {
  const limit = Number.parseInt(query.get("limit") ?? "100", 10);
  const at = query.get(cursor);
  let filtered = rows;
  if (at !== null) {
    filtered =
      cursor === "after"
        ? rows.filter((row) => idOf(row) > at)
        : rows.filter((row) => idOf(row) < at);
  }
  return copy(filtered.slice(0, Number.isFinite(limit) ? limit : 100));
}

export function makeSettings(overrides: Partial<GuildSettings> = {}): GuildSettings {
  return { ...DEFAULT_GUILD_SETTINGS, ...overrides };
}

// an asset store that writes nothing. a capture test asserts the call it made, and
// the one test that wants real bytes uses the real store (assets.test.ts).
export function stubAssets(): AssetStore {
  return {
    dir: "/tmp/snapback-fixture-assets",
    save: async (kind, name, url) =>
      url === null ? null : { url, path: `assets/${kind}/${name}`, bytes: 0 },
    pathFor: (kind, name, url) => `assets/${kind}/${name}${url === "" ? "" : ""}`,
  };
}

export function makeContext(options: {
  db: Database;
  guild: FixtureGuild;
  settings?: GuildSettings;
  assets?: AssetStore;
  backupId?: string;
  now?: () => string;
}): BackupContext {
  const stub = restStub(options.guild);
  const skips = createSkipList();
  return {
    db: options.db,
    client: stub.client,
    log: createLogger({ level: "error", dir: null }),
    backupId: options.backupId ?? FIXTURE_BACKUP_ID,
    guildId: String(options.guild.guild.id),
    settings: options.settings ?? makeSettings(),
    assets: options.assets ?? stubAssets(),
    skips,
    checkpoint: async (_step: string, _counts: CaptureCounts) => {},
    now: options.now ?? (() => T0),
  };
}
