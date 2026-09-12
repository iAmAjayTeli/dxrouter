/**
 * Unconditional secret redaction.
 *
 * Every diagnostic writer (request logs, observability records, error payloads)
 * routes through `redactSecrets`. There is deliberately no "disable" flag: M0
 * requires authorization headers, API keys and cookies to be redacted
 * unconditionally, so the only knob is *whether* a diagnostic is written at all.
 */

export const REDACTED = "[REDACTED]";

/** Keys whose value is dropped entirely, matched case-insensitively as substrings. */
const SECRET_KEY_PATTERNS = [
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "cookie",
  "set-cookie",
  "api-key",
  "apikey",
  "api_key",
  "x-goog-api-key",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "session_token",
  "sessiontoken",
  "client_secret",
  "clientsecret",
  "private_key",
  "privatekey",
  "secret",
  "password",
  "passwd",
  "credential",
  "bearer",
  "jwt",
  "signature",
  "token",
];

/**
 * Value-shaped secrets that can appear in free text (a bearer token pasted into
 * a message, an upstream error echoing the key back). Conservative on purpose:
 * only patterns with an unmistakable prefix or structure.
 */
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]{12,}=*/gi,
  /\bsk-[A-Za-z0-9\-_]{16,}/g,
  /\bsk-ant-[A-Za-z0-9\-_]{16,}/g,
  /\bAIza[0-9A-Za-z\-_]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bya29\.[A-Za-z0-9\-._~+/]{20,}/g,
  /\bey[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/g,
  /\bdxr1:[A-Za-z0-9+/=:]{24,}/g,
];

/**
 * Token *counts* (`tokens`, `prompt_tokens`, `cacheReadInputTokens`,
 * `token_count`) match the `token` key pattern but carry no secret. Redacting
 * them would strip usage metrics out of every diagnostic while protecting
 * nothing, so a key whose ONLY trigger is `token` and whose shape is a count is
 * exempted. Singular `token` / `accessToken` / `x-…-token` keys stay secret, and
 * value-shaped scrubbing still applies to whatever an exempt key holds.
 */
const TOKEN_COUNT_KEY = /(tokens|token_?count)$/;

/**
 * Credential-bearing URL query parameters.
 *
 * Deliberately wider than `isSecretKey`: a bare `key` is not secret as an object
 * property (`kv.key`, `keyboard`, `keyCount`) but as a URL parameter it is
 * exactly how Google's APIs accept an API key, and `code` is an OAuth
 * authorization code. Scoping the wider list to query strings keeps object
 * redaction from swallowing ordinary fields.
 */
const SECRET_QUERY_PARAMS = new Set([
  "key",
  "auth",
  "token",
  "code",
  "sig",
  "signature",
  "password",
  "pwd",
]);

/**
 * The same idea for URLs that appear inside free text (an upstream error echoing
 * the request URL, a log line). Captures the `name=` prefix so the parameter name
 * survives and only its value is replaced.
 */
const SECRET_QUERY_PATTERN =
  /([?&](?:key|auth|token|code|sig|signature|password|pwd|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret)=)[^&#\s"']+/gi;

/** True when a URL query parameter carries credential material. */
export function isSecretQueryParam(name) {
  if (typeof name !== "string") return false;
  return SECRET_QUERY_PARAMS.has(name.toLowerCase()) || isSecretKey(name);
}

/** True when a property name looks like it carries secret material. */
export function isSecretKey(key) {
  if (typeof key !== "string") return false;
  const k = key.toLowerCase();
  const matched = SECRET_KEY_PATTERNS.filter((p) => k.includes(p));
  if (matched.length === 0) return false;
  if (matched.length === 1 && matched[0] === "token" && TOKEN_COUNT_KEY.test(k)) return false;
  return true;
}

/** Redact secret-shaped substrings inside a free-text value. */
export function redactString(str) {
  if (typeof str !== "string" || str.length === 0) return str;
  let out = str.replace(SECRET_QUERY_PATTERN, (_m, prefix) => prefix + REDACTED);
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

const MAX_DEPTH = 12;

/**
 * Deep-copy `value` with every secret-looking key neutralised and every
 * secret-shaped string value scrubbed.
 *
 * `drop: true` omits secret keys entirely instead of replacing their value with
 * `REDACTED`. Persisted diagnostics use `drop` — a record that never carries the
 * key at all cannot leak it through a later re-serialisation, and the dashboard
 * has no reason to show that a header was present. Transient logs use the
 * default so an operator can still see *which* header was set.
 *
 * Safe against cycles, Maps/Sets, Buffers, Errors and getters that throw.
 * Never mutates the input.
 */
export function redactSecrets(value, { depth = 0, seen = new WeakSet(), drop = false } = {}) {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === "string") return redactString(value);
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return undefined;

  if (depth >= MAX_DEPTH) return "[TRUNCATED_DEPTH]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ""),
      code: value.code,
    };
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[Buffer ${value.length}]`;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactUrl(value.toString());

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, { depth: depth + 1, seen, drop }));
  }

  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) {
      const key = String(k);
      if (isSecretKey(key)) {
        if (!drop) out[key] = REDACTED;
        continue;
      }
      out[key] = redactSecrets(v, { depth: depth + 1, seen, drop });
    }
    return out;
  }

  if (value instanceof Set) {
    return [...value].map((v) => redactSecrets(v, { depth: depth + 1, seen, drop }));
  }

  // Headers / URLSearchParams and anything else iterable as entries()
  if (typeof value.entries === "function" && typeof value.forEach === "function" && !("length" in value)) {
    const out = {};
    try {
      for (const [k, v] of value.entries()) {
        const key = String(k);
        if (isSecretKey(key)) {
          if (!drop) out[key] = REDACTED;
          continue;
        }
        out[key] = redactSecrets(v, { depth: depth + 1, seen, drop });
      }
      return out;
    } catch {
      /* fall through to plain-object handling */
    }
  }

  const out = {};
  for (const key of Object.keys(value)) {
    if (isSecretKey(key)) {
      if (!drop) out[key] = REDACTED;
      continue;
    }
    let raw;
    try {
      raw = value[key];
    } catch {
      out[key] = "[UNREADABLE]";
      continue;
    }
    const red = redactSecrets(raw, { depth: depth + 1, seen, drop });
    if (red !== undefined) out[key] = red;
  }
  return out;
}

/** Strip credential-bearing query parameters from a URL string. */
export function redactUrl(url) {
  if (typeof url !== "string" || url.length === 0) return url;
  try {
    const u = new URL(url);
    let touched = false;
    for (const key of [...u.searchParams.keys()]) {
      if (isSecretQueryParam(key)) {
        u.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    // `searchParams.set` percent-encodes the marker; decode just that one token
    // back so a redacted URL still reads as a URL in a diagnostic.
    const swept = touched ? u.toString().replace(/%5BREDACTED%5D/g, REDACTED) : url;
    // A credential can also sit in a path segment or a fragment, and a parameter
    // name we do not know can still hold a recognisable token, so the
    // value-shaped scrub always runs afterwards.
    return redactString(swept);
  } catch {
    return redactString(url);
  }
}

/**
 * Convenience wrapper for header bags of any shape.
 * @param {*} headers
 * @param {{drop?: boolean}} [opts] `drop` omits secret headers instead of masking
 */
export function redactHeaders(headers, opts = {}) {
  if (!headers) return {};
  const redacted = redactSecrets(headers, opts);
  return redacted && typeof redacted === "object" ? redacted : {};
}

export default redactSecrets;
