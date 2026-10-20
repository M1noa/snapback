# Measurements

Numbers, and where they came from. A number without its harness is a guess, so each one names the test that produced it.

| What | Measured | Harness |
|---|---|---|
| capture of 1,000 messages | 109 ms | `tests/services/backup/measure.test.ts`, against the fixture's mock |
| restore of 1,000 messages | 11 ms | the same test, against a client that accepts every webhook post |
| capture of 10,000 messages | the cap holds, the heap grows by a bounded amount | `tests/services/backup/load.test.ts` |

The first two are a floor, not a promise. They measure the work against a mock, and the real thing waits on discord's rate limiter, which is the dominant cost. The restore posts one webhook message at a time per channel, and discord allows five webhook posts per two seconds in a channel, so a thousand messages take about seven minutes of waiting whatever the code does.

## The estimate the ui shows

`/restore start` says how long a restore of the chosen size takes, and it uses discord's documented webhook rate: five requests per two seconds per channel, so 2.5 messages a second. A thousand messages is about seven minutes, and ten thousand is about an hour.

That is the floor as well: a server with many channels posts them in parallel, so the wall clock is the slowest channel, not the total.

## What is not measured

- A restore against a real guild, with real rate limits and real attachments. The numbers above would need a real application to be honest, and nobody has run that.
- The attachment recovery rate on a real channel. The capture stores an attachment's url and its path, and downloads it when it is under `MAX_ASSET_BYTES`; the rate of recovery on real channels depends on how old the messages are, because a signed url expires.
- The memory of a restore. The capture's memory is bounded by the page size, and the load test proves it. The restore holds one channel's messages at a time, and nothing has measured that.
