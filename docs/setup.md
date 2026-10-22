# Setup

Running Snapback from a clone to a bot that has finished its first setup wizard. This is the guide `/setup guide` renders, and `D4PLAN.md` is the design of record; if the two disagree, the plan wins and this file is wrong.

## What you need first

- Bun 1.3 or newer. Snapback runs on Bun only; there is no Node fallback.
- A Discord application with a bot user. See `docs/developer-panel.md` for the portal toggles and the intents.
- For the verification feature, a public HTTPS URL for the OAuth redirect. On a laptop that means a tunnel; see `docs/cloudflare-tunnel.md`.
- A Postgres server only if you want it. The default is a single DuckDB file.

## Install

```sh
git clone <this repo>
cd snapback
bun install
cp .env.example .env
```

Edit `.env` and fill the values below. Nothing else is required to boot beyond the two required keys.

## Configure

`.env` holds connection and process secrets. Everything an owner changes from Discord lives in the database and is written by `/setup`, so you edit this file once.

### Required before the process starts

`env.ts` parses and validates the environment at boot. If a required value is missing it prints a numbered list of exactly what is missing, then exits with code 1. The two unconditional ones are:

| Key | Meaning |
|---|---|
| `DISCORD_TOKEN` | the bot token from the Developer Panel |
| `DISCORD_OWNER_ID` | the Discord user id of the bot owner |

Also required, but only once the setting they serve is in use:

| Key | Required when |
|---|---|
| `IP_HASH_PEPPER` | `IP_STORAGE=hash`, which is the default |
| `ENCRYPTION_KEY` | `IP_STORAGE=encrypted`, or to encrypt the OAuth tokens |

Tokens are always encrypted at rest, so set `ENCRYPTION_KEY` before you enable verification. Whether boot refuses to start without it is not stated in `D4PLAN.md`; treat it as required for any deployment that runs the verification flow.

### Database

| Key | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | unset | unset uses `./data/snapback.duckdb`; a `postgres://user:pass@host:5432/dbname` value uses Postgres |

See `docs/self-hosting.md` for the DuckDB single-writer rule and how to move to Postgres.

### Web and verification

| Key | Default | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://example.com` | the public base URL the OAuth redirect and button point at |
| `PORT` | `8080` | the local port the web server listens on |
| `IP_STORAGE` | `hash` | `hash`, `encrypted`, or `plaintext` |
| `IP_HASH_PEPPER` | unset | required when `IP_STORAGE=hash` |
| `ENCRYPTION_KEY` | unset | 32-byte base64 key, for token encryption and `IP_STORAGE=encrypted` |
| `OAUTH_CLIENT_SECRET` | unset | the client secret from the developer portal. empty means the verification flow is off: the web routes still answer, and the flow refuses |

`IP_STORAGE=plaintext` logs a one-line warning at boot: captured IP addresses are personal data, and you are responsible for them. It is for local testing only.

The client id is the application id, so there is nothing to configure for it. The secret is the only piece the developer portal hands out that the bot holds.

### Captcha

| Key | Default | Meaning |
|---|---|---|
| `CAPTCHA_PROVIDER` | `none` | `none`, `turnstile`, `recaptcha`, or `cap` |
| `CAPTCHA_SITE_KEY` | unset | the public site key, rendered into the widget |
| `CAPTCHA_SECRET` | unset | the secret the server checks a token with. never sent to a browser |
| `CAPTCHA_BASE_URL` | unset | cap only: the origin of your own instance, no trailing slash |

With a provider set, the landing page asks for the challenge and the token is checked before any OAuth state is minted. Nothing reaches Discord without it. `none` keeps the old behaviour, where the button goes straight to Discord.

`turnstile` and `cap` are the two that do not hand a tracker a person's browser. `cap` is self-hosted, so it also keeps the challenge on your own domain. `recaptcha` works, but the widget and the check both go to Google.

```sh
CAPTCHA_PROVIDER=turnstile
CAPTCHA_SITE_KEY=0x4AAAAAAA...
CAPTCHA_SECRET=0x4AAAAAAA...
```

The keys live in the environment, not in a guild setting: the landing page is shared by every guild on the instance. `/setup` reports which provider is in force and never stores one. A provider named without its keys stops the process at boot with the missing key named, rather than half-working.

This is a challenge, not a solver. The project does not integrate a CAPTCHA-solving service, and `19.4` of `D4PLAN.md` says why.

### Proxy awareness

| Key | Default | Meaning |
|---|---|---|
| `BEHIND_CLOUDFLARE_TUNNEL` | `false` | when true, IP capture trusts `CF-Connecting-IP` and ignores `X-Forwarded-For` |
| `TRUSTED_PROXY_DEPTH` | `0` | how many proxy hops to skip when walking `X-Forwarded-For` |

Getting these wrong corrupts every captured address. See `docs/cloudflare-tunnel.md`.

### Intel

| Key | Default | Meaning |
|---|---|---|
| `DBIP_COUNTRY_MMDB` | `./data/dbip-country-lite.mmdb` | db-ip lite country/city file |
| `IP2ASN_TSV` | `./data/ip2asn.tsv` | address to ASN table |
| `AS_METADATA_JSON` | `./data/as-metadata.json` | ipverse `as-metadata`, ASN to org and type |
| `TOR_EXIT_LIST` | `./data/tor-exit-addresses.txt` | the Tor Project's exit addresses |
| `INTEL_ENABLED` | `true` | turn the local geolocation off if the data files are absent |
| `INTEL_UPDATE` | `true` | let the bot fetch the three files it can fetch; the mmdb is yours to download |

