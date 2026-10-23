# TODO

What is left on event tracking. Delete this file when the list is empty.

Done already: 19 gateway subscriptions, 42 event kinds, before/after field values,
source attribution, `/setup` tracking step, retention sweep in the scheduler,
timeline export for one person and one server.

## 1. `tracking_all` export

Whole-instance timeline. Her words: "export per user data and servers data and all data".

- [x] add the scope to `EXPORT_SCOPES` and to the export row
- [x] `all` needs no guild filter, so the query and the row cap change shape
- [x] allow it only for the bot owner, not for any guild admin
- [x] name the file `timeline-all.json`
- [x] test: scope resolves, owner gate refuses a guild admin

Verify: `bun run check`, then read the page copy.

## 2. timeline view inside discord

Today the timeline is a JSON attachment and nothing else. No paginated reader.

- [ ] `/tracking` command: pick server or person, page the events
- [ ] one row per event: when, kind, what changed, source
- [ ] filter by kind and by subject
- [ ] custom ids through `sb:tracking:*`, every one registered with a handler
- [ ] autocomplete for the subject

Verify: `bun run check`, boot check passes with no unregistered component.

## 3. cache-cold updates record nothing

`src/services/tracking/attach.ts:196` and `:269` return early when the event
carries no previous object. A `guildUpdate` or `channelUpdate` for anything not
in cache is dropped without a trace.

- [ ] write the row anyway, with `before_json` null and a `cache_miss` marker in `detail_json`
- [ ] do not guess what changed, just record that something did

Verify: unit test with a null before.

## 4. baseline for members already here

History starts at attach. A nickname set before the bot arrived is invisible
until it changes again.

- [ ] `member_baseline` kind, one row per member on first sight
- [ ] seed it from the guild member list after `tracking.attach`
- [ ] gate behind the history switch, same as every other member kind
- [ ] test: baseline row carries the current values, not a diff

Verify: `bun run check`.

## 5. docs

- [ ] `docs/commands.md`: `/tracking`, and the new export scopes
- [ ] `D4PLAN.md`: drop the `[?]` on anything this list answered
- [ ] `.env.example` if 4 adds a setting
