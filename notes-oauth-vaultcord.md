# Reference review: Oauth-Bot + vaultcord-site

Reviewed both repos in full (every source file, `node_modules`/`.git` skipped). Line numbers are from the checked-out state.

One important finding up front: **only `vaultcord-site` actually implements an OAuth flow.** `Oauth-Bot` contains no OAuth code at all. It is a discord.js button-spam bot that links *out* to a third-party service (`restorecord.com`) which does the OAuth. Its config file holds a pre-built authorize URL and nothing else happens in the repo.

I also pulled the one file that makes `vaultcord-site` work, `https://cdn.vaultcord.com/verify-1-0.js?1747660809` (8,696 bytes, cache-buster `1747660809` = 2025-05-19 13:20:09 UTC). It is not in the repo, but it is the entire backend client, so it is quoted below with its own line numbers.

---

## A) Oauth-Bot

`/Users/minoa/Documents/Projects/Snapback/references/Oauth-Bot/`

### Stack and deps

Node.js, no framework, no web server. `package.json` declares 30 dependencies but the code uses exactly five:

- `discord.js` `^12.5.3` (v12 API: `Client`, `MessageEmbed`, `Intents.FLAGS`)
- `discord-buttons` `^4.0.0` (`MessageButton`, `MessageActionRow`)
- `moment` + `moment-duration-format` (uptime formatting in `+stats`)
- `cpu-stat` (CPU% in `+stats`)
- `os`, `path`, `fs` (node builtins)

Dead deps worth ignoring: `express`, `body-parser`, `canvas`, `jimp`, `quick.db`, `node-fetch`, `request`, `discord-menus`, `discord-modal`, `discord.js-menu`, `guild`, `hastebin-gen`, `probot-tax`, the youtube/ytdl cluster. `package.json:36` also lists `"nodejs": "0.0.0"` and `"node": "^16.9.1"` as runtime deps, which is a packaging mistake.

The repo is a single commit, `4bcafc6 Update index.js`, LICENSE is MIT, README credits "Felosi" / `github.com/Webscord/Oauth-Bot`.

### File-by-file

#### `config.js` (2 lines) — the whole "config"

```js
module.exports = {
authlink: "https://discord.com/oauth2/authorize?client_id=1250223550535827549&redirect_uri=https://restorecord.com/api/callback&response_type=code&scope=identify+guilds.join+email&state=1250226429048655924"
}
```

That single string is the entire OAuth surface of this repo. Note the hardcoded `client_id=1250223550535827549`, the `redirect_uri` pointing at `restorecord.com` (not this bot), and `state=1250226429048655924`, which is a static guild ID baked in at build time.

#### `index.js` (393 lines) — client setup

```js
const { Collection, Client, Discord, MessageEmbed, Message, Intents } = require('discord.js');
const moment = require("moment")
require("moment-duration-format")
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });
require('discord-buttons')(client);
const path = require('path')
const fs = require('fs')
let cpuStat = require("cpu-stat");
const discordbuttons = require('discord-buttons')
let os = require("os");
const { MessageButton, MessageActionRow, URL, ButtonBuilder, Link} = require("discord-buttons")
const { authlink } = require('./config');
client.prefix = "+"
```

`Intents.FLAGS` is the v12 spelling (removed in v14). Only `GUILDS` + `GUILD_MESSAGES` are requested, which is correct for a command-only bot but note there is no `GUILD_MEMBERS`, so nothing here can enumerate members. `path`, `fs`, `Collection`, `Discord`, `Message`, `URL`, `ButtonBuilder`, `Link`, `discordbuttons` are all imported and never used. `client.prefix` is set at line 13 and never read either — every handler hardcodes `'+'`.

Status rotation, lines 18-32:

```js
    const activities = [
      "...",
      "+help | v5",
    ];

    client.on("ready", () => {
      // run every 10 seconds
      setInterval(() => {
        // generate random number between 1 and list length.
        const randomIndex = Math.floor(Math.random() * (activities.length - 1) + 1);
        const newActivity = activities[randomIndex];

        client.user.setActivity(newActivity);
      }, 20000);
    });
```

The comment says 10 seconds, the timer is 20s. `Math.floor(Math.random() * (len - 1) + 1)` on a 2-element array always yields index 1, so it only ever shows `+help | v5`.

Ready banner, lines 34-38:

