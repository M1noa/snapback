// the browser fingerprint the web page posts (D4PLAN 14.2). one json blob, one
// column, so a new field is a new key and not a migration.
//
// the payload is whatever the browser sent, so nothing in it is trusted. every
// field is checked for its own type, a field of the wrong type is dropped
// rather than coerced, and a string is length-capped before it is stored.

/** the fields the page sends and the record keeps. */
export interface Fingerprint {
  readonly ua: string | null;
  readonly lang: string | null;
  readonly tz: string | null;
  readonly screen: string | null;
  readonly colorDepth: number | null;
  readonly viewport: string | null;
  readonly touch: boolean | null;
  readonly platform: string | null;
  readonly cookies: boolean | null;
  readonly doNotTrack: string | null;
  readonly canvas: string | null;
  readonly webgl: string | null;
  readonly audio: string | null;
  readonly fonts: number | null;
  readonly battery: boolean | null;
}

/** the cap on a stored string. a user agent is the longest value here and it
 *  fits well inside it. */
const MAX_STRING = 256;

/** the cap on a value in the summary. the summary is a line on a page, not a
 *  copy of the payload. */
const MAX_BRIEF = 32;

/** the bounds of the two numeric fields. a colour depth outside 1..64 and a
 *  font count outside 0..1000 are not measurements. */
const COLOR_DEPTH_RANGE = { min: 1, max: 64 } as const;
const FONTS_RANGE = { min: 0, max: 1000 } as const;

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

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

/** the payload read into the fields the record keeps. anything else is
 *  ignored. */
export function readFingerprint(payload: unknown): Fingerprint {
  const object = asRecord(payload);
  return {
    ua: readString(object, "ua"),
    lang: readString(object, "lang"),
    tz: readString(object, "tz"),
    screen: readString(object, "screen"),
    colorDepth: readNumber(object, "colorDepth", COLOR_DEPTH_RANGE),
    viewport: readString(object, "viewport"),
    touch: readBoolean(object, "touch"),
    platform: readString(object, "platform"),
    cookies: readBoolean(object, "cookies"),
    doNotTrack: readString(object, "doNotTrack"),
    canvas: readString(object, "canvas"),
    webgl: readString(object, "webgl"),
    audio: readString(object, "audio"),
    fonts: readNumber(object, "fonts", FONTS_RANGE),
    battery: readBoolean(object, "battery"),
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
  if (fingerprint.fonts !== null) parts.push(`${fingerprint.fonts} fonts`);
  if (parts.length === 0) return "no fingerprint captured";
  return parts.join(" · ");
}
