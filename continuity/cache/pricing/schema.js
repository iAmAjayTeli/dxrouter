/**
 * The cache pricing record: what a valid one is, and what an invalid one becomes.
 *
 * Section 9.2 fixes the field list. This module turns a parsed file into either a
 * frozen record or a precise complaint, and it owns the one decision that matters most
 * for I3/I4: an unverifiable record does not become a lenient record. It becomes
 * `mechanism: none`, which means the provider is fully routable and contributes
 * exactly zero claimed cache economics.
 *
 * Two additions beyond the section 9.2 list, both about honesty:
 *
 *  - `verification_method` (`documentation` | `probe`). Everything shipped in this
 *    repository was read from a provider document, not measured here, and a record
 *    that cannot say which it was would let a documented ratio be reported later as a
 *    measured one. `documentation` records are usable, and cap every term they produce
 *    at `estimated`; only a `probe` record may back a `confirmed` arithmetic term.
 *  - `source`. A citation an operator can check. Section 9.2 wants pricing
 *    "traceable to a source"; `verified_by` names who, `source` names from what.
 *
 * Multipliers are also exposed in integer basis points (`*_bp`). No money is computed
 * in M2, but when it is, the arithmetic has to be integer micro-USD (no REAL anywhere,
 * because a float round-trip would make the decision hash irreproducible) and the
 * conversion belongs here rather than in whichever module first needs it.
 */

export const MECHANISMS = Object.freeze(["explicit", "implicit", "none"]);
export const VERIFICATION_METHODS = Object.freeze(["documentation", "probe"]);

/** Section 9.3 loader outcomes. `disabled` still yields a usable, zero-credit record. */
export const PRICING_STATUS = Object.freeze({ OK: "ok", STALE: "stale", DISABLED: "disabled" });

export const DISABLED_CAUSE = Object.freeze({
  /** `verified_at` or `verified_by` absent: nobody stands behind these numbers. */
  UNVERIFIED: "unverified",
  /** The file did not parse, or a field is out of contract. */
  MALFORMED: "malformed",
  /** No file for this provider at all. */
  MISSING: "missing",
});

/** Labels a decision carries when its cache model is not fully trustworthy. */
export const PRICING_LABELS = Object.freeze({
  UNAVAILABLE: "cache-model-unavailable",
  STALE: "cache-model-stale",
});

const REQUIRED = Object.freeze(["provider", "mechanism", "version"]);

const NUMERIC = Object.freeze([
  "min_cacheable_tokens",
  "ttl_default_s",
  "ttl_extended_s",
  "write_multiplier_default",
  "write_multiplier_extended",
  "read_multiplier",
]);

const BOOLEAN = Object.freeze(["reports_cache_read", "reports_cache_write"]);

/** Integer basis points, so later money math never needs a float. */
export function toBasisPoints(multiplier) {
  if (multiplier === null || multiplier === undefined) return null;
  const n = Number(multiplier);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10_000);
}

/** ISO date or datetime to epoch ms; null when unparseable, so callers can complain. */
export function parseVerifiedAt(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?Z?)?$/.test(text)) return null;
  const ms = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text.replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
}

function fail(detail, field) {
  return { ok: false, cause: DISABLED_CAUSE.MALFORMED, detail, field: field ?? null };
}

/**
 * Validate one parsed record.
 *
 * @returns {{ok: true, model: object} | {ok: false, cause: string, detail: string, field: string|null}}
 */
