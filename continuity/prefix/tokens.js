/**
 * Per-layer token counts, and honesty about where they came from.
 *
 * The M1 rule is narrow and absolute: a count may not claim precision it does not
 * have. So every count carries a provenance word (section 4.1 CostProvenance uses
 * the same vocabulary for money):
 *
 *   measured     a real tokenizer for the target context produced this number
 *   estimated    the deterministic estimator below produced it
 *   unavailable  the layer is absent, or counting failed
 *
 * No tokenizer dependency is added for M1. None of the runtime dependencies in this
 * repo can tokenize for an arbitrary upstream model, and a wrong tokenizer is worse
 * than an admitted estimate, so the default path is `estimated` and says so. A
 * tokenizer can be injected (`{ tokenizer }`) which is how `measured` becomes
 * reachable; the live M1 path injects none.
 *
 * Estimator limitations, stated rather than hidden:
 *  - It divides canonical UTF-8 byte length by 4. That is roughly right for English
 *    prose and roughly wrong for CJK (too low), for base64 blobs (too high) and for
 *    dense punctuation.
 *  - It counts the JSON structure of the layer, not just its text, because the
 *    structure is part of what an upstream serializes and because doing so keeps the
 *    number a pure function of the canonical bytes.
 *  - It is therefore useful for detecting a *shrinking* prefix (compaction) and
 *    unsuitable for money. M1 does no cache economics, so that is enough.
 *
 * Pure: no clock, no environment, no state.
 */

import { canonicalBytes } from "../canonical/serialize.js";

export const TOKEN_PROVENANCE = Object.freeze({
  MEASURED: "measured",
  ESTIMATED: "estimated",
  UNAVAILABLE: "unavailable",
});

export const TOKEN_PROVENANCE_VALUES = Object.freeze([
  TOKEN_PROVENANCE.MEASURED,
  TOKEN_PROVENANCE.ESTIMATED,
  TOKEN_PROVENANCE.UNAVAILABLE,
]);

/** Bumped when the estimator changes, so stored counts stay interpretable. */
export const ESTIMATOR_VERSION = "canonical-bytes-div4-v1";

/** Bytes per estimated token. */
const BYTES_PER_TOKEN = 4;

/** True for the exact lowercase provenance strings above. */
export function isTokenProvenance(value) {
  return TOKEN_PROVENANCE_VALUES.includes(value);
}

/**
 * An integer, or `null` when there is no value — the one coercion the cache and evidence
 * paths are allowed to use for counts, timestamps and status codes.
 *
 * It lives here, beside `TOKEN_PROVENANCE`, because it is the same distinction: `null`
 * means `unavailable` and `0` means the provider measured a zero. The obvious one-liner
 * gets that wrong, since `Number(null)` is `0` and `0` is finite — so `null` in, `0` out,
 * and provider silence is persisted as a reported miss. `usage_provenance`, the
 * `provider_silent` evidence value and the whole §19.4 coverage measure (`usage_cache_read
 * IS NULL`) are computed from that difference, which makes the coercion an I4 concern
 * rather than a style one. Blanks, booleans and non-numeric values are absences too.
 */
export function intOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  // Booleans, arrays and objects are not counts. `Number([])` is 0, so accepting them
  // would reintroduce the fabricated zero from the other direction.
  return null;
}

/**
 * Deterministic estimate for a byte length. Integer, never negative.
 * @param {number} byteLength
 */
export function estimateTokensForBytes(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

/** An empty layer costs nothing; the JSON braces around nothing are not tokens. */
function isEmptyLayer(value) {
  if (value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** Deterministic estimate for a JSON-shaped value, via its canonical bytes. */
export function estimateTokens(value) {
  if (isEmptyLayer(value)) return 0;
  return estimateTokensForBytes(canonicalBytes(value).length);
}

function acceptMeasured(n) {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Count one prefix layer.
 *
 * @param {*} layer the layer value (tools array, system value, messages array), or
 *        null/undefined when the request has no such layer
 * @param {object} [opts]
 * @param {(value:*)=>number|null} [opts.tokenizer] returns a real token count, or
 *        null when it cannot count this value; may throw, which is treated as null
 * @returns {{tokens: number|null, provenance: string, estimator: string|null}}
 */
export function countLayerTokens(layer, { tokenizer = null } = {}) {
  if (layer === null || layer === undefined) {
    return { tokens: null, provenance: TOKEN_PROVENANCE.UNAVAILABLE, estimator: null };
  }

  if (typeof tokenizer === "function") {
    let measured = null;
    try {
      measured = tokenizer(layer);
    } catch {
      measured = null;
    }
    if (acceptMeasured(measured)) {
      return { tokens: measured, provenance: TOKEN_PROVENANCE.MEASURED, estimator: null };
    }
  }

  try {
    return {
      tokens: estimateTokens(layer),
      provenance: TOKEN_PROVENANCE.ESTIMATED,
      estimator: ESTIMATOR_VERSION,
    };
  } catch {
    // A layer that cannot be canonicalized cannot be counted, and inventing a
    // number here is exactly what the provenance vocabulary exists to prevent.
    return { tokens: null, provenance: TOKEN_PROVENANCE.UNAVAILABLE, estimator: null };
  }
}

export default countLayerTokens;
