# AGENTS.md

Rules for writing code and commands in Snapback. Read `D4PLAN.md` first; it is the design. This file is the law for how the code gets written.

## Setup

```bash
bun install
cp .env.example .env      # fill DISCORD_TOKEN and DISCORD_OWNER_ID
bun run dev               # bot + web server, one process
bun run check             # typecheck + lint + test, the gate before every commit
bun run typecheck         # tsc --noEmit only
bun run lint              # linter only
bun test                  # tests only
```

`bun run check` is `typecheck && lint && test` and is the only thing that counts as passing.

`DISCORD_DEV_GUILD_ID` set means guild-scoped command registration (instant). Unset means global (up to an hour).

Verified working on this machine, milestone 0: Bun 1.3.14, oceanic.js 1.15.0, `@duckdb/node-api` 1.5.6-r.1, TypeScript 7.0.2, Biome 2.5.15. `@duckdb/node-api` returns JS `bigint` for `BIGINT` and accepts a multi-statement DDL script in one call; `Bun.sql` is present, so Postgres needs no extra dependency. Both findings have a runnable record in `scripts/spike/`. Paths in this file are relative to `src/`.

`MessageFlags.IS_COMPONENTS_V2` is `32768`. oceanic.js has no component builder classes, so factories in `discord/components/` return plain objects; that is not a style choice, it is the only option the library offers.

## Non-negotiables

Break one of these and the change is wrong, however well it works.

1. **Components V2 everywhere.** Every bot message is a Container tree with `MessageFlags.IS_COMPONENTS_V2`. No `content`, no `embeds` on those messages; the flag disables both and Discord will reject the payload. The two documented exceptions are the classic-embed verify panel and webhook-replayed restore messages (`D4PLAN.md` 9.5).
2. **Count the components.** 40 per message, total, including nested children. Call `page()` and let it assert. Never hand-assemble a container that could overflow.
3. **Snowflakes are strings until they hit the DB.** Never `Number(id)`. Never compare an id to a number. `bigint` exists only inside `db/`.
4. **Never `sleep()` to dodge rate limits.** Use `discord/ratelimit.ts`. It reads the headers; fixed sleeps are simultaneously too slow and too fast.
5. **Never invent an error message.** Parse the JSON body and show Discord's `code` and `message` verbatim. A code with no table entry is shown raw, not paraphrased. `D4PLAN.md` 18.1.
6. **All Discord API traffic goes through `discord/client.ts`.** Nothing else imports `fetch` against `discord.com` or `discordapp.com`. This is what makes the limiter, the error parser, and the redaction apply everywhere. One carve-out: read-only CDN downloads (`cdn.discordapp.com` for icons, emojis, stickers, attachments) go through `lib/http.ts` — a plain GET, timeout, no auth header. Everything else, including attachment re-upload during a restore, goes through the client.
7. **Nothing long runs in an interaction handler.** Enqueue a job, ack, edit the message from the job runner.
8. **Re-check authorisation and ownership on every interaction.** A button rendered for an admin last week must fail closed today.
9. **No user tokens, no selfbot code, no proxy rotation, no CAPTCHA service.** Not negotiable, not behind a flag.
10. **Tokens are encrypted at rest, always.** Exports never contain tokens. Logs never contain emails or IPs.

## Use every component that fits

The point of Components V2 is that a bot message can be a real interface. Reach for the right control instead of a list of text:

| Need | Use |
|---|---|
| pick one of a few options | String Select |
| pick several categories to restore | String Select with `maxValues` |
| pick a channel, role, user, mentionable | the matching Select (types 5-8). Never make someone paste an id |
| multi-line input, a label, a hex colour, a channel name to type | Modal with Label |
| toggle a set of related settings | Checkbox Group |
| pick exactly one of a few | Radio Group |
| upload an avatar, banner, or backup file | File Upload |
| a value the user must type to confirm something destructive | Modal, compared exactly |
| navigate, confirm, cancel, refresh, retry | Button |
| show a guild icon, a user avatar, a preview | Section with a Thumbnail accessory |
| show several images or a screenshot | Media Gallery |
| attach a file | File component |
| group and colour a block of information | Container with `accent_color` |
| divide sections | Separator |

Say what is happening in words as well as colour. Every coloured container also carries "done", "failed", "running", or "waiting".

