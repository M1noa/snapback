# Contributing

How to set up, what the gate checks, and the conventions a change is expected to follow.

`AGENTS.md` is the law for how the code is written. This page is the short form of it, with the setup commands and the mechanics that are not in it.

## Getting set up

```sh
bun install
cp .env.example .env      # fill DISCORD_TOKEN and DISCORD_OWNER_ID
bun run dev               # the bot and the web server, one process
```

Bun 1.4.3 or newer. Snapback runs on Bun only, there is no Node fallback.

`bun run dev` starts `src/index.ts` in watch mode. `bun start` starts it without the watcher. `bun run build` bundles it into `dist/`.

Before you start the bot, read `docs/setup.md`. It is the operator guide, and it says what the wizard asks and why.

## The gate

```sh
bun run check
```

That is `typecheck && lint && test`, and it is the only thing that counts as passing. The three parts:

| Command | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over `src`, `tests`, and `scripts` |
| `bun run lint` | `biome check .` over `src`, `tests`, and `scripts` |
| `bun test` | the whole suite |

The typecheck is strict, and two of its settings are load-bearing. `noUncheckedIndexedAccess` means an array index is `T | undefined`, which is why the code checks before it uses. `erasableSyntaxOnly` means every construct has to be erasable, because Bun strips types rather than compiling them: no enums, no namespaces, no parameter properties.

CI runs the same command on both remotes, on Bun 1.4.3.

Run the narrow thing while you work and the whole gate before you commit:

```sh
bun test tests/services/backup    # one area
bun run check                      # the gate
```

## The house rules

The ten non-negotiables, in one place.

1. **Components V2 everywhere.** Every bot message is a Container tree with `MessageFlags.IS_COMPONENTS_V2`. No `content`, no `embeds`. The flag disables both, and Discord rejects the payload. The two exceptions are the classic-embed verify panel and the webhook-replayed restore messages.
2. **Count the components.** 40 per message, total, nested children included. Call `page()` and let it assert. Never hand-assemble a container that could overflow.
3. **Snowflakes are strings until they hit the database.** Never `Number(id)`, never compare an id to a number. `bigint` exists only inside `db/`.
4. **Never `sleep()` to dodge a rate limit.** Use `discord/ratelimit.ts`. It reads the headers. A fixed sleep is simultaneously too slow and too fast.
5. **Never invent an error message.** Parse the JSON body and show Discord's `code` and `message` verbatim. A code with no table entry is shown raw, not paraphrased.
6. **All Discord traffic goes through `discord/client.ts`.** Nothing else imports `fetch` against `discord.com`. oceanic.js is the gateway, not the REST client. One carve-out: read-only CDN downloads go through `lib/http.ts`.
7. **Nothing long runs in an interaction handler.** Enqueue a job, ack, edit the message from the job runner.
8. **Re-check authorisation and ownership on every interaction.** A button rendered for an admin last week must fail closed today.
9. **No user tokens, no selfbot code, no proxy rotation, no CAPTCHA service.**
10. **Tokens are encrypted at rest, always.** Exports never contain tokens. Logs never contain emails or IP addresses.

On top of those:

- One status-to-colour map. One page builder. One component factory per component type in `discord/components/`. The factories return plain objects, because oceanic.js has no builders.
- camelCase in TypeScript, snake_case only in a raw payload.
- Custom ids are `sb:<surface>:<guild>:<object>:<action>:<cursor>`. Anything that will not fit goes into `interaction_state` behind a short random id.
- Every error looks the same: what happened, what Discord said, what to do. An empty state always says something. Every failure message names one next step.
- TypeScript strict, ESM, no `any` without a comment saying why. Small files, one job each. No abstractions for single call sites. Comments are lowercase and short, and they explain why rather than what.
- No speculative config. A setting exists because someone asked for it, and it has a default.

A change that breaks one of these is wrong, however well it works.

## Tests

New behaviour gets a test. A bug fix gets a test that fails before the fix.

**The fixture guild generator is the source of truth for shapes.** `tests/fixtures/guild.ts` builds one guild with four roles, four channels, two threads, three members, five messages, and a ban. The capture tests drive those payloads instead of hand-built objects, so a shape change lands in one place. The ids in it are 19-digit strings above 2^53 on purpose: an accidental `Number()` in a capture module shows up as a wrong value there rather than silently in production.

**The golden file is a contract.** `tests/fixtures/golden-backup.json` is the committed output of the export serialiser, and `tests/services/export/json.test.ts` compares the bytes. A diff in it has to be explained in the commit message, because it means the shape of the backup changed. Regenerate it deliberately:

```sh
UPDATE_GOLDEN=1 bun test tests/services/export
```

**Biome is told to leave the golden file alone.** `biome.json` excludes `tests/fixtures/golden-backup.json`. The file is a byte contract against the serialiser, and a formatter is free to change whitespace. A formatting pass over it would be a diff with no meaning behind it, and it would fail the byte comparison.

**Mock every Discord endpoint a change touches, and assert the exact request shape.** camelCase against snake_case, and a `bigint` crossing the wire, both live there.

## Commits

One working step per commit. A conventional prefix, lowercase, no em dashes.

```
feat(backup): capture per-role icons
fix(restore): resolve channel parents by id before name
docs(setup): document the loopback IP failure
```

Push to both remotes after every change:

```sh
git push origin main    # GitLab
git push github main    # GitHub
```

| Remote | URL | Role |
|---|---|---|
| `origin` | `https://gitlab.com/M1noa/snapback.git` | primary |
| `github` | `https://github.com/M1noa/snapback.git` | backup |

The workspace rule is that GitLab is the primary origin over SSH, and GitHub is the backup over HTTPS with the `gh` credential helper. The clone in this checkout has both remotes on HTTPS; switch `origin` to SSH if you want the workspace rule to hold:

```sh
git remote set-url origin git@gitlab.com:M1noa/snapback.git
```

Push every branch to both, not only the default one. Fetch and prune before you force-push anything.

## Before you call it done

- [ ] `bun run check` clean
- [ ] every new interactive component has a handler, and the boot assertion passes
- [ ] no message over 40 components
- [ ] no `Number(snowflake)`, no `setTimeout` for a rate limit, no `console.log` left behind
- [ ] errors surfaced carry Discord's own words
- [ ] a new command appears in `docs/commands.md`, and `tests/docs/commands.test.ts` is green
- [ ] a new setting appears in `.env.example` or `config/defaults.ts`, and in the wizard step that owns it
- [ ] the guide in `docs/` that describes the change was updated in the same commit
- [ ] `D4PLAN.md` updated if the design changed, with the `[?]` marker removed once the question is answered
- [ ] the readme still carries the agentic-tools notice on line two, untouched

## Where to put a change

`docs/architecture.md` has the map: which layer owns which work, which file to open for a given question, and where the seams are. A change that crosses a seam, a new Discord call, or a new column in a captured table belongs in a place the map already points at, rather than in a new place of its own.
