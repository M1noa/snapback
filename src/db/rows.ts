// db/rows.ts
// the one boundary between driver types and app types. duckdb hands back js
// bigint for every bigint column; the app holds ids and bitfields as strings
// and counts and sizes as numbers. every conversion lives here so there is a
// single place to look when a value comes back wrong.
//
// no reflection, no deep walk: each converter does one column, explicitly.

import type { SelfCheck, Skip } from "./types.ts";

/** the shapes a driver can hand back for one column. */
export type SqlValue = string | number | bigint | boolean | Date | null | undefined;

type Maybe<T> = T | null | undefined;

// our own row-boundary errors. one code, one fixed message (AGENTS.md errors).
export type RowErrorCode =
  | "SB_ROW_EXPECTED_STRING"
  | "SB_ROW_EXPECTED_BOOLEAN"
  | "SB_ROW_EXPECTED_NUMBER"
  | "SB_ROW_BAD_JSON";

const ROW_MESSAGES: Record<RowErrorCode, string> = {
  SB_ROW_EXPECTED_STRING: "a string column held a value that is not a string",
  SB_ROW_EXPECTED_BOOLEAN: "a boolean column held a value that is not a boolean",
  SB_ROW_EXPECTED_NUMBER: "a number column held a value that is not a number",
  SB_ROW_BAD_JSON: "a json column did not hold valid json",
};

export class RowError extends Error {
  readonly code: RowErrorCode;
  constructor(code: RowErrorCode) {
    super(`${code}: ${ROW_MESSAGES[code]}`);
    this.name = "RowError";
    this.code = code;
  }
}

// a 64-bit column (a snowflake id or a permission bitfield) reads back as js
// bigint from duckdb, or a string from a driver that widened it already. the
// app holds both as string. a js number is refused: Number(snowflake) is lossy
// above 2^53, which is the exact bug the string boundary exists to stop.
export function toId(value: SqlValue): Maybe<string> {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  throw new RowError("SB_ROW_EXPECTED_STRING");
}

// a varchar column: names, urls, and the iso-8601 timestamps the schema stores.
// a string passes through untouched. anything else is a column-type mistake, so
// it fails loud rather than stringifying a number.
export function toText(value: SqlValue): Maybe<string> {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  throw new RowError("SB_ROW_EXPECTED_STRING");
}

// a boolean column. duckdb returns true/false; a widened column may return 0/1.
// both are accepted; anything else is a mistake.
export function toBool(value: SqlValue): Maybe<boolean> {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new RowError("SB_ROW_EXPECTED_BOOLEAN");
}

// a count or byte-size column. bigint is duckdb's type for BIGINT; the app
// holds these as numbers. a bigint past the safe range would round silently, so
// it fails loud instead.
export function toNumber(value: SqlValue): Maybe<number> {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RowError("SB_ROW_EXPECTED_NUMBER");
    }
    return Number(value);
  }
  throw new RowError("SB_ROW_EXPECTED_NUMBER");
}

// the write direction for a bigint column: the app holds the id or bitfield as
// a string, the driver wants a bigint. a js number is refused here too, so a
// coerced snowflake cannot sneak in on the way down.
export function toBigInt(value: SqlValue): Maybe<bigint> {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return BigInt(value);
  throw new RowError("SB_ROW_EXPECTED_STRING");
}

// a json column holds json text. the app wants the parsed value.
export function parseJson<T>(value: SqlValue): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new RowError("SB_ROW_BAD_JSON");
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new RowError("SB_ROW_BAD_JSON");
  }
}

// the write direction for a json column: nullish stays null, everything else
// becomes json text.
export function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

// a self_check_json column: a backup's own validation result (D4PLAN 11.6). null
// stays null, meaning the backup is still open. the shape is rebuilt rather than
// trusted, so a hand-edited blob cannot hand back a missing failures array.
export function toSelfCheck(value: SqlValue): Maybe<SelfCheck> {
  if (value === null || value === undefined) return value;
  const parsed = parseJson<SelfCheck>(value);
  if (parsed === null) return null;
  return {
    ok: parsed.ok === true,
    failures: Array.isArray(parsed.failures) ? parsed.failures.filter(isText) : [],
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter(isSkip) : [],
  };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isSkip(value: unknown): value is Skip {
  if (value === null || typeof value !== "object") return false;
  const skip = value as Partial<Skip>;
  return isText(skip.category) && isText(skip.what) && isText(skip.why);
}
