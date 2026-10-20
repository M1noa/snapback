# Privacy

What a verification captures, why, how it is stored, how long it is kept, and how to take it back.

This is a disclosure. The text in the last section is the one the bot shows, and it is generated from the panel's scope list, so it cannot drift from what is actually requested.

## What a verification captures

One verification produces one row in `verify_records`, keyed by the guild and the user, and a timeline of events in `verify_record_events`.

| Captured | Where it comes from | Why | Scope |
|---|---|---|---|
| the account id | Discord, on the callback | the only key that identifies the person across servers | `identify` |
| the username | Discord, on the callback | so an operator can see who a record belongs to without leaving Discord | `identify` |
| the email address, and whether it is verified | Discord, on the callback | contact, and alt-account detection | `email` |
| the servers the person is in | Discord, on the callback | the list of servers the person belongs to, by name and id, not their contents | `guilds` |
| the linked accounts | Discord, on the callback | the Steam, Twitch, GitHub, and Spotify connections on the account, with their type and their verified flag | `connections` |
| the address the browser connected from | the callback request | abuse prevention, and the VPN, proxy, and Tor checks | none, this is the server's own request |
| the browser's own properties | the browser, on the landing page | a stable description of the client, so a record can be tied to the device that made it | none |
| the OAuth token | the token exchange, on the server | so the bot can check the grant later without asking again | `identify` and the rest |

Nothing is captured that a scope did not grant and an operator did not select. The scopes live on the panel, in `verify_panels.scopes_json`, and the wizard's scopes step writes them.

The bot's own settings, the panel, and the record are separate things. `guilds.settings_json` holds what the operator configured; `verify_panels` holds what the panel asks for; `verify_records` holds what a person actually sent.

## The browser's own properties

The landing page runs one inline script. It reads the browser's own properties, writes them into a cookie, and makes no request to anyone. The callback reads the cookie back. A page with no server attached runs no script at all.

The fields are the fixed list in `D4PLAN.md` 14.2: the user agent, the platform, the screen size and how much of it the browser can use, the viewport size, the colour depth and the device pixel ratio, the language and the languages, the timezone and its offset, the device memory, the thread count, the touch state and the touch points, whether cookies and do-not-track are on, the reduced-motion preference, the colour scheme, the connection type, the number of media devices the browser already permits the page to count, the page that sent you here, and the moment it was read. The full list, in the same words, is on `/legal`.

There is no canvas probe, no WebGL probe, and no font probe. The plan bans all three: they are what a fingerprinting library does, they are the part that makes a collection indefensible, and they add nothing the bot needs.

Only a fixed list of fields is stored. A field of the wrong type is dropped rather than coerced, a string is length-capped, and a number outside its documented range is dropped.

The fingerprint goes into the verification's entry on the record's timeline rather than into a column of its own. The `referrer` and `user_agent` columns on the record are never filled.

## The site's own defences