## Consistency

- One status-to-colour map (`D4PLAN.md` 9.4). Do not introduce a sixth colour.
- One page builder (`page()`). Do not hand-roll layouts in a command handler.
- One component factory per component type in `discord/components/`. Factories return plain objects; the library has no builders.
- camelCase in TypeScript (`customID`, `maxValues`, `minValues`), snake_case only in raw payloads.
- Custom ids are `sb:<surface>:<guild>:<object>:<action>:<cursor>` (`D4PLAN.md` 9.3). Anything that will not fit goes into `interaction_state` behind a short random id with a 15-minute TTL. Never pack a selection payload into a customID.
- Every surface has the same shape: title, body, status line, controls, and a way back.
- Destructive actions always get their own page with a nonce on the confirm button and a 15-minute expiry.
- Errors always look the same: what happened, what Discord said, what to do.
- Empty state always says something ("no backups yet, run `/backup create`"). Never a blank page.
- Long lists paginate at a fixed size with the same control row everywhere: previous, page N of M, next, filter, export.

## Quality of life

- Every command replies ephemerally by default when the content is a private setting or a record. Public only for things meant to be seen (panels, progress on a shared job).
- Respect the guild's ephemeral preference from `/setup`.
- Every job message carries pause, cancel, and a live ETA once enough progress exists to compute one.
- Every failure message includes one actionable next step, and a button to run the fix where a fix is a command.
- Autocomplete on every option that names a backup, guild, job, user, or record. Never make someone copy an id.
- All timestamps render as Discord relative timestamps (`<t:...:R>`).
- Every destructive command supports `dry_run` where a dry run is meaningful, and `dry_run` defaults on.
- Long operations survive a restart. If a new feature cannot be resumed, say why in the code.
- Anything that touches the network has a timeout. No unbounded awaits.

## Code

- TypeScript strict, ESM, no `any` without a comment saying why.
- Small files, one job each. If a service file passes 400 lines, split it by responsibility.
- No abstractions for single call sites. Three similar lines beat a premature helper.
- Comments: lowercase, short, explain why not what. Match the surrounding density.
- No speculative config. A setting exists because someone asked for it, and it has a default.
- Imports sorted, no unused imports, no orphaned code from a change (dead code that predates the change gets mentioned, not deleted).
- SQL stays portable across DuckDB and Postgres (`D4PLAN.md` 5). No `SERIAL`, no engine-specific types, UUIDv7 string primary keys.
- Migrations are numbered, idempotent, and never edited after they ship.

## Errors

- `DiscordApiError` for anything Discord returns. Preserve `status`, `code`, `message`, `errors`, `retry_after`, `route`, `method`, `body`.
- `SB_`-prefixed codes for our own errors, each with one fixed message.
- Never catch and swallow. Either handle it or let it reach the handler wrapper.
- Log the route and method on every unexpected Discord error, so an unknown code is traceable.
- A log-channel failure never breaks the action that triggered it.

## Tests

- New behaviour gets a test. Bug fixes get a test that fails before the fix.
- Fixture guild generator is the source of truth for shapes. Change it only with a reason in the commit.
- Golden backup JSON is a contract. A diff in it must be explained in the commit message.
- Mock every Discord endpoint a change touches, and assert the exact request shape. camelCase/snake_case and bigint bugs live here.
- Round-trip test (`backup -> restore -> backup -> diff`) must stay green. Differences must be on the known-lossy list.

## Before you call it done

- [ ] `bun run check` clean (typecheck + lint + test)
- [ ] every new interactive component has a handler registered and the boot check passes
- [ ] no message exceeds 40 components
- [ ] no `Number(snowflake)`, no `setTimeout` for rate limits, no `console.log` left behind
- [ ] errors surfaced carry Discord's own words
- [ ] new command appears in `docs/commands.md`
- [ ] new setting appears in `.env.example` or `config/defaults.ts`, and in `/setup`
- [ ] `D4PLAN.md` updated if the design changed, with the `[?]` marker removed once the question is answered

## Commits

One working step per commit. Conventional prefix, lowercase, no em dashes in the message. Push to both remotes.

```
feat(backup): capture per-role icons
fix(restore): resolve channel parents by id before name
docs(setup): document the loopback IP failure
```
