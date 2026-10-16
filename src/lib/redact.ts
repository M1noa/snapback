// the redaction layer (AGENTS.md rule 10, D4PLAN 6 and 16). pure functions, no
// io; lib/log.ts runs them before anything reaches a log line. a log never
// carries a token, an email, or a full ip.

const SECRET = "sk_***"; // D4PLAN 6: a token in a log line is replaced with sk_***
const EMAIL = "<email>";
const IP = "<ip>";

// a discord webhook url keeps its token in the path. redact that segment only;
// the host and the id are not secret.
const WEBHOOK =
  /(https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi;
// "Bot <token>" and "Bearer <token>". keep the scheme word, drop the value.
const AUTH = /\b(Bot|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
// a bot token: base64url id . base64url timestamp . base64url hmac.
const TOKEN = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}/g;
// generic key=value secrets, quotes preserved.
const KV =
  /(\b(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|client[_-]?secret|pepper|encryption[_-]?key)\b)(\s*[:=]\s*)(["']?)([^\s"',;]+)\3/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// full ipv4 only. a truncated 1.2.3.x has a non-digit last octet and survives
// on purpose (D4PLAN 14.5 keeps a truncated prefix for grouping).
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
// any colon run, validated below so a clock like 12:34:56 stays untouched.
const IPV6_CANDIDATE = /(?<![\w:])[0-9a-fA-F:]*:[0-9a-fA-F:]*(?![\w:])/g;

function isIpv6(token: string): boolean {
  const groups = token.split(":");
  if (groups.length > 8 && !token.includes("::")) return false;
  // an uncompressed address needs all eight groups; a bare "dead:beef" or a
  // time "12:34:56" does not, and must not be redacted.
  if (!token.includes("::") && groups.filter((group) => group !== "").length !== 8) return false;
  return groups.every((group) => /^[0-9a-fA-F]{0,4}$/.test(group));
}

export function redactText(text: string): string {
  return text
    .replace(WEBHOOK, `$1${SECRET}`)
    .replace(AUTH, `$1 ${SECRET}`)
    .replace(TOKEN, SECRET)
    .replace(KV, `$1$2$3${SECRET}$3`)
    .replace(EMAIL_RE, EMAIL)
    .replace(IPV4, IP)
    .replace(IPV6_CANDIDATE, (match) => (isIpv6(match) ? IP : match));
}

// walks a log payload. strings are redacted, arrays and plain objects recurse,
// an Error is reduced to its redacted message so the message is not lost.
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error) return redactText(value.message);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}