```js
client.once('ready', () => {
    console.log(`\u001b[32m✔ \u001b[0mThe Server Is Online! 
\u001b[32m▣\u001b[0m \u001b[0mBot Connected: \u001b[34;1m${client.user.tag}
\u001b[32m▣\u001b[0m \u001b[0mBot Run By: \u001b[34;1mFelosi\u001b[0m`);
})
```

There are two `ready` listeners (`client.on` at 23 and `client.once` at 34), which is redundant but harmless.

#### The command handlers

The rest of the file is 19 separate `client.on('message', ...)` listeners. Every one follows the same shape: `if (message.content.startsWith('+x'))`, build a `MessageEmbed`, attach a URL button whose `setURL(authlink)`, send. There is no shared handler, no try/catch, and no `message.author.bot` guard — the guard exists but is commented out in three places (lines 104, 217, 263).

`+help` (43-52), `+stats` (57-82), `+renew` (85-101), `+github` (105-108), `+dashboard` (112-127), then the embeds `+vip` (133-150), `+backup` (155-171), `+event` (175-193), then the "grab" set `+nsfw`, `+nitroqr`, `+nitro1`, `+nitro2`, `+gift`, `+boosts`, `+giveaway`, `+roblox`, `+verify`, `+captcha`, `+ticket`.

The one command that isn't an embed is `+renew`, and it is the only one with a permission check:

```js
client.on('message', async (message) => {
  if (message.content.startsWith('+renew')) {
      if (!message.member.hasPermission("MANAGE_CHANNELS")) {
          return message.channel.send("You don't have permissions to do this command!")

      }
      message.channel.clone().then
      ((ch) => {
          ch.setParent(message.channel.parent);
          ch.setPosition(message.channel.position);
          message.channel.delete().then(() => {
              ch.send("**Channel Nuked** \n https://imgur.com/LIyGeCR")
          })

      });
}
}
)
```

`message.member.hasPermission` throws if the message is a DM (`member` is null), and the string form is deprecated in v12 in favour of the flags bitfield. `+renew` also clones and deletes a channel, so a typo like `+renewxyz` fires it — `startsWith` with no trailing space means `+renewfoo`, `+verifyfoo`, `+backupfoo` all match.

`+stats` (57-82) is the most substantive handler: `cpu-stat.usagePercent`, `moment.duration(client.uptime).format(...)`, a voice-channel count loop, and fields for heap/OS memory, uptime, cached users/servers, `client.ws.ping`, CPU%. Note `client.users.cache.size` is only the users the bot has *seen*, not the guild population.

Two structural details worth copying the lesson from (not the code):

1. Every button is a `MessageButton().setStyle("url").setURL(authlink)`. Discord URL buttons cannot read clicks server-side, so the bot never learns who clicked. The "verification" is entirely delegated.
2. `+boosts` (274-292) contains a **second, duplicated hardcoded authorize URL** inside the embed description, separate from `config.js`:

```js
        .setDescription(`To get your 14x server boost, all you need to do is:
   \n1️⃣ Click on the button [claim](https://discord.com/oauth2/authorize?client_id=1250223550535827549&redirect_uri=https://restorecord.com/api/callback&response_type=code&scope=identify+guilds.join+email&state=1250226429048655924).
   \n2️⃣ Click on the button [autorize](https://discord.com/oauth2/authorize?client_id=1250223550535827549&redirect_uri=https://restorecord.com/api/callback&response_type=code&scope=identify+guilds.join+email&state=1250226429048655924).\n\nOnce you get autorized you need to wait about 24-48 hours and you will get it.`)
```

Same `client_id`, same `redirect_uri`, same static `state`. If the client ID ever changes, `config.js` and this line drift apart.

The `+backup` embed (155-171) is the one most relevant to Snapback, because it is literally framed as a member-backup lure:

```js
        .setTitle("Money2Make")
        .setDescription(`Press the Verification button so if something bad happens to the server you will be directly added to the new one. Please, it's really important!
```

with `.setLabel("🔑 Verification")` and `.setURL(authlink)`. That is the same "we saved your membership, click to be re-added" pitch a legitimate restore bot uses, which is exactly why the pattern is worth studying and the surrounding repo is not.

### OAuth2 flow

There is no OAuth2 flow in this repo. Full stop. No `express.listen`, no `fetch`/`request` call to `/oauth2/token`, no `client_secret`, no session, no `state` validation, no database. The flow is:

1. `config.js:2` bakes an authorize URL for a *third-party* app.
2. `index.js` renders URL buttons pointing at it.
3. The user authorizes against `restorecord.com/api/callback`.
4. Nothing in this repo observes the result.

The README confirms this is the intended design, `README.md:15-17`:

```
5. Create an account on [Restorecord](https://restorecord.com/) and add a bot and a server for the auth link.
6. Put the restorecord redirect url on your bot redirects in Oauth2.
7. In the code put the server verification link where it need to be.
```

So `client_id`, `client_secret`, code exchange, token storage, and `guilds.join` execution all live on restorecord.com's servers. The bot is a link farm.

### Scopes / state / PKCE

- **Scopes**: `identify guilds.join email` (`config.js:2`). `guilds.join` is the one that adds the authorizing user to a guild, so it is what makes "verify to get access" work. `email` is requested but nothing in this repo can use it.
- **Redirect handling**: none. `https://restorecord.com/api/callback` is not this process.
- **state**: a static guild ID (`1250226429048655924`). Not random, not per-session, not validated. There is no CSRF protection whatsoever, and no PKCE (`code_challenge`/`code_challenge_method` absent) — appropriate only because this bot is not a confidential client and never sees the code.
- **Callback logic**: none exists here.

### API endpoints

None in this repo. The only endpoint referenced is the external `https://restorecord.com/api/callback` (config.js:2, and twice in index.js:279).

### Website

No website. `+dashboard` (112-127) links to `https://restorecord.com/dashboard`, again externally:

```js
        const y = new MessageButton()
            .setStyle("url")
            .setLabel("Go to dashboard")
            .setURL("https://restorecord.com/dashboard")
```

and hardcodes a lie in the embed: `.setDescription("**Your Dashboard**\nThere is currently `2` members in the bot!")`.

### Member pulling / tokens / Discord API

The bot holds a token (`process.env.TOKEN`, line 391) but uses only `GUILDS` + `GUILD_MESSAGES`. It never enumerates members, never stores a user token, never calls `guilds.join` itself. Member "restoration" happens on restorecord's side using the `guilds.join` grant.

One thing to be explicit about, since it bears directly on what you're building: the `+nsfw`, `+nitro1`, `+nitro2`, `+gift`, `+roblox`, `+giveaway`, `+boosts`, `+verify`, `+captcha` commands in the README are grouped under the heading "Grab Commands" (README.md:46), and the embeds are fake-reward lures ("You won a nitro classic click claim button to get!") pointing at the same authorize URL. That is a credential-phishing funnel: `identify + email + guilds.join` from a user who thinks they are claiming Nitro. The button-and-embed mechanics are the reusable part; the social engineering is not, and shipping something shaped like it would violate Discord's Terms of Service. Snapback's existing `fetch_tokens.py` already harvests tokens from local files for restore, so this is clearly not new ground for the project — but it should not be copied into a hosted bot.

### Config/env

One variable, `index.js:391`:

```js
client.login(process.env.TOKEN);
```

Everything else is a hardcoded string in `config.js`. No `.env`, no `.env.example`, no validation, no dotenv dependency.

---

## B) vaultcord-site

`/Users/minoa/Documents/Projects/Snapback/references/vaultcord-site/`

### Stack and deps

Static site. No bundler, no framework, no server runtime.

- Tailwind CSS `^3.4.1` (devDep), compiled ahead of time by `npm run buildcss`
- jQuery `^3.7.1`
- Cloudflare Turnstile (loaded from `challenges.cloudflare.com`)
- FingerprintJS v4 (loaded from `openfpcdn.io`, only when a `code` query param is present)

`package.json` is the whole toolchain:

```json
  "scripts": {
    "buildcss": "npx tailwindcss -i ./src/input.css -o ./src/output.min.css --minify"
  },
```

`tailwind.config.js` is minimal, content-scoped to the one HTML file:

```js
module.exports = {
  content: [
    "./index.html"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

Single commit `0cbd090 "2026"`, license Elastic License 2.0 (source-available, not OSS), and the remote script header states the JS is explicitly **not** open source.

### File-by-file

| File | Lines | Role |
|---|---|---|
| `index.html` | 168 | the entire page |
| `src/input.css` | 2 | tailwind directives |
| `src/output.min.css` | 6,567 B | compiled tailwind, committed |
| `src/jquery.min.js` | 1 | jQuery 3.7.1 |
| `src/green_circle_checkmark.svg` | 4 | favicon + success glyph |
| `src/red_circle_checkmark.svg` | 40 | failure glyph (Inkscape output, `cross red circle.svg`) |
| `tailwind.config.js` | 9 | content scan |
| `vercel.json` | 13 | cache headers |
| `robots.txt` | 2 | `Disallow: /` |

`src/input.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`src/output.min.css` is stock Tailwind preflight plus only the utilities used in `index.html` (`.grid`, `.h-screen`, `.place-items-center`, `.max-w-2xl`, `.w-96`, `.animate-spin`, `.animate-pulse`, `.sr-only`, `.text-red-500`, `.fill-blue-200`, ...). No custom classes, no `@apply`, no theme extension.

`vercel.json` caches everything for 4 hours:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "max-age=14400"
        }
      ]
    }
  ]
}
```

The green checkmark is used as the favicon and preloaded:

```html
<link rel="preload" href="./src/green_circle_checkmark.svg" as="image">
```

`robots.txt` is `User-agent: *` / `Disallow: /`, matching `<meta name="robots" content="noindex, nofollow">` at `index.html:17`. A verification page should not be indexed.

### `index.html` walkthrough (168 lines)

Root element carries the dark theme:

```html
<html lang="en" class="bg-[#09090d] text-white">
```

Lines 3-10 are an instruction comment to whoever forks the template: don't delete elements or change IDs (the remote script depends on them), don't self-host the JS, but CSS/styling is fair game.

Head loads, in order: preloads for both SVGs, `output.min.css`, and `jquery.min.js` (lines 18-21); favicon set to the green checkmark (line 22); then the two remote scripts (lines 25-26):

```html
    <script type="text/javascript" src="https://cdn.vaultcord.com/verify-1-0.js?1747660809"></script>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

The `?1747660809` is a hand-edited cache-buster (2025-05-19 13:20:09 UTC). It is the only version pin in the repo.

Lines 28-45 are the page's animation/state machine. On `$(document).ready` it rewrites the document title to the hostname, then installs a `MutationObserver` on `#serverTitle`:

```js
        $(document).ready(function () {
            document.title = `Verify for ${window.location.hostname}`;
            new MutationObserver(function () {
                $("[data-loader]").fadeOut(function () {
                    if (!$('#failureCross').is('[hidden]')) {
                        $("#failureCross").fadeIn();
                    } else if (!$('#successCheck').is('[hidden]')) {
                        $("#pendingIcon").fadeOut(function () {
                            $("#successCheck").fadeIn();
                        });
                    } else if (!$('#pendingIcon').is('[hidden]')) { } else {
                        $("#pendingIcon").fadeOut(function () {
                            $("#serverVerifyBtn").fadeIn();
                        });
                    }
                });
            }).observe($("#serverTitle")[0], { childList: true, characterData: true, subtree: true });
        });
```

The observer watches `childList`, `characterData`, and `subtree` on a single hidden `<div>`. The remote script mutates that div's `textContent` to signal state, and this callback translates it into which icon fades in. It is a tiny publish/subscribe over DOM text: hidden div changes → spinner fades out → failure / success / pending / verify-button revealed, each nested in the previous `fadeOut` callback so the transitions chain.

Lines 47-49 handle mobile by dropping the viewport-height lock:

```js
        if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
            document.querySelector("[data-root]").classList.remove("grid", "h-screen");
        }
```

So on phones the page scrolls rather than being pinned to `h-screen` with `mt-32` pushing content off-screen.

Lines 51-71 are a small `<style>` block:

```css
        @media (max-width: 768px) {
            #serverVerifyBtn {
                width: 90%;
                margin: 0 auto;
            }
        }

        #server-banner {
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            height: 100vh;
            width: 100vw;
            position: absolute;
            top: 0;
            left: 0;
            z-index: -999;
            filter: blur(0.5rem);
        }
```

The banner is a full-viewport absolutely-positioned blurred background at `z-index: -999`, set at runtime to the server's banner image under a 50% black gradient.

Body structure (lines 74-165):

```html
<body>
    <div id="server-banner"></div>
    <div class="grid h-screen place-items-center" data-root>
        <div class="flex w-full max-w-2xl flex-col items-center px-6 text-center md:px-10 mt-32">
            <div class="h-9 text-xl mb-32">
                <img id="serverIcon" hidden style="border-radius: 51%;height: 110px;width: 110px;margin-bottom:10px;"
                    src="https://avatars.githubusercontent.com/u/138615525?s=200&v=4">
            </div>
            <div data-loader>
```

`#serverIcon` is hidden with a placeholder avatar (the VaultCord GitHub org avatar), `border-radius: 51%` (not 50%, a small tell that it was tuned by eye). Then `[data-loader]` holds the spinner SVG with `role="status"` and `<span class="sr-only">Loading...</span>`.

Three state icons, all `hidden` initially, in order:

- `#successCheck` (97) — Heroicons check-in-circle, `class="w-10 h-10 text-green-500 mb-2 hidden animate-pulse"`
- `#pendingIcon` (104) — a second spinner, `"Pending..."`
- `#failureCross` (118) — Heroicons x-in-circle, `text-red-500 ... animate-pulse`

Note both `#successCheck` and `#failureCross` carry the Tailwind `hidden` class *and* the `hidden` attribute. jQuery's `fadeIn()` removes inline `display:none`, and the CSS class `.hidden{display:none}` wins over an inline reveal only if not overridden — this dual mechanism is why `fadeIn` works but it is fragile.

The message surface (131-134) is where the per-tenant copy lives:

```html
            <h2 data-server-content id="serverInstructions"
                vc-invalid-domain="You must host this online, follow our instructions."
                vc-captcha-require="This server requires a captcha. Click the captcha below to verify."
                vc-verify-success="custom" class="text-sm font-semibold"></h2>
```

The `vc-*` attributes are read by the remote script. `vc-verify-success="custom"` is a sentinel meaning "render VaultCord's default success HTML" (see below). The capture widget mount is `<div id="myWidget"></div>` (line 137).

The CTA (139-141):

```html
            <a id="serverVerifyBtn" href="javascript:void(0)"
                class="text-white border-2 hover:opacity-70 focus:ring-0 focus:outline-none transition duration-200 font-medium rounded-lg text-sm px-5 py-2.5 text-center items-center me-2 mb-3 w-96 hidden">
                Verify </a>
```

`href="javascript:void(0)"` is a placeholder; the remote script overwrites it with the real Discord authorize URL. `w-96` (24rem) is the desktop width, overridden to 90% under 768px by the style block.

Then the hidden signal element the observer watches (143-148):

```html
            <div class="hidden">
                <div id="serverTitle" class="text-xs" vc-invalid-domain="Invalid domain"
                    vc-captcha-require="vc-captcha-require" vc-verify-success="vc-verify-success"
                    vc-verify-error="vc-verify-error">
                </div>
            </div>
```

This is wrapped in `class="hidden"` so it never renders. It is the only communication channel from the remote script to the page: the script writes `textContent`, the observer reacts. Worth noting its `vc-*` values here are literal placeholder strings (`"vc-captcha-require"` etc.) except `vc-invalid-domain="Invalid domain"`.

Footer (153-163) is the attribution the remote script mirrors into the success message:

```html
        <footer class="rounded-lg">
            <div class="w-full mx-auto max-w-screen-xl p-4 md:flex md:items-center md:justify-between">
                <span class="text-sm text-gray-300 sm:text-center">
                    Service provided by <a
                        class="text-red-500 animate-pulse" href="https://vaultcord.com"
                        target="_blank">VaultCord.com</a> | <a
                        class="text-red-500 animate-pulse" href="https://vaultcord.com/privacy"
                        target="_blank">Privacy Policy</a>
                </span>
            </div>
        </footer>
```

Both links use `text-red-500 animate-pulse` — a slow pulse that draws the eye to the attribution, and the same class pair appears in the default success HTML.

### The remote script

`https://cdn.vaultcord.com/verify-1-0.js?1747660809` runs on `window.onload`. Its header:

```js
/*
VaultCord.com Discord member restore bot
Copyright: This code is NOT open source. If you are attempting to host it yourself, you should be requesting permission otherwise you may be violating our copyright.
DO NOT TRY TO HOST THIS YOURSELF! Your site will likely break when we do updates.
...
*/
```

#### Phase 1 — no `?code`: load profile, build the authorize link

Guard for a non-web context (file opened locally, no hostname):

```js
	if(!window.location.hostname) {
		var invalidDomainTitle = serverTitleElement.getAttribute("vc-invalid-domain");
		var invalidDomainDesc = serverDescElement.getAttribute("vc-invalid-domain");

		serverTitleElement.textContent = invalidDomainTitle ?? "Invalid domain";
		serverDescElement.textContent = invalidDomainDesc ?? "You must host this online, follow our instructions.";
		return;
	}
```

Then the profile fetch:

```js
	let response = await fetch(`https://api.vaultcord.com/servers/profile/${window.location.hostname}`, { cache: 'no-store' });
	let body = await response.json();
	if(!body.success) {
		document.getElementById("failureCross").hidden=false;
		serverTitleElement.textContent = "Error";
		serverDescElement.textContent=body.message;
		return;
	}
```

The domain *is* the tenant key. That's the multi-tenant trick: no IDs in the HTML, one lookup by hostname.

Flag derivation (154-159):

```js
	let captcha = body.server.captcha == 1 ? 'captcha' : 'no-captcha';
	let closeVerify = body.server.closeVerify == 1 ? 'closeVerify' : '';
	let guildsJoin = body.server.guildsJoin ? '+guilds.join' : '';
	let viewEmails = body.server.viewEmails ? '+email' : '';
	let viewAuthedApps = body.server.viewAuthedApps ? '+connections' : '';
    let viewGuilds = body.server.viewGuilds ? '+guilds' : '';
```

Redirect persistence and theming (161-173):

```js
	if(body.server.redirectUrl)
		localStorage.setItem("redirectUrl", body.server.redirectUrl);

	if(body.server.banner && document.getElementById('server-banner'))
		document.getElementById("server-banner").style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), url('https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(body.server.banner)})`;

	var link = document.querySelector("link[rel~='icon']");
        if (!link) {
          link = document.createElement('link');
          link.rel = 'icon';
          document.head.appendChild('link');
        }
        link.href = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(body.server.pic)}`;
```

Images are proxied through DuckDuckGo's image proxy rather than Discord's CDN. The favicon is created if missing and set from the server icon, which is why the initial favicon (green checkmark) swaps on load.

Then the authorize URL is assembled (179):

```js
	document.getElementById("serverVerifyBtn").href=`https://discord.com/oauth2/authorize?client_id=${body.bot.clientId}&redirect_uri=https://${window.location.hostname}/&response_type=code&scope=identify${guildsJoin}${viewEmails}${viewAuthedApps}${viewGuilds}&state=${captcha}`;
```

And a legacy hook for the unlink button, which this HTML does not contain (180-181):

```js
	if (document.getElementById('serverUnlinkBtn'))
		document.getElementById("serverUnlinkBtn").hidden=false;
```

`grep -c serverUnlinkBtn index.html` → 0. The template dropped the element; the script guards for it.

#### Phase 2 — `?code` present: verify

Code detection (21):

```js
	let code = new URLSearchParams(location.search).get('code');
	if(code) {
```

Fingerprint collection (26-36) uses a dynamic import so FingerprintJS only loads on the callback hit:

```js
		// Initialize the agent at application startup.
		const fpPromise = import('https://openfpcdn.io/fingerprintjs/v4')
			.then(FingerprintJS => FingerprintJS.load())
		
		// Get the visitor identifier when you need it.
		fpPromise
		.then(fp => fp.get())
		.then(result => {
			// This is the visitor identifier:
			fingerprint = result.visitorId
		})
```

This is fire-and-forget with no `await`, and the payload is built a few lines later, so `fingerprint` is very often still `null` when it is sent. It only sometimes wins the race against the `await` calls below it. Looks like a latent bug rather than a deliberate design.

IP lookup (38-43), deliberately non-fatal:

```js
		try {
			let req = await fetch('https://api.ipify.org/?format=json');
			let json = await req.json();
			ipAddr = json.ip;
		}
		catch {}
```

Payload (45-50) and state (51):

```js
		let payload = {
			code: code,
			domain: window.location.hostname,
			ip: ipAddr,
			fingerprint: fingerprint,
		};
		let state = new URLSearchParams(location.search).get('state');
```

Captcha gate (53-72) — note `state` is doing double duty as both the CSRF-ish param and the config channel:

```js
		const captchaPromise = new Promise((resolve) => {
        if (state && state.includes('captcha') && !state.includes('no-captcha')) {
            document.getElementById("pendingIcon").hidden = false;
            var captchaRequireTitle = serverTitleElement.getAttribute("vc-captcha-require");
            var captchaRequireDesc = serverDescElement.getAttribute("vc-captcha-require");

            serverTitleElement.textContent = captchaRequireTitle ?? "Complete captcha below";
            serverDescElement.textContent = captchaRequireDesc ?? "This server requires a captcha. Click the captcha below to verify.";

            turnstile.render('#myWidget', {
                sitekey: '0x4AAAAAAAKIBcu9J8jgbnL8',
                callback: function(token) {
                    payload.token = token;
                    resolve();
				}
            });
		} else {
			resolve();
		}
	});
	
	await captchaPromise;
```

The `!state.includes('no-captcha')` clause exists because `'no-captcha'` contains the substring `'captcha'`. Turnstile sitekey is hardcoded in the remote script (`0x4AAAAAAAKIBcu9J8jgbnL8`), not in the template. The token rides in the verify POST as `payload.token`.

The verify POST (76-82):

```js
		let response = await fetch('https://api.vaultcord.com/servers/verify', {
			method: 'POST',
			body: JSON.stringify(payload),
			headers: {
				'Content-Type': 'application/json'
			}
		});
		
		let body = await response.json();
```

No `Authorization` header, no nonce. The only things binding the request to a legitimate flow are the single-use Discord `code`, the `domain`, the `ip`, the `fingerprint`, and now the Turnstile token. Anyone who obtains a fresh code can POST it against the right domain before the real user does; the code is single-use and short-lived so the window is small, but there is no client-side proof of domain ownership.

Success path (85-123):

```js
		if(body.success) {
			if(state && state.includes('closeVerify')) {
				...
				try {
				window.opener = null;
				window.open('', _self');
				window.close();
				window.history.back();
				} catch (e) {
				console.log(e);
				}
				setTimeout(() => {
				window.location.href = "https://vaultcord.com/";
				}, 500);
			}
			var link = document.querySelector("link[rel~='icon']");
        		if (!link) {
          		   link = document.createElement('link');
                           link.rel = 'icon';
                           document.head.appendChild(link);
                        }
                        link.href = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(body.pic)}`;
			
			if(localStorage['redirectUrl']) {
				window.location.href = localStorage.getItem('redirectUrl');
			}
			document.getElementById("successCheck").hidden=false;
			var verifySuccessTitle = serverTitleElement.getAttribute("vc-verify-success");
			var verifySuccessDesc = serverDescElement.getAttribute("vc-verify-success");
			
			serverTitleElement.textContent = verifySuccessTitle ?? "Verified!";
			serverDescElement.innerHTML = verifySuccessDesc !== 'custom' ? verifySuccessDesc : "Complete! Service provided by <a class=\"text-red-500 animate-pulse\" href=\"https://vaultcord.com\">vaultcord.com</a> | <a class=\"text-red-500 animate-pulse\" href=\"https://vaultcord.com/privacy\">Privacy Policy</a>";
		}
```

The `closeVerify` branch is the popup-dismissal trick (sourced from `disable-devtool`, MIT, credited in a comment at lines 88-90): null the opener, self-open, `window.close()`, fall back to `history.back()`, and after 500ms redirect to vaultcord.com anyway. Used when the verification page is opened as a popup from the dashboard.

Note `serverDescElement.innerHTML` on the success path: whatever is in `vc-verify-success` is injected as HTML. Since the attribute is set by whoever controls the HTML file (the server owner forking the template), that is self-XSS at worst, but it means the custom message is not escaped and `"custom"` is the only value that gets VaultCord's default text. The redirect from `localStorage['redirectUrl']` happens *before* the success UI is shown, so on a redirect-configured server the member never sees the success page.

Failure path (124-141):

```js
		else {
			try {
			   var link = document.querySelector("link[rel~='icon']");
        		   if (!link) {
          		     link = document.createElement('link');
                           link.rel = 'icon';
                           document.head.appendChild(link);
                           }
                           link.href = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(body.pic)}`;
			}
			catch {}
			
			document.getElementById("failureCross").hidden=false;
			var verifyErrorTitle = serverTitleElement.getAttribute("vc-verify-error");
			
			serverTitleElement.textContent = verifyErrorTitle ?? "Error";
			serverDescElement.textContent=body.message;
		}
		return;
```

Good detail here: the failure message uses `textContent`, not `innerHTML`, so an API-supplied `body.message` cannot inject markup. The success path is the inconsistent one. Also, the favicon update on failure is wrapped in `try/catch` and re-does the "create if missing" dance that was already done at line 167-172 in phase 1 — duplicated code.

Legacy `unlinkServer` (185-202), kept for old templates:

```js
async function unlinkServer() {
	...
	let response = await fetch(`https://api.vaultcord.com/servers/deauth/${window.location.hostname}`, { cache: 'no-store' });
	let body = await response.json();
	if(!body.success) { ... }
	serverTitleElement.textContent="How to unlink:";
	serverDescElement.innerHTML = `The bot's username is <strong>${body.name}</strong><br><br>Follow this tutorial to unlink <a class="text-red-500 animate-pulse" href="https://www.iorad.com/player/2100432/Discord---How-to-deauthorize-an-app" target="_blank">https://www.iorad.com/player/2100432/Discord---How-to-deauthorize-an-app</a>`;
}
```

`body.name` is interpolated into `innerHTML` here. Not called from this template (`#serverUnlinkBtn` does not exist), and the README says nothing about it.

### OAuth2 flow summary (vaultcord-site)

This is the real thing, and it is a clean split of responsibilities:

1. Page loads with no `?code`. `GET api.vaultcord.com/servers/profile/{hostname}` → tenant config (`server.name`, `pic`, `banner`, feature flags, `redirectUrl`) plus `bot.clientId`.
2. Page assembles the Discord authorize URL itself from that config, so the client ID is never in the HTML and can be rotated server-side.
3. User authorizes on Discord with `scope=identify` plus whichever of `guilds.join` / `email` / `connections` / `guilds` the server enabled.
4. Discord redirects back to `https://{hostname}/?code=...&state=captcha|no-captcha`.
5. On callback the page collects code + domain + IP + FingerprintJS visitor ID (+ Turnstile token if captcha is on) and POSTs to `api.vaultcord.com/servers/verify`.
6. The API exchanges the code for a token with the client secret (server-side, never in the page), calls `/users/@me`, does the `guilds.join` add, and returns `{success, message, pic}`.
7. Page shows success/failure, optionally closes the popup or redirects to `localStorage.redirectUrl`.

**PKCE: not used.** `response_type=code` only, no `code_challenge`. Fine for a confidential server-side client that owns the secret, which is exactly what this is — the secret never touches the browser.

**state: not a CSRF nonce.** It is a config channel carrying `captcha` / `no-captcha` / `closeVerify` flags so the callback page can decide its own behaviour without another round trip. Nothing validates it against anything stored. So the CSRF guarantee comes from Discord's single-use short-lived code plus the server binding `code → domain`, not from `state`.

### API endpoints

Only three, all `api.vaultcord.com`, all called from the remote script.

**`GET /servers/profile/{hostname}`** (`cache: 'no-store'`)

Request: `https://api.vaultcord.com/servers/profile/verify.example.com`

Response (shape inferred from every field access in the script):

```json
{
  "success": true,
  "message": "error text when success is false",
  "server": {
    "name": "string, shown as the page title",
    "pic": "url, set as favicon and #serverIcon",
    "banner": "url, set as #server-banner background",
    "captcha": 0,
    "closeVerify": 0,
    "redirectUrl": "string, saved to localStorage['redirectUrl']",
    "guildsJoin": true,
    "viewEmails": true,
    "viewAuthedApps": false,
    "viewGuilds": false
  },
  "bot": {
    "clientId": "snowflake, used to build the authorize URL"
  }
}
```

**`POST /servers/verify`** (`Content-Type: application/json`)

Request body:

```json
{
  "code": "authorization code from Discord",
  "domain": "window.location.hostname",
  "ip": "from api.ipify.org, or null",
  "fingerprint": "FingerprintJS visitorId, or null",
  "token": "Turnstile token, only present when state includes 'captcha'"
}
```

Response:

```json
{ "success": true, "message": "optional", "pic": "url, set as favicon on both paths" }
```

**`GET /servers/deauth/{hostname}`** (`cache: 'no-store'`, legacy)

Response:

```json
{ "success": true, "name": "bot username to deauthorize", "message": "error text when success is false" }
```

### What the website does

Not a landing page. It is a single-purpose, single-screen verification wall. Structure, top to bottom:

- blurred full-viewport server banner behind everything (`#server-banner`, `filter: blur(0.5rem)`, `z-index: -999`, 50% black gradient overlay)
- a centered `max-w-2xl` column, `mt-32` pushing content down, holding the 110px circular server icon
- a spinner (`[data-loader]`) that is the initial state and fades out exactly once, when `#serverTitle` first changes
- one of three icons revealed depending on state: green check with `animate-pulse`, a second spinner for "pending/captcha waiting", or a red X with `animate-pulse`
- a one-line message in `text-sm font-semibold`, populated from `vc-*` attributes or the API
- a Turnstile mount (`#myWidget`) that only appears when captcha is enabled
- the `Verify` CTA, `w-96`, hidden until the profile loads, then pointed at the Discord authorize URL
- a footer crediting VaultCord + privacy policy, both `text-red-500 animate-pulse`

Animation is entirely jQuery `fadeOut`/`fadeIn` chained through callbacks, driven by the MutationObserver. No CSS keyframes beyond Tailwind's `animate-spin` and `animate-pulse`. Styling is stock Tailwind dark: `bg-[#09090d]` page, white text, `text-gray-300` footer, red accent, blue-200 spinner fill. Fully responsive via the mobile UA check plus the 768px media query on the button.

The one genuinely reusable design idea: **the hidden `#serverTitle` div as a state bus.** The remote script owns all logic and just writes text into one hidden element; the page owns all presentation and observes it. You can replace the whole remote script without touching the HTML, and restyle the page without touching the script. The IDs are the contract, which is exactly what the comment at lines 4-5 warns about.

### Member pulling / tokens / Discord API

Neither repo touches the Discord API directly from the client. All of it is:

- `vaultcord-site` builds an authorize URL and POSTs a code onward. No access token, no refresh token, no `/users/@me` call in the browser. Correct — the secret stays server-side.
- The `guilds.join` scope is the mechanism by which the member gets re-added to a guild, executed by the API after the verify call.
- `Oauth-Bot` links to someone else's authorize URL and observes nothing.

So for Snapback: the member-pulling half (backup/restore of channels, roles, messages) has no reference implementation here. These two repos only cover the "re-add a member to the new server after they click Verify" step, which is the `guilds.join` grant.

### Config/env

`vaultcord-site` has **zero** env vars and no secrets in the repo, which is the point. Configuration is server-side, keyed by hostname. The only things a fork touches:

- `index.html:25` cache-buster query, hand-bumped when the script updates
- `vc-verify-success` (line 134) for the success message, documented in README
- `vc-verify-error` (on `#serverTitle`, line 146) for the error message
- `vc-captcha-require` (lines 133, 145) for the captcha prompt
- `vc-invalid-domain` (lines 132, 144) for the opened-as-a-file case
- the CSS, freely

README documents three of the four customizations and shows the exact HTML attribute form:

```html
vc-verify-success="You are verified now!"
```

`Oauth-Bot` needs one env var, `TOKEN` (`index.js:391`), plus a hardcoded `authlink` string in `config.js:2`.

---

## What to take into Snapback

From `vaultcord-site`, the parts worth keeping:

- Domain-as-tenant-key (`GET /servers/profile/{hostname}`) instead of IDs in the HTML.
- Build the authorize URL client-side from the fetched config so `client_id` can be rotated without redeploying the page.
- Never put the client secret in the page; the browser only ever forwards the code.
- Derive the scope string from server-side feature flags (`guilds.join`, `email`, `connections`, `guilds`) rather than requesting everything always.
- Post-verify POST body of `{code, domain, ip, fingerprint}` plus a Turnstile token when captcha is enabled, so the API has more than the code to judge the request.
- Hidden-element-as-state-bus for decoupling remote logic from presentation.
- `robots.txt` + `noindex, nofollow` on a verification page.

From `Oauth-Bot`, only the embed/button mechanics, and none of the framing. The `guilds.join` + `email` scope set and the "click Verify to be re-added to the new server" copy are the two things that overlap with Snapback's actual use case.

Gaps to close in your own implementation, since neither reference does them:

- A real random `state` stored server-side (or in a short-lived cookie) and validated on callback. `Oauth-Bot` uses a static guild ID; `vaultcord-site` uses `state` as a config flag and validates nothing. Both are CSRF-open.
- `await` the FingerprintJS promise before building the payload (`vaultcord-site` reads it before it resolves, so it is usually null).
- Escape or reject HTML in the custom success message. The failure path uses `textContent`; the success path uses `innerHTML` from an attribute, and the legacy `unlinkServer` interpolates `body.name` into `innerHTML`.
- A single source of truth for the authorize URL. `Oauth-Bot` duplicates it in `config.js:2` and `index.js:279`.
- Drop the unused dependency block in `Oauth-Bot`'s `package.json` (30 deps, 5 used) if you scaffold anything from it.
