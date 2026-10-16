// a tiny awaited delay. for pacing and jitter only: spacing retries apart,
// giving a UI a beat to update. never used to dodge a rate limit. AGENTS.md
// rule 4 sends every limiter decision through discord/ratelimit.ts, which reads
// the headers, because a fixed sleep is simultaneously too slow and too fast.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