Missing data files skip geolocation with a warning in `/snapback status`, never a crash.

### Limits

| Key | Default | Hard ceiling |
|---|---|---|
| `MAX_MESSAGES_PER_CHANNEL` | `1000` | `10000` |
| `MAX_MESSAGES_TOTAL` | `10000` | `10000`, cannot be raised |
| `MAX_CONCURRENT_JOBS` | `2` | cross-guild concurrency |
| `PULL_DAILY_LIMIT_PER_ACCOUNT` | `100` | sane range 100 to 500, ceiling 500 |
| `PULL_COOLDOWN_HOURS` | `24` | cooldown after hitting the daily limit |
| `PULL_FAILURE_COOLDOWN_MINUTES` | `60` | shorter cooldown after a 403/429 burst |

The message counts are clamped in code, not trusted. A `.env` with `MAX_MESSAGES_TOTAL=999999` is clamped to 10000 with a warning.

### Storage

| Key | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | `./data/backups` | where `backups/<id>/assets/` lands |
| `EXPORT_DIR` | `./data/exports` | where a written export lands, swept after 24 hours |
| `MAX_ASSET_BYTES` | `8388608` | 8 MiB. a bigger asset is recorded with its url and not downloaded. `0` keeps the urls only |

The backup directory and the database file are siblings by default, so a move of the data directory moves both.

### Optional

| Key | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | verbosity of structured stdout |
| `AUTOMATION_ENABLED` | `true` | `false` turns the scheduler off and makes every job manual |
| `DISCORD_DEV_GUILD_ID` | unset | set it to register commands to one guild instantly while developing |

## First run

```sh
bun run dev     # watch mode: bot and web server in one process
bun start       # no watch
```

The command surface registers at boot. With `DISCORD_DEV_GUILD_ID` set, registration is guild-scoped and instant. Without it, commands register globally and can take up to an hour to appear everywhere.

Invite the bot to your guild using the install link. `/setup app` prints that link, computed from the scopes you pick, and shows the exact permission bitfield to request. Administrator is not required and is discouraged.

## The setup wizard

Run `/setup`. It is a resumable state machine persisted in the database; it honours "skip for now" everywhere, and `/setup status` shows what is still outstanding. A partial setup is a supported state, not a broken one.

The steps, in order:

| # | Step | Required to finish | What it does |
|---|---|---|---|
| 0 | welcome and scope disclosure | yes | says what the bot will do and what verification captures |
| 1 | app check | yes | blocks on the token, owner id, gateway, and `GUILD_MEMBERS` |
| 2 | web and tunnel | only if verification is on | `PUBLIC_BASE_URL`, port, tunnel checkbox, live loopback probe, and the name the pages show |
| 3 | branding | no | bot avatar and banner upload, GIF accepted, and display name |
| 4 | admins | no | offers the invoking user first, per-flag toggles |
| 5 | logging | no | log channel and event families, plus a test-fire so you see one entry |
| 6 | backup defaults | no | include set, message limits, auto-backup schedule |
| 7 | restore defaults | no | clear-before and timestamp suffix, both off by default |
| 8 | verification panel | only if verification is on | the panel, its colour, and its buttons |
| 9 | verification policy | only if verification is on | the network rule and the alt check, both off until you pick one |
| 10 | scopes | only if verification is on | the default three; the restricted scope needs an acknowledgement |
| 11 | finish | yes | writes `wizard.done`, prints the invite, the command list, and this doc |

Every step has a subcommand that jumps straight to it:

| Command | Step |
|---|---|
| `/setup` | opens at the first incomplete step |
| `/setup status` | every subsystem with a green, amber, or red dot, and a button to the fix |
| `/setup app` | step 1, the Developer Panel checklist and the self-test |
| `/setup web` | step 2, `PUBLIC_BASE_URL`, port, tunnel checkbox, live IP probe, the page name |
| `/setup admins` | step 4 |
| `/setup backup` | step 6 |
| `/setup restore` | step 7 |
| `/setup verify` | step 8, the panel builder |
| `/setup policy` | step 9, when a verification is refused |
| `/setup branding` | step 3 |
| `/setup logs` | step 5 |
| `/setup data` | database status and size, back up the database, export everything to JSON |
| `/setup guide` | renders this document, paginated |

Every save writes an audit row and confirms with the new value. Every number is clamped and every colour validated before it is written.

## Verify your install

`/setup app test` runs a scripted check and reports one line per step, each a pass or a failure with a fix:

- token valid
- owner id correct
- gateway connected
- `GUILD_MEMBERS` granted
- web port reachable
- public URL resolves
- redirect URI registered
- OAuth round-trip
- read message history
- message content present

`/snapback status` shows uptime, gateway latency, job depth, database driver and size, tracked guilds, and version. `/snapback diagnostics` runs the self-test plus database, disk, and permission probes and returns a copyable report.

## Where to go next

- `docs/developer-panel.md` for the portal, the intents, and the redirect string.
- `docs/cloudflare-tunnel.md` for a tunnel and the loopback IP failure.
- `docs/scopes.md` for every OAuth scope and what a record stores.
- `docs/self-hosting.md` for Postgres, retention, and the data files.
- `docs/troubleshooting.md` when something does not work.
