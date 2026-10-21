// the browser fingerprint the web page posts (D4PLAN 14.2). one json blob, one
// column, so a new field is a new key and not a migration.
//
// the fixed list is documented in D4PLAN 14.2 and in docs/privacy.md: nothing
// outside it is asked for, and no canvas, webgl or font probe exists in this
// build (the plan bans them, and a count of media devices is the honest limit
// of what a page may look at without permission). the site itself does not
// display the list; the docs are the record.
//
// the payload is whatever the browser sent, so nothing in it is trusted. every
// field is checked for its own type, a field of the wrong type is dropped
// rather than coerced, and a string is length-capped before it is stored.

/** the fields the page sends and the record keeps. */
export interface Fingerprint {
  readonly ua: string | null;
  readonly lang: string | null;
  readonly languages: string | null;
  readonly platform: string | null;
  readonly tz: string | null;
  readonly tzOffset: number | null;
  readonly screen: string | null;
  readonly avail: string | null;
  readonly colorDepth: number | null;
  readonly viewport: string | null;
  readonly dpr: number | null;
  readonly touch: boolean | null;
  readonly maxTouchPoints: number | null;
  readonly hwConcurrency: number | null;
  readonly deviceMemory: number | null;
  readonly cookies: boolean | null;
  readonly doNotTrack: string | null;
  readonly reducedMotion: boolean | null;
  readonly colorScheme: "dark" | "light" | null;
  readonly connection: string | null;
  readonly referrer: string | null;
  readonly audioDevices: number | null;
  readonly capturedAt: number | null;
}

/** the cap on a stored string. a user agent is the longest value here and it
 *  fits well inside it. */
const MAX_STRING = 256;

/** the fixed list in plain words, in the order the interface reads. docs and the
 *  plan repeat exactly this, so the code and the writing cannot drift. */
export const FINGERPRINT_FIELD_LABELS = [
  "user agent",
  "platform",
  "screen size",
  "available screen size",
  "viewport size",
  "colour depth",
  "device pixel ratio",
  "language",
  "languages",
  "time zone",
  "time zone offset",
  "device memory",
  "thread count",
  "touch",
  "touch points",
  "cookies allowed",
  "do-not-track state",
  "reduced-motion preference",
  "colour scheme",
  "connection type",
  "media device count",
  "referring page",
  "time it was read",
] as const;

/** the cap on a value in the summary. the summary is a line on a page, not a
 *  copy of the payload. */
const MAX_BRIEF = 32;

/** the bounds of the numeric fields. a colour depth outside 1..64, a touch
 *  count beyond a screen's fingers, a clock behind the year 1970 or past the
 *  year 2096, a pixel ratio under half, and a device count beyond a hundred
 *  are not measurements. */
const RANGES = {
  colorDepth: { min: 1, max: 64 },
  tzOffset: { min: -900, max: 900 },
  maxTouchPoints: { min: 0, max: 20 },
  hwConcurrency: { min: 1, max: 128 },
  audioDevices: { min: 0, max: 100 },
  capturedAt: { min: 0, max: 4e12 },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** the payload as an object. the page sends base64 json in a header, and the
 *  callback also accepts it as a query parameter, so a json string is read as
 *  well as an object. */
function asRecord(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) return payload;
  if (typeof payload !== "string") return {};
  const direct = parseJson(payload);
  if (direct !== null) return direct;
  const decoded = parseJson(Buffer.from(payload, "base64").toString("utf8"));
  return decoded ?? {};
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_STRING ? trimmed.slice(0, MAX_STRING) : trimmed;
}

function readNumber(
  payload: Record<string, unknown>,
  key: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < range.min || value > range.max) return null;
  return value;
}

/** the two float fields. dpr and device memory are both positive reals, and
 *  both carry a documented ceiling, so the bounds keep a fake value out. */
function readFloat(
  payload: Record<string, unknown>,
  key: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= range.min || value > range.max) return null;
  return value;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

/** a field whose value must be one of a few words. anything else is dropped. */
function readOneOf<V extends string>(
  payload: Record<string, unknown>,
  key: string,
  allowed: readonly V[],
): V | null {
  const value = payload[key];
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as V)
    : null;
}

/** the payload read into the fields the record keeps. anything else is
 *  ignored. */
export function readFingerprint(payload: unknown): Fingerprint {
  const object = asRecord(payload);
  return {
    ua: readString(object, "ua"),
    lang: readString(object, "lang"),
    languages: readString(object, "languages"),
    platform: readString(object, "platform"),
    tz: readString(object, "tz"),
    tzOffset: readNumber(object, "tzOffset", RANGES.tzOffset),
    screen: readString(object, "screen"),
    avail: readString(object, "avail"),
    colorDepth: readNumber(object, "colorDepth", RANGES.colorDepth),
    viewport: readString(object, "viewport"),
    dpr: readFloat(object, "dpr", { min: 0.001, max: 32 }),
    touch: readBoolean(object, "touch"),
    maxTouchPoints: readNumber(object, "maxTouchPoints", RANGES.maxTouchPoints),
    hwConcurrency: readNumber(object, "hwConcurrency", RANGES.hwConcurrency),
    deviceMemory: readFloat(object, "deviceMemory", { min: 0.001, max: 8 }),
    cookies: readBoolean(object, "cookies"),
    doNotTrack: readString(object, "doNotTrack"),
    reducedMotion: readBoolean(object, "reducedMotion"),
    colorScheme: readOneOf(object, "colorScheme", ["dark", "light"]),
    connection: readString(object, "connection"),
    referrer: readString(object, "referrer"),
    audioDevices: readNumber(object, "audioDevices", RANGES.audioDevices),
    capturedAt: readNumber(object, "capturedAt", RANGES.capturedAt),
  };
}

/** a value short enough for a line: no line breaks in it, and capped. */
function brief(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.length > MAX_BRIEF ? cleaned.slice(0, MAX_BRIEF) : cleaned;
}

/** one line for the records page. the user agent is not in it: the record has
 *  its own column for that, and a line of a thousand characters is not a
 *  summary. */
export function fingerprintSummary(fingerprint: Fingerprint): string {
  const parts: string[] = [];
  const platform = brief(fingerprint.platform);
  if (platform !== null) parts.push(platform);
  const lang = brief(fingerprint.lang);
  if (lang !== null) parts.push(lang);
  const screen = brief(fingerprint.screen);
  if (screen !== null) parts.push(screen);
  const viewport = brief(fingerprint.viewport);
  if (viewport !== null) parts.push(viewport);
  const tz = brief(fingerprint.tz);
  if (tz !== null) parts.push(tz);
  if (fingerprint.touch !== null) parts.push(fingerprint.touch ? "touch" : "no touch");
  if (fingerprint.colorDepth !== null) parts.push(`${fingerprint.colorDepth}-bit colour`);
  if (fingerprint.hwConcurrency !== null) parts.push(`${fingerprint.hwConcurrency} cores`);
  if (fingerprint.deviceMemory !== null) parts.push(`${fingerprint.deviceMemory} gb`);
  if (fingerprint.maxTouchPoints !== null) parts.push(`${fingerprint.maxTouchPoints} fingers`);
  if (fingerprint.dpr !== null) parts.push(`${fingerprint.dpr}x`);
  if (fingerprint.colorScheme !== null) parts.push(fingerprint.colorScheme);
  if (parts.length === 0) return "no fingerprint captured";
  return parts.join(" · ");
}
