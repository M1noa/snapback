# OAuth2 scopes

Every scope Snapback can ask for, what it grants, and what is stored for a verified user. You pick scopes per panel in `/setup verify`; each is a checkbox with the consequence line below shown next to it.

## The ten scopes

| Scope | Consequence shown |
|---|---|
| `identify` | basic profile: id, username, avatar |
| `email` | email address and whether it is verified |
| `connections` | linked accounts: Steam, Twitch, GitHub, Spotify and similar |
| `guilds` | the list of servers they are in (names and ids, not contents) |
| `guilds.join` | allows the bot to add them to a server you own |
| `guilds.members.read` | their nickname and roles inside a server you own |
| `role_connections.write` | required if you use Discord's linked-roles feature |
| `webhook.incoming` | creates a webhook in a channel they pick |
| `relationships.read` | their friends list, pending friend requests, and blocked users. Restricted scope, requires Discord approval, and you must disclose and handle it under Discord's Social SDK terms |
| `gdm.join` | join a group DM |

## The three defaults

`identify`, `email`, and `guilds.join`.

`identify` is what makes a record a record. `email` is what most operators want for alt detection and contact. `guilds.join` is what lets the pull engine add a verified user to your server later, and only with the token that user granted.

## The restricted scope

`relationships.read` is not a plain OAuth scope. It is part of Discord's Social SDK and sits behind an application for access. Discord documents no public REST route for reading the friends, pending, or blocked list, so there is nothing for a normal OAuth token to call.

Because of that:

- The capture path ships **disabled**, with a "requires Social SDK access" state. It is not presented as working.
- The schema keeps `relationships_json` on the record and the UI keeps the field, so the day access is granted the data has a home.
- Enabling it requires an explicit acknowledgement in the wizard, and a saved `acknowledged_restricted_scopes` timestamp in `guilds.settings_json`. Without that acknowledgement the wizard refuses to include the scope, and `/verify panel` refuses to build a panel that requests it.

You are responsible for how you handle this data under the Social SDK terms. Do not turn it on to see what happens.

## What Snapback stores per verification

`verify_records` holds one row per guild and user. After a successful verification the record can contain:

- **Identity:** user id, username, global name, discriminator, avatar URL, email and its verified flag, locale, MFA enabled, premium type, account flags.
- **OAuth:** the granted scopes, when they were granted, when the token was last checked, the token status (`valid`, `unauthorized`, `revoked`, or `missing`), and the token expiry. Access and refresh tokens are stored encrypted with AES-256-GCM; the record page never shows the token itself, only the expiry behind a reveal.
- **Network:** the first and last IP, stored as a hash, ciphertext, or plaintext per your `IP_STORAGE` mode, plus the IP history. From the local intel files: country, city, region, ISP, ASN and its org, the IP type, and the VPN, proxy, and Tor flags. These are shown as a classification with the ASN and org as the evidence, not as a verdict.
- **Presence:** the `guilds` scope list, filterable to the servers where the user is not in yours.
- **Connections:** linked accounts with their type and verified flag.
- **Fingerprint:** OS, browser, version, locale, timezone, screen, referrer, user agent, and the audio-device count. This is a fixed, documented list, not an extensible grab bag, and it is not shown on the website (operator decision). The list lives in `docs/privacy.md`.
- **Events:** a timeline of OAuth, refresh, revocation, and note events.

Every field that is empty shows "not captured" rather than being absent, so you can tell "not captured" from "captured as empty".

## What the verify panel says

The panel's copy line is fixed:

> pressing the button opens discord's own consent screen, which lists every permission this server asks for.

The site itself says nothing else about the capture, and it has no disclosure or revoke page (operator decision). Discord's consent screen names the permissions your panel asks for, and `docs/privacy.md` is the record of what the verification stores. If you keep a privacy page of your own, list the exact scopes your panel requests: a panel without `connections` should not claim linked accounts are captured.
