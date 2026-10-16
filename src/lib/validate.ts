// input validation for values that arrive from a user, not from us. a number
// from a modal is a string from the wire and is clamped inside the documented
// range before it is stored (D4PLAN 6: a limit enforced only by documentation is
// not a limit). pure functions, no io.

export interface Range {
  readonly min: number;
  readonly max: number;
}

/** clamps to [min, max]. a non-finite, empty, or unparseable value returns null,
 *  so the caller decides between "keep the old value" and "reject the save". an
 *  empty modal field is not zero: Number("") is 0, which would quietly become the
 *  minimum instead of a missing answer. */
export function clampInt(value: unknown, range: Range): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const floored = Math.trunc(parsed);
  if (floored < range.min) return range.min;
  if (floored > range.max) return range.max;
  return floored;
}

const HEX = /^#?([0-9a-f]{6})$/i;

/** "#AABBCC", "aabbcc", and "0xAABBCC" all normalise to "#aabbcc". null on
 *  anything else, so a colour is never stored in a shape discord rejects. */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^0x/i, "");
  const match = HEX.exec(trimmed);
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

/** the stored form of a hex colour is the "#rrggbb" string; the wire wants the
 *  integer, and only this function crosses between them. */
export function hexToInt(hex: string): number {
  const normalised = normaliseHex(hex);
  if (normalised === null) throw new Error(`bad hex colour ${JSON.stringify(hex)}`);
  return Number.parseInt(normalised.slice(1), 16);
}

/** one of a fixed set, or null. used for the enums a modal can carry. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** trims and bounds a user-typed string. returns null when nothing is left, so
 *  an empty input is a missing value rather than a stored empty string. */
export function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** a snowflake as it arrives from a select menu or a mention. stays a string,
 *  always (AGENTS.md rule 3). */
export function snowflake(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{5,20}$/.test(trimmed) ? trimmed : null;
}
