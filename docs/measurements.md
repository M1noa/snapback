# Measurements

Numbers, and where they came from. A number without its harness is a guess, so each one names the test that produced it.

| What | Measured | Harness |
|---|---|---|
| capture of 1,000 messages | 109 ms | `tests/services/backup/measure.test.ts`, against the fixture's mock |
| restore of 1,000 messages | 11 ms | the same test, against a client that accepts every webhook post |
| capture of 10,000 messages | the cap holds, the heap grows by a bounded amount | `tests/services/backup/load.test.ts` |
| attachment round trip | every attachment the capture keeps is one the restore re-posts, and the skips add up to the rest | `tests/services/backup/measure.test.ts`, half the urls dead |

The first two are a floor, not a promise. They measure the work against a mock, and the real thing waits on discord's rate limiter, which is the dominant cost. The restore posts one webhook message at a time per channel, and discord allows five webhook posts per two seconds in a channel, so a thousand messages take about seven minutes of waiting whatever the code does.

## The estimate the ui shows

`/restore start` says how long a restore of the chosen size takes, and it uses discord's documented webhook rate: five requests per two seconds per channel, so 2.5 messages a second. A thousand messages is about seven minutes, and ten thousand is about an hour.

That is the floor as well: a server with many channels posts them in parallel, so the wall clock is the slowest channel, not the total.

## The attachment rate

The attachment row is a harness, not a rate. It proves the two halves line up: the capture counts an attachment as kept exactly when the download worked, a dead url becomes a skip under the `attachments` category, and the restore posts one file part per kept attachment. What it cannot hold is how many urls are still alive on a real channel, because that depends on the channel's age and a mock has no age.

The real rate comes out of a live backup with no extra work: the newest backup's self-check lists every skip under `skipped` with a `category`, and each attachment the capture could not download arrives as one with `category: "attachments"`. Kept divided by kept plus those is the rate for that guild. `/backup info` already shows them. Until someone runs a real backup, no rate is quoted here.

That measurement found a defect worth its own line: the client json-encoded every body, so a `FormData` arrived as `{}` and no attachment was ever re-uploaded. `src/discord/client.ts` passes a `FormData` through untouched now, and `tests/discord/client.test.ts` asserts the boundary is left to `fetch`.

## What is not measured

- A restore against a real guild, with real rate limits and real attachments. The numbers above would need a real application to be honest, and nobody has run that.
- The attachment recovery rate on real channels, for the reason in the section above.
- The memory of a restore. The capture's memory is bounded by the page size, and the load test proves it. The restore holds one channel's messages at a time, and nothing has measured that.
