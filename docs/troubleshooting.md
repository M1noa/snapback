# Troubleshooting

The failures that actually happen, by symptom. Each entry names the cause and the fix. Where `D4PLAN.md` does not settle the fix, the entry gives the diagnostic step instead of a guess.

## Token rejected (401)

**Symptom.** `/setup app test` reports "token rejected (401). Regenerate in the Developer Panel". The bot may also fail every REST call.

**Cause.** `DISCORD_TOKEN` in `.env` is wrong, expired, or a token that was regenerated after you copied it. Opening the bot user's token once and then regenerating it invalidates the old value.

**Fix.** Regenerate the token in the Developer Panel's Bot tab, put the new value in `DISCORD_TOKEN`, restart. If the bot still 401s, confirm the token belongs to the same application whose bot you invited.

## Gateway closed with 4004

**Symptom.** The log shows "gateway closed with code 4004: authentication failed" and the bot never reaches ready.

**Cause.** Discord rejected the token at the gateway handshake.

**Fix.** Same as the 401 above: the token is wrong or stale. Regenerate it and update `DISCORD_TOKEN`. 4004 is an authentication failure, not a permission problem, so no portal toggle fixes it.

## Privileged intent refused (4014, or 4013)

**Symptom.** The bot connects and immediately closes, or something in `/setup app test` reports "the gateway refused `GUILD_MEMBERS`". Code `4014` means a requested intent is disallowed; code `4013` means an intent you requested is invalid.

**Cause.** `GUILD_MEMBERS` is a privileged intent and must be enabled on the application before the bot can request it. If it is off, the gateway refuses the handshake.

**Fix.** In the Developer Panel, open the Bot tab, scroll to Privileged Gateway Intents, and turn on Server Members Intent. Restart. Request exactly the intents listed in `docs/developer-panel.md`; requesting more than the app is allowed is what trips `4013`.

## The application did not respond

**Symptom.** Every slash command replies "The application did not respond". The bot appears online.

**Cause.** An Interactions Endpoint URL is set in the Developer Panel. This bot is gateway-only and never receives interactions over HTTP, so Discord tries the stale endpoint, gets a `401`, and reports the failure to the user.

**Fix.** Open the Developer Panel's General Information page and clear the Interactions Endpoint URL field. Save. Commands start working immediately; no restart is needed. See `docs/developer-panel.md`.

## Redirect URI mismatch

**Symptom.** The OAuth authorize request fails with an invalid redirect, or the self-test reports "add {PUBLIC_BASE_URL}/callback to Redirect URIs in the Developer Panel".

**Cause.** The redirect URI registered on the application does not match `{PUBLIC_BASE_URL}/callback` exactly, or it is not HTTPS.

**Fix.** In the Developer Panel's OAuth2 page, add the exact string `/setup app` prints: `{PUBLIC_BASE_URL}/callback`. It must be byte-identical to what `PUBLIC_BASE_URL` produces, including no trailing slash and the same hostname. Discord requires HTTPS for it, so a plain `http://` localhost URL will not work; use a tunnel per `docs/cloudflare-tunnel.md`. If you used a quick tunnel, the hostname changed on restart, so re-register the new one.

## Every captured IP is ::1 behind a tunnel

**Symptom.** Records show `::1` or `127.0.0.1` for every user. Every VPN check looks identical.

**Cause.** `BEHIND_CLOUDFLARE_TUNNEL` is not set while the traffic actually comes through a tunnel. The tunnel terminates on loopback, so IP capture falls back to the socket address, which is the loopback for every request.

**Fix.** In `/setup web`, tick the Cloudflare tunnel checkbox, which sets `BEHIND_CLOUDFLARE_TUNNEL=true`. Then run the live probe: open `{PUBLIC_BASE_URL}/health?probe=1` in a browser on your phone and confirm the wizard sees a public address. If it still sees a loopback, the tunnel is not forwarding to the port Snapback listens on; check the tunnel config against `docs/cloudflare-tunnel.md`.

## Nothing listening on the port

**Symptom.** The self-test reports "nothing listening on 8080". A local GET to `http://localhost:8080/health` is refused.

**Cause.** The web server is not running on the configured port, or `PORT` does not match what you are checking.

**Fix.** Confirm the process is up and that the startup log shows the web server listening. Confirm `PORT` matches the port you are probing; the default is `8080`. Confirm nothing else already holds that port. `D4PLAN.md` does not name a different fix beyond a local socket accept on `PORT`, so start from the process state and the port value rather than guessing at a firewall.

## DuckDB file locked

**Symptom.** Boot fails with `SB_DB_LOCKED` naming the `.duckdb` file. After about 30 seconds of retrying, the process exits.

**Cause.** DuckDB allows one writer process. Two things are pointed at the same file, most often the bot and a second server started from the same directory.

**Fix.** Run one process, or move the second one off the file. The bot and the web server are meant to run in the same process for exactly this reason. If you need two processes, point `DATABASE_URL` at Postgres. See `docs/self-hosting.md`.

## Message content comes back empty

**Symptom.** Backed-up or exported messages have no `content`. `/setup app test` reports "message content came back empty; check channel permissions, not the Message Content intent".

**Cause.** The bot lacks `VIEW_CHANNEL` or `READ_MESSAGE_HISTORY` in the channel. Message history is read over REST, which returns `content` with those two permissions and does not use the Message Content intent at all.

**Fix.** Grant `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` to the bot in the affected channel or its category. Do not enable the Message Content intent; it only gates the gateway payload and is needed only for live capture mode. See `docs/developer-panel.md`.

## Attachment URLs expired

**Symptom.** Restore reports "attachment could not be preserved". A backed-up message's attachment has `url: null`.

**Cause.** Discord CDN URLs for attachments are signed and expire. If the file was over the download ceiling or its URL had already expired at backup time, it was recorded as metadata only.

**Fix.** Nothing recovers an expired URL after the fact. Re-backup a channel while its attachments are still fetchable to capture the bytes into `assets/`. This is an inherent limit, documented in `docs/self-hosting.md`, not a bug.

## A file is over the upload ceiling

**Symptom.** An export or restore upload fails with a size error, or the message says the file is too large to attach.

**Cause.** Discord caps uploads per uploader, and the cap depends on the user's Nitro tier and the guild's boost tier. A hardcoded constant is wrong for some users in the same guild.

**Fix.** Snapback reads `attachment_size_limit` off the interaction rather than assuming a number, and the documented default is 20 MiB per file. Anything larger is written to disk instead, and the message says exactly where the file is. Pull it from disk. Do not raise a constant; read the live limit.

## Commands do not appear after a global registration

**Symptom.** The bot is running, but the slash commands do not show up in Discord.

**Cause.** Global command registration can take up to an hour to propagate.

**Fix.** Wait, or register to one guild for instant propagation: set `DISCORD_DEV_GUILD_ID` to your test guild's id and restart, which registers commands guild-scoped and instantly. Unset it for the production global registration. `D4PLAN.md` does not offer a manual force-refresh beyond the registry's diff-and-PUT at boot, so if commands are still missing after an hour, check the registration log line to confirm the PUT happened.
