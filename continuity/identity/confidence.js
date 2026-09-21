/**
 * IdentityConfidence — the mechanism that makes inference safe (section 4.2).
 *
 * The enum is fixed and exhaustive, persisted as the exact lowercase strings of
 * section 4.1. The ordering matters twice:
 *  - as confidence falls, the willingness of a later milestone to assert a cache
 *    asset falls with it (M1 asserts nothing, but it records the grade that M2 will
 *    read);
 *  - section 12.2 requires a turn that cannot take the session lock within its
 *    budget to proceed with confidence "degraded one step", which only means
 *    something if one step is defined in exactly one place. It is defined here.
 *
 * Pure.
 */

export const IDENTITY_CONFIDENCE = Object.freeze({
  EXPLICIT: "explicit",
  STRONGLY_INFERRED: "strongly_inferred",
  WEAKLY_INFERRED: "weakly_inferred",
  UNKNOWN: "unknown",
});

/** Strongest first. Degrading means moving one place to the right. */
export const IDENTITY_CONFIDENCE_ORDER = Object.freeze([
  IDENTITY_CONFIDENCE.EXPLICIT,
  IDENTITY_CONFIDENCE.STRONGLY_INFERRED,
  IDENTITY_CONFIDENCE.WEAKLY_INFERRED,
  IDENTITY_CONFIDENCE.UNKNOWN,
]);

/**
 * How the identity was established. Persisted alongside the confidence, because
 * "weakly_inferred" without a source is not auditable.
 */
export const IDENTITY_SOURCE = Object.freeze({
  /** X-DXR-Session (or an equivalent client session header). */
  HEADER: "header",
  /**
   * The messages layer proved a prefix extension. That proof is what makes this a
   * lineage, and it holds whether or not `tools`/`system` also held across the
   * boundary — front-layer hashes are observed state, not a lineage key.
   *
   * So this source appears at TWO confidence grades, and the pair is the thing to
   * read, never the grade alone:
   *
   *   (strongly_inferred, prefix_extension)  chain proven, all three layers continuous
   *   (weakly_inferred,   prefix_extension)  chain proven, front layer moved — the turn
   *                                          also carries `front-layer-transition` and
   *                                          the moved layers in `invalidated_layers`
   *
   * `weakly_inferred` is deliberately shared with the row below, which is a different
   * situation entirely (no chain proof at all). This field is what separates them: a
   * consumer that needs "is the lineage proven?" must read the source, because the
   * grade answers "did the cacheable prefix survive?" instead.
   */
  PREFIX_EXTENSION: "prefix_extension",
  /**
   * tools+system continuous, messages genuinely undecidable (section 4.2 weak row).
   *
   * The complement of the weak case above: the prefix is intact but the lineage is
   * assumed rather than measured. Reached only when the messages question could not be
   * asked — no recorded messages state, or a request with no messages layer — and the
   * front-layer precondition is retained here precisely because nothing else is left
   * to distinguish this turn from an unrelated conversation.
   */
  AMBIGUOUS_PREFIX: "ambiguous_prefix",
  /**
   * A fresh session opened because the predecessor looks client-compacted. Typed but
   * never produced in M1: lineage across a compaction is only knowable from an
   * explicit key, and in that case the identity source is the header. Inferring it
   * would be the approximate-similarity guess section 4 forbids.
   */
  COMPACTION_SUCCESSOR: "compaction_successor",
  /** No usable evidence: a new session, deliberately. */
  NEW: "new",
});

export const IDENTITY_SOURCE_VALUES = Object.freeze(Object.values(IDENTITY_SOURCE));

/**
 * Labels from section 4.1 DecisionLabel that M1 can legitimately raise. M1 produces
 * no Decision, so these ride on the turn record instead; the vocabulary is shared so
 * that when Decisions arrive the words do not have to change.
 */
export const M1_LABELS = Object.freeze({
  IDENTITY_DEGRADED_BY_LOCK: "identity-degraded-by-lock",
  // The strict prefix test failed only because the client moved its cache breakpoint
  // off the previously-final message; the boundary matched once that one bookkeeping
  // field was removed (prefix/bookkeeping.js). Raised on the turn that was softened,
  // so a continuation is never asserted without saying why the strict test said no.
  PREFIX_CACHE_BREAKPOINT_MOVED: "prefix-cache-breakpoint-moved",
  /**
   * The lineage was proven by the messages chain while `tools` and/or `system`
   * changed across the same boundary.
   *
   * Front-layer hashes are observed state, not a lineage key: a client that adds an
   * MCP tool mid-conversation has changed its cacheable prefix, not become a different
   * conversation. Before this label existed such a turn opened a NEW session, so the
   * front-layer change was recorded only as the existence of another session row and
   * `invalidated_layers` could never contain `tools` or `system`. The turn carrying
   * this label is the one that makes that transition observable, and it always carries
   * the changed layers in `invalidated_layers` beside it.
   */
  FRONT_LAYER_TRANSITION: "front-layer-transition",
  /**
   * More than one open lineage was plausible for this turn, so no lineage was claimed.
   *
   * Recorded rather than resolved: FALSE SPLIT beats FALSE CONTINUATION, and the
   * alternative — picking the most recent, or the closest in time — is the approximate
   * guess §4 forbids. A reader counting continuations must be able to see that this
   * turn was censored rather than genuinely new.
   */
  LINEAGE_AMBIGUOUS: "lineage-ambiguous",
});

export function isIdentityConfidence(value) {
  return IDENTITY_CONFIDENCE_ORDER.includes(value);
}

export function isIdentitySource(value) {
  return IDENTITY_SOURCE_VALUES.includes(value);
}

/** One step weaker. `unknown` is the floor and stays there. */
export function degradeConfidence(confidence) {
  const i = IDENTITY_CONFIDENCE_ORDER.indexOf(confidence);
  if (i === -1) return IDENTITY_CONFIDENCE.UNKNOWN;
  return IDENTITY_CONFIDENCE_ORDER[Math.min(i + 1, IDENTITY_CONFIDENCE_ORDER.length - 1)];
}

/** True when `a` is at least as strong as `b`. */
export function atLeastAsStrong(a, b) {
  const ia = IDENTITY_CONFIDENCE_ORDER.indexOf(a);
  const ib = IDENTITY_CONFIDENCE_ORDER.indexOf(b);
  if (ia === -1 || ib === -1) return false;
  return ia <= ib;
}

export default IDENTITY_CONFIDENCE;