Every page the server answers, including the 404 and the 500, carries the same security headers (`src/web/server.ts`): a content security policy that allows exactly one inline script (the landing page's, allowed by a hash of it in `src/web/capture/fingerprint-script.ts`), inline CSS, and guild icons from `cdn.discordapp.com`; `X-Frame-Options: DENY` with `frame-ancestors 'none'` so no other site can frame a verification page; `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `COOP: same-origin`; and a `Permissions-Policy` that denies camera, microphone, geolocation, and FLoC outright. `Strict-Transport-Security` is deliberately absent: the server may sit behind plain HTTP while an operator sets TLS up, and a cached HSTS header on such a deployment is unrecoverable from the client side. Set it at the proxy that terminates TLS.

## The address you connected from

The address is resolved with a fixed precedence, so it cannot be spoofed by a header the caller made up:

1. Behind a Cloudflare tunnel (`BEHIND_CLOUDFLARE_TUNNEL=true`): the `CF-Connecting-IP` header, validated. `X-Forwarded-For` is ignored in this mode, because Cloudflare rewrites it itself.
2. Otherwise, with `TRUSTED_PROXY_DEPTH` above zero: the `X-Forwarded-For` chain is walked from the right, that many hops are skipped, and the first valid address past them is taken.
3. Otherwise: the socket address.

The candidate is then validated as a parseable IPv4 or IPv6 address, an IPv4-mapped IPv6 is unwrapped to its IPv4, and an IPv6 is reduced to its canonical form. A private, loopback, or link-local address is rejected, and if every source is private the address is stored anyway and the record is flagged, because that is the signature of a misconfigured tunnel.

The record keeps the first address the person was seen from, the last one, and the history of every change in between.

**Captured addresses are personal data, and you are responsible for them.** `IP_STORAGE=plaintext` prints exactly that warning at boot. The mode is your choice and it is yours to defend. `docs/scopes.md` lists what each scope brings in.

## The storage modes

`IP_STORAGE` picks one mode, and the mode decides which column the address lands in. The mode is read at boot, so changing it needs a restart.

| Mode | What is stored | Can it be turned back into an address | Use when |
|---|---|---|---|
| `hash` | an HMAC-SHA512 of the address under `IP_HASH_PEPPER` | no | the mode to use. The same address always gives the same hash, so two visits correlate, and the address itself is not in the row |
| `encrypted` | AES-256-GCM ciphertext under `ENCRYPTION_KEY`, with a random iv per value | yes, with the key | an operator who needs to see the address |
| `plaintext` | the address as it is | yes | local testing only. The bot warns at boot |

The hash mode needs `IP_HASH_PEPPER` set, and the encrypted mode needs `ENCRYPTION_KEY` set. Boot refuses to start without the one the mode needs. `ENCRYPTION_KEY` must decode to 32 bytes.

The code's fallback when `IP_STORAGE` is unset is `plaintext`, so set the key explicitly rather than relying on the default.

A record holds a hash in `first_ip_hash` and `last_ip_hash` in hash mode, and a ciphertext in `first_ip_enc` and `last_ip_enc` in the other two modes. One mode or the other, never both.

The OAuth access and refresh tokens are always encrypted with AES-256-GCM, in every mode, and they are the only secrets in the record. Without `ENCRYPTION_KEY` the token store holds nothing and says so. The key is not in the database and not in a backup, so a database copy on its own does not expose a token.

The geolocation columns and the VPN, proxy, and Tor flags are part of the record schema. The code in this build does not fill them.

## The relationships list is not captured

`relationships.read` is not a plain OAuth scope. It belongs to Discord's Social SDK and sits behind an application for access. Discord documents no public REST route for reading the friends, the pending requests, or the blocked list, so there is nothing for a normal OAuth token to call.

Because of that:

- The capture path ships disabled, with a "requires Social SDK access" state. It is not presented as working.
- The schema keeps `relationships_json` on the record and the UI keeps the field, so the data has a home the day access is granted.
- Enabling it needs an explicit acknowledgement in the wizard, saved as `acknowledged_restricted_scopes` in `guilds.settings_json`. Without that acknowledgement the wizard refuses to include the scope.

The wizard's scopes step lists the consequence next to the checkbox, so the operator reads what the scope grants before they tick it.

## What is not captured

- **Presences, typing, and read states.** Discord does not expose them.
- **Anything a scope did not grant.**
- **The raw forwarded-header chain.** It is never stored. Only the one resolved address is.

Snapback does not build proxy rotation, ban evasion, selfbot behaviour, user-token sending, token harvesting, or a CAPTCHA-solving service. It has no public geolocation endpoint, so the address of an arbitrary visitor cannot be looked up through it. An address-hash match is a signal shown to an operator, never an automatic ban: shared NAT, student halls, and mobile carriers all produce false matches.

## Retention

Retention lives in the `retention_policies` table, one row per guild: `keep_days`, `keep_count`, `keep_kind` (which kinds of backup are eligible: `manual`, `auto`, `pre_restore`), and `enabled`.

The sweep that implements it prunes backups, and it is deterministic:

1. The newest backup is never deleted, whatever the policy says. A policy that would leave zero backups keeps one.
2. A backup a queued or running job refers to is never deleted.
3. `pre_restore` goes first, then `auto`, then `manual`, oldest first.
4. `keep_days` and `keep_count` both apply. A backup is removed if either rule removes it.
5. The rows and the asset files go together, and asset files with no row are swept as orphans.

`/backup prune` shows the plan with `dry_run` on by default and reports what would go, with the rule that put it on the list.

**Verification records are not pruned by any of this.** There is no record-retention sweep in the code, so the retention period for a record is a decision the operator makes outside the bot: delete the rows by hand, or set a policy once the sweep for records ships. Until then, a record lives as long as the row.

## Revoking

There are two ways to take a verification back.

**Discord.** Removing the app from the server, or from the account's connections page, revokes the grant on Discord's side. The bot's next token check finds the grant gone and clears the stored token.

**The bot.** The `revoke` web route takes the user id and the guild id, clears the stored token, and, when the link carries `delete=1`, asks for the record to be removed as well. The token goes either way; the record stays unless the link asked for it to go.

In this build the route's record removal is a stub, so the row stays after a revoke. An operator with the database removes it directly, and the record's own `revoked_at` column is the marker that the grant was taken back.

The token status and its expiry are on the record, and the record page never shows the token itself. No export carries it either.

## The disclosure paragraph

Before the OAuth button, the verify page shows this, and the `legal` page shows the same words:

> verification is optional. what is captured is the account id, the username, the email address if you allowed it, the servers you are in if you allowed it, and the address you connected from. it is used to keep a server's member list honest. you can revoke it at any time.

The wizard's privacy step carries a longer default, which an operator can replace with their own text in `guilds.settings_json` under `privacy_disclosure_text`. The text is shown above the verify panel and on the `legal` page, and it is the operator's to write.

A panel without the `email` scope should not claim an email address is captured. List the exact scopes the panel requests.

## The current state of the build

Two things a reader of this file should know about the code as it stands.

The user-scoped reads in the OAuth exchange go out without a bearer token, so Discord answers 401 and the exchange stops before the profile is read. The identity fields, the servers, and the linked accounts are therefore not populated end to end in this build. The record columns exist and the scopes are selected; the read that fills them is not wired.

The web flow writes the record without a guild id, so the row sits under the empty guild id rather than in the server's own record list. The unique key is still one row per guild and user, so a second verification does not erase the first.
