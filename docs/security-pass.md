# Security pass

One row per adversary in `D4PLAN.md` 19.1, with where the mitigation lives. A row without evidence is not a mitigation, it is a hope, so each line names a file and, where there is one, the test that proves it.

| Adversary | Goal | Mitigation | Evidence |
|---|---|---|---|
| A stranger on the internet | hit `/callback` with a fake `code` and write junk records | the state is 32 random bytes, bound to the guild, the address and an expiry, and it is spent before the exchange, so a replayed callback finds nothing | `src/services/verify/oauth.ts`; `tests/services/verify/oauth.test.ts` ("no such state", "the state expired", "the client ip does not match") |
| A stranger | spoof a client address through `X-Forwarded-For` | the header is walked from the right, skipping the proxies we trust, and every candidate is checked with `net.isIP` before it is believed; behind a tunnel only `CF-Connecting-IP` counts | `src/web/capture/ip.ts`; `tests/web/capture/ip.test.ts` ("in cloudflare mode the tunnel's header wins", "a candidate that is not an address is discarded") |
| A guild admin with reduced flags | read records they are not permitted to | the admin row carries a grant per capability, and the surface says which one it needs: reading the records is not the same grant as running a backup | `src/discord/access.ts`; `tests/discord/access.test.ts` ("reading the records needs can_view_records") |
| A demoted admin with a stale button | drive a wizard they no longer run | the router re-checks access on every interaction, against the row in the database rather than against the interaction that minted the control | `src/discord/interactions/router.ts`, `src/discord/interactions/handlers.ts`; `tests/setup/handlers.test.ts` |
| Anyone with filesystem access | read tokens | the tokens are encrypted with AES-256-GCM under a key that lives in the environment, never in the database | `src/services/verify/token-store.ts`; `tests/services/verify/token-store.test.ts` |
| Anyone with a backup export | read tokens | the serialiser has nothing to redact, because a backup row and its children hold ids, names, urls and bitfield strings and no token at all | `src/services/export/json.ts`; `docs/backup-format.md` |
| A leaked log channel | read emails and addresses | the logger redacts before anything is written, and the capture never puts an address in a log field | `src/lib/log.ts`, `src/lib/redact.ts`; `tests/lib/` |
| The operator's own database backup | read tokens | the key is outside the database, so restoring the database alone does not expose a token | `src/services/verify/token-store.ts` (the key comes from `env.privacy.encryptionKey`) |
| Someone who guesses the export path | download exports | the web layer serves three routes and four static files, and none of them is an export; the files are read from disk by the operator | `src/web/router.ts`, `src/web/assets.ts` (an allowlist of four paths, never a join); `src/services/export/job.ts` |
| A site that frames the verification page | harvest a person's clicks (`clickjacking`) | every response carries `X-Frame-Options: DENY` with `frame-ancestors 'none'`, plus a content security policy that allows exactly one inline script by hash and no forms, so a foreign page cannot frame the flow or run code in it | `src/web/server.ts` (`BASE_HEADERS`), `src/web/capture/fingerprint-script.ts` (`WEB_CSP`); `tests/web/server.test.ts` ("every response carries the security headers") |

## What the pass found

The capability check was the one gap. Every surface asked only "is this person a row in `guild_admins`", so a row with `can_backup` and nothing else could read the records. The check is now per capability (`src/discord/access.ts`), and the boot asks for the capability its surface needs.

## What this pass does not cover

- A live application. Every row here is proved by a test against the real code, not against a real Discord application, so the behaviour under discord's own refusals is untested.
- The database encryption at rest. The tokens in the database are encrypted with a key from the environment, but the database itself is not encrypted, so a row's other fields are readable to anyone with the file. That is the operator's own file, and the plan puts it in their hands.
- The `X-Forwarded-For` walk trusts the configured depth. An operator who sets a depth larger than their real proxy chain hands the client address to whoever sends the header. The default is zero, which is right for a direct connection and wrong behind a proxy the operator forgot to configure.
