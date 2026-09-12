/**
 * Cache confidence — the four values, and the only legal ways to move between them.
 *
 * `CacheConfidence` (§4.1) is `confirmed | assumed | expired | unknown`, and the
 * whole point of the enum is that the four are *not* interchangeable:
 *
 *   confirmed — a provider reported a cache read or write for this prefix.
 *   assumed   — we sent a cacheable prefix to a provider whose mechanism is not
 *               `none`, and the provider said nothing. Plausible, never billed as
 *               fact (I3).
 *   expired   — a `written_at + ttl_s` window that has elapsed. Treated as cold.
 *   unknown   — no verified cache model for this provider. Contributes ZERO (I4);
 *               it is not "probably cold", it is "we have no basis".
 *
 * The functions below exist because the dangerous operation in this milestone is a
 * quiet promotion: some path summing `assumed` rows into a `confirmed` total, or an
 * `unknown` provider inheriting a neighbour's ratios. `raiseWithEvidence` is the only
 * way to reach `confirmed`, and it demands the evidence value that justifies it.
 *
 * No money and no decision lives here — this module is the vocabulary those later
 * layers must speak.
 */

/** §4.1, exhaustive and persisted as these exact strings. */
export const CACHE_CONFIDENCE = Object.freeze({
  CONFIRMED: "confirmed",
  ASSUMED: "assumed",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
});

export const CACHE_CONFIDENCES = Object.freeze([
  CACHE_CONFIDENCE.CONFIRMED,
  CACHE_CONFIDENCE.ASSUMED,
  CACHE_CONFIDENCE.EXPIRED,
  CACHE_CONFIDENCE.UNKNOWN,
]);

/**
 * Why a row says what it says. Persisted in `cache_entries.evidence`, which is what
 * makes an I3 audit possible after the fact rather than by reading code.
 */
export const CACHE_EVIDENCE = Object.freeze({
  /** Provider reported cache_read tokens for this route and prefix. */
  PROVIDER_REPORTED_READ: "provider_reported_read",
  /** Provider reported cache_write / cache_creation tokens. */
  PROVIDER_REPORTED_WRITE: "provider_reported_write",
  /** We sent a cacheable prefix; mechanism ≠ none; provider silent. */
  ASSUMED_WRITE: "assumed_write",
  /** Provider reported usage, and it contained no cache fields at all. */
  PROVIDER_SILENT: "provider_silent",
  /** No usable pricing record, so nothing may be claimed (I4). */
  NO_CACHE_MODEL: "no_cache_model",
  /**
   * The attempt never produced a response, so it is evidence about nothing.
   *
   * Distinct from `provider_silent`, and the distinction matters: a silent provider
   * answered and said nothing about its cache, which is a finding about that provider's
   * usage fields. A failed attempt did not answer, and filing it as silence would count
   * an outage as evidence that a provider does not report cache reads. Same string as
   * `NO_ENTRIES.ATTEMPT_FAILED`, deliberately — one vocabulary for one fact.
   */
  ATTEMPT_FAILED: "attempt_failed",
  /** The TTL window elapsed. */
  TTL_ELAPSED: "ttl_elapsed",
});

/** Evidence values a provider produced itself — the only ones that justify `confirmed`. */
export const PROVIDER_EVIDENCE = Object.freeze([
  CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
  CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE,
]);

/** Comparable strength, for "is this at least as good as" questions. Not a cost. */
const STRENGTH = Object.freeze({ confirmed: 3, assumed: 2, expired: 1, unknown: 0 });

export function isCacheConfidence(value) {
  return CACHE_CONFIDENCES.includes(value);
}

export function cacheStrength(confidence) {
  return STRENGTH[confidence] ?? 0;
}

/**
 * One step down, exactly as §4.2 uses it: an identity we are less sure of must not
 * spend a cache belief at full strength.
 *
 * `confirmed → assumed → unknown`. `expired` and `unknown` are already floors.
 */
export function degradeCacheConfidence(confidence) {
  if (confidence === CACHE_CONFIDENCE.CONFIRMED) return CACHE_CONFIDENCE.ASSUMED;
  if (confidence === CACHE_CONFIDENCE.ASSUMED) return CACHE_CONFIDENCE.UNKNOWN;
  return isCacheConfidence(confidence) ? confidence : CACHE_CONFIDENCE.UNKNOWN;
}

/**
 * The only route to `confirmed` (I3).
 *
 * @param {string} current existing confidence
 * @param {string} evidence a `CACHE_EVIDENCE` value
 * @returns {string} the new confidence
 * @throws {Error} when `confirmed` is asked for without provider evidence
 */
export function raiseWithEvidence(current, evidence) {
  if (PROVIDER_EVIDENCE.includes(evidence)) return CACHE_CONFIDENCE.CONFIRMED;
  if (evidence === CACHE_EVIDENCE.NO_CACHE_MODEL) return CACHE_CONFIDENCE.UNKNOWN;
  if (evidence === CACHE_EVIDENCE.TTL_ELAPSED) return CACHE_CONFIDENCE.EXPIRED;
  // An attempt that failed says nothing about the prefix, in either direction. It must not
  // raise a belief to `assumed` (the fall-through below would), and it must not demote one
  // a provider already confirmed.
  if (evidence === CACHE_EVIDENCE.ATTEMPT_FAILED) {
    return isCacheConfidence(current) ? current : CACHE_CONFIDENCE.UNKNOWN;
  }
  // Everything else is at best plausible. A row already `confirmed` is not demoted by
  // a later silent response: the provider did report a read once, and that happened.
  if (current === CACHE_CONFIDENCE.CONFIRMED) return CACHE_CONFIDENCE.CONFIRMED;
  return CACHE_CONFIDENCE.ASSUMED;
}

/**
 * Assertion used by the store and by tests: no write may claim `confirmed` unless the
 * row also carries provider evidence. Cheap, and it turns I3 from a rule people
 * remember into a rule the code refuses to break.
 */
export function assertConfidenceEvidence(confidence, evidence) {
  if (confidence !== CACHE_CONFIDENCE.CONFIRMED) return true;
  if (PROVIDER_EVIDENCE.includes(evidence)) return true;
  throw new Error(
    `[continuity][cache] confidence=confirmed requires provider evidence, got evidence=${evidence ?? "none"} (I3)`
  );
}

/** True when a belief may not be spent at all: no basis, or the window has gone. */
export function isColdOrUnusable(confidence) {
  return confidence === CACHE_CONFIDENCE.EXPIRED || confidence === CACHE_CONFIDENCE.UNKNOWN;
}

export default CACHE_CONFIDENCE;