export function validateCacheModel(record, { provider: expected = null } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return fail("record must be a mapping of fields");
  }

  for (const key of REQUIRED) {
    if (record[key] === null || record[key] === undefined || record[key] === "") {
      return fail(`missing required field ${key}`, key);
    }
  }

  const provider = String(record.provider).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(provider)) return fail(`unsupported provider key ${record.provider}`, "provider");
  if (expected && provider !== expected) {
    // The filename is the key the loader looked up. A record claiming to be a different
    // provider is exactly the mix-up that would give one vendor another vendor ratios.
    return fail(`record says provider=${provider} but was loaded as ${expected}`, "provider");
  }

  const mechanism = String(record.mechanism).trim().toLowerCase();
  if (!MECHANISMS.includes(mechanism)) return fail(`mechanism must be one of ${MECHANISMS.join(", ")}`, "mechanism");

  const numbers = {};
  for (const key of NUMERIC) {
    const raw = record[key];
    if (raw === null || raw === undefined) {
      numbers[key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fail(`${key} must be a non-negative number`, key);
    numbers[key] = key.endsWith("_s") || key === "min_cacheable_tokens" ? Math.trunc(n) : n;
  }

  const booleans = {};
  for (const key of BOOLEAN) {
    const raw = record[key];
    if (raw === null || raw === undefined) {
      // Absent means "this record does not claim the provider reports it". Defaulting
      // to false understates rather than invents.
      booleans[key] = false;
      continue;
    }
    if (typeof raw !== "boolean") return fail(`${key} must be true or false`, key);
    booleans[key] = raw;
  }

  if (Array.isArray(record.breakpoints)) return fail("breakpoints must be an integer count, not a list", "breakpoints");
  let breakpoints = null;
  if (record.breakpoints !== null && record.breakpoints !== undefined) {
    const n = Number(record.breakpoints);
    if (!Number.isInteger(n) || n < 0) return fail("breakpoints must be a non-negative integer", "breakpoints");
    breakpoints = n;
  }

  // A mechanism that claims caching exists must be able to say for how long and at what
  // read cost. Half a model is not a model, and the safe degradation for half a model is
  // the same as for no model.
  if (mechanism !== "none") {
    if (!numbers.ttl_default_s) return fail(`mechanism ${mechanism} requires ttl_default_s`, "ttl_default_s");
    if (numbers.read_multiplier === null) {
      return fail(`mechanism ${mechanism} requires read_multiplier`, "read_multiplier");
    }
    if (numbers.write_multiplier_default === null) {
      return fail(`mechanism ${mechanism} requires write_multiplier_default`, "write_multiplier_default");
    }
    if (mechanism === "explicit" && breakpoints === null) {
      return fail("mechanism explicit requires breakpoints", "breakpoints");
    }
  }
  if ((numbers.ttl_extended_s === null) !== (numbers.write_multiplier_extended === null)) {
    return fail("ttl_extended_s and write_multiplier_extended must be given together", "ttl_extended_s");
  }

  const method = record.verification_method
    ? String(record.verification_method).trim().toLowerCase()
    : // Absent defaults to the weaker of the two: a documented ratio can never be
      // reported as a measured one by omission.
      VERIFICATION_METHODS[0];
  if (!VERIFICATION_METHODS.includes(method)) {
    return fail(`verification_method must be one of ${VERIFICATION_METHODS.join(", ")}`, "verification_method");
  }

  const verified_by = typeof record.verified_by === "string" && record.verified_by.trim() ? record.verified_by.trim() : null;
  const verified_at_raw = record.verified_at ?? null;
  const verified_at = parseVerifiedAt(verified_at_raw);
  if (verified_at_raw && verified_at === null) {
    return fail("verified_at must be an ISO-8601 date or datetime", "verified_at");
  }

  // Section 9.3: no `verified_at` / `verified_by` means the record is disabled, not that
  // it is read leniently. A `mechanism: none` record is exempt: it claims nothing, so
  // there is nothing to stand behind, and requiring metadata on it would turn the one
  // entry whose loss is a hard failure (`default`) into a routine one.
  if (mechanism !== "none" && (!verified_at || !verified_by)) {
    return {
      ok: false,
      cause: DISABLED_CAUSE.UNVERIFIED,
      detail: `missing ${!verified_at ? "verified_at" : "verified_by"}`,
      field: !verified_at ? "verified_at" : "verified_by",
    };
  }

  return {
    ok: true,
    model: Object.freeze({
      provider,
      mechanism,
      breakpoints,
      ...numbers,
      ...booleans,
      read_multiplier_bp: toBasisPoints(numbers.read_multiplier),
      write_multiplier_default_bp: toBasisPoints(numbers.write_multiplier_default),
      write_multiplier_extended_bp: toBasisPoints(numbers.write_multiplier_extended),
      verification_method: method,
      verified_at,
      verified_by,
      source: typeof record.source === "string" && record.source.trim() ? record.source.trim() : null,
      version: String(record.version).trim(),
      notes: typeof record.notes === "string" && record.notes.trim() ? record.notes.trim() : null,
    }),
  };
}

/**
 * The record a disabled or missing provider gets.
 *
 * Not an absence and not a throw: a real record whose mechanism is `none`, so every
 * downstream reader takes the same path it takes for a provider that genuinely has no
 * cache. I4 in one object.
 */
export function disabledCacheModel(provider, cause, detail = null) {
  return Object.freeze({
    provider: String(provider ?? "unknown").toLowerCase(),
    mechanism: "none",
    breakpoints: null,
    min_cacheable_tokens: null,
    ttl_default_s: null,
    ttl_extended_s: null,
    write_multiplier_default: null,
    write_multiplier_extended: null,
    read_multiplier: null,
    reports_cache_read: false,
    reports_cache_write: false,
    read_multiplier_bp: null,
    write_multiplier_default_bp: null,
    write_multiplier_extended_bp: null,
    verification_method: null,
    verified_at: null,
    verified_by: null,
    source: null,
    version: `disabled:${cause}`,
    notes: detail,
    disabled_cause: cause,
    disabled_detail: detail,
  });
}

/** True when this record may back a `confirmed` arithmetic term (a probe, not a doc). */
export function supportsConfirmedArithmetic(model) {
  return Boolean(model) && model.mechanism !== "none" && model.verification_method === "probe";
}

export default validateCacheModel;
