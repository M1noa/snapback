# Developer panel

Every Discord Developer Portal toggle this bot needs, what breaks without it, and the two myths that send operators down the wrong path. `/setup app` walks this checklist and verifies what it can from the API rather than trusting you to have done it.

## The checklist the wizard enforces

`/setup app` verifies what it can and prints what it cannot:

1. **Application created, bot user present.** The wizard calls `GET /applications/@me` and shows the name, the id, and whether the bot token matches the owner id you gave in `.env`. If the token belongs to a different application, it says so.
2. **Redirect URIs registered.** The wizard cannot create these, so it prints the exact string to paste, computed from `PUBLIC_BASE_URL`: `{PUBLIC_BASE_URL}/callback`. It then runs the self-test, which fails with a specific message if the redirect is missing or does not match.
3. **Privileged intents: `GUILD_MEMBERS` on.** The wizard reads the `flags` from `GET /applications/@me` and the gateway handshake. If the intent is not granted the bot never reaches ready, so the wizard reports "the gateway refused `GUILD_MEMBERS`" with the toggle path.
4. **Install link.** Generated from the scopes you selected, shown as a copyable code block plus a step to open it in a browser.
5. **Bot permissions for the invite.** Administrator is not required and is discouraged. The wizard computes the exact bitfield from the features you enabled: manage roles, manage channels, manage webhooks, ban members, manage guild, manage messages, read message history, manage emojis and stickers, manage expressions, manage events, moderate members, view audit log. It builds the invite with that number.
6. **Interactions endpoint: leave it empty.** See the section below.
7. **Public key: skip it.** It matters for HTTP-interaction apps and is irrelevant for a gateway bot.

## Intents

Request exactly these. Requesting more than you use is a review flag when you apply for verification.

| Intent | Why |
|---|---|
| `GUILDS` | required |
| `GUILD_MEMBERS` **(privileged)** | member list, role assignment on restore, nicknames |
| `GUILD_MODERATION` | bans, timeouts, automod |
| `GUILD_EMOJIS_AND_STICKERS` | emoji and sticker backup |
| `GUILD_VOICE_STATES` | soundboard, voice channel detail |
| `GUILD_SCHEDULED_EVENTS` | scheduled event backup |
| `GUILD_MESSAGES` | receiving only; message history is REST, but the intent is needed for some message events |
| `GUILD_MESSAGE_REACTIONS` | reaction capture on live messages, optional, off by default |
| `DIRECT_MESSAGES` | none. Do not request it. Nothing here DMs users |

`GUILD_MEMBERS` is the one **privileged** intent this bot needs. Toggle it on in the portal's Bot tab, under Privileged Gateway Intents. Without it, the gateway closes the connection and the bot never reaches ready.

`GUILD_PRESENCES` is **not** requested. It is privileged, it needs a separate approval, and nothing in this bot needs presence data.

If the gateway closes with `4013`, the intents you requested are invalid; with `4014`, one you requested is disallowed because it is not enabled on the application. Both are always a Developer Panel problem.

## The interactions endpoint must stay empty

This bot is gateway-only. It connects to Discord over the gateway and never receives interactions over HTTP.

Do not set an Interactions Endpoint URL. Half the tutorials online tell you to set one, and a stale endpoint URL breaks slash commands: every interaction gets a silent `401` on the endpoint while the gateway client is running, and Discord shows "The application did not respond" for every command. It is the single most common self-host support ticket.

The rule: if the Interactions Endpoint URL field has anything in it, clear it. See `docs/troubleshooting.md` for the symptom.

## Message content: the myth

**Message backup does not need the Message Content intent.**

That intent gates the `MESSAGE_CREATE` payload's `content` field on the gateway. Snapback reads history over REST with `GET /channels/{id}/messages`, and that call returns `content` whenever the bot has `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` in the channel.

So if restored or exported messages come back with empty content, the cause is a missing channel permission, not a missing intent. Grant the two permissions.

The intent only matters if you turn on live capture mode, which records message create, edit, and delete events from the gateway as they happen. That mode is off by default and only then does it need `GUILD_MESSAGES` and, for content, the Message Content intent. Do not flip a privileged toggle you do not need.

## The redirect string

The redirect URI is `{PUBLIC_BASE_URL}/callback`, byte-identical to what the wizard prints. Discord requires HTTPS for it, so `PUBLIC_BASE_URL` must be an `https://` URL. The OAuth code exchange sends the redirect URI again and Discord compares it exactly; one extra character, a trailing slash, or a hostname change is an `invalid_redirect_uri`.

See `docs/cloudflare-tunnel.md` for giving a laptop an HTTPS URL.
