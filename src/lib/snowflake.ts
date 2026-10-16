// discord snowflakes. ids are 64-bit and exceed Number.MAX_SAFE_INTEGER, so
// every value here is a string in and a string out (AGENTS.md rule 3).
//
// bigint stays out of db/ here on purpose: extracting the timestamp needs a
// 22-bit right shift, and a Number cannot hold the low bits of a real id. this
// is the one shift outside db/, and the BigInt never leaves the function.

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

export function isSnowflake(id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  if (id.startsWith("0")) return false; // real ids never carry a leading zero
  if (id.length > 20) return false; // wider than the 64-bit field
  const value = BigInt(id);
  return value > 0n && value <= MAX_SNOWFLAKE;
}

export function snowflakeToDate(id: string): Date {
  if (!isSnowflake(id)) throw new Error(`not a snowflake: ${id}`);
  const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
  return new Date(Number(ms));
}

// a discord relative timestamp. seconds, not ms: <t:...:R> reads unix seconds.
export function formatRelative(id: string): string {
  const seconds = Math.floor(snowflakeToDate(id).getTime() / 1000);
  return `<t:${seconds}:R>`;
}

// sort without coercion: two ids that differ past 2^53 compare as equal under
// Number, which is exactly the bug AGENTS.md rule 3 is about.
export function compareSnowflakes(a: string, b: string): number {
  if (!isSnowflake(a)) throw new Error(`not a snowflake: ${a}`);
  if (!isSnowflake(b)) throw new Error(`not a snowflake: ${b}`);
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
