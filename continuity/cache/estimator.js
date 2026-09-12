/**
 * Which prefix layers a route could plausibly have cached, and how many tokens.
 *
 * This is the bridge from M1's prefix layers to M2's cache entries, and it is
 * deliberately conservative in both directions:
 *
 *  - A provider with no verified cache model produces an **empty** plan. Not a plan
 *    with zeroes in it, not a plan marked "probably fine": nothing to write, nothing to
 *    credit (I4).
 *  - Eligibility is measured against the **cumulative** prefix in layer order
 *    (tools → system → messages), because that is what a provider caches: a prefix, not
 *    a set of independent blocks. A 40-token tools block is cacheable when it sits in
 *    front of a 4000-token system prompt and the provider caches the prefix through it.
 *
 * Token counts come from the M1 summary with their provenance attached, and the
 * provenance travels into the entry. Every count M2 can produce today is `estimated`
 * (M1 ships no tokenizer), and a plan that quietly dropped that would let a
 * bytes-divided-by-four figure be read later as a measurement.
 *
 * Pure: no clock, no store, no I/O.
 */

import { PREFIX_LAYERS } from "../prefix/hasher.js";
import { TOKEN_PROVENANCE } from "../prefix/tokens.js";

/** Why a layer is not in the plan. Recorded, so "no plan" is never mysterious. */
export const INELIGIBLE = Object.freeze({
  NO_CACHE_MODEL: "no_cache_model",
  BELOW_MIN_CACHEABLE: "below_min_cacheable",
  NO_HASH: "no_hash",
  NO_BREAKPOINTS_LEFT: "no_breakpoints_left",
  EMPTY_LAYER: "empty_layer",
});

const hashOf = (summary, layer) => summary?.[`${layer}_hash`] ?? null;
const tokensOf = (summary, layer) => {
  const n = Number(summary?.[`${layer}_tokens`]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};
const provenanceOf = (summary, layer) => summary?.[`${layer}_tokens_provenance`] ?? TOKEN_PROVENANCE.UNAVAILABLE;

/**
 * @param {object} args
 * @param {object} args.model a cache pricing record (never null; `mechanism: none` is valid)
 * @param {object} args.layers an M1 `prefixLayerSummary()` object
 * @returns {{eligible: Array<object>, ineligible: Array<object>, cacheable_tokens: number, ttl_s: number|null}}
 */
export function planCacheWrites({ model, layers } = {}) {
  const mechanism = model?.mechanism ?? "none";
  const ttl_s = mechanism === "none" ? null : (model?.ttl_default_s ?? null);

  if (mechanism === "none" || !ttl_s) {
    const none = [];
    for (const layer of PREFIX_LAYERS) {
      if (hashOf(layers, layer)) none.push({ layer, reason: INELIGIBLE.NO_CACHE_MODEL, tokens: tokensOf(layers, layer) });
    }
    return Object.freeze({
      eligible: Object.freeze([]),
      ineligible: Object.freeze(none),
      cacheable_tokens: 0,
      ttl_s: null,
    });
  }

  const min = Number(model.min_cacheable_tokens) || 0;
  const maxBreakpoints = mechanism === "explicit" ? (model.breakpoints ?? PREFIX_LAYERS.length) : PREFIX_LAYERS.length;

  // Per-layer facts first, cumulative in layer order.
  let running = 0;
  const rows = PREFIX_LAYERS.map((layer) => {
    const tokens = tokensOf(layers, layer);
    running += tokens;
    return { layer, hash: hashOf(layers, layer), tokens, cumulative: running, provenance: provenanceOf(layers, layer) };
  });

  // Where the cached region ends: the last boundary whose cumulative prefix is long
  // enough for this provider to cache at all. Everything in front of that boundary is
  // *inside* the cached prefix, which is why a small `tools` layer is warm even though a
  // cache of `tools` alone would have been below the minimum. The alternative reading —
  // eligible only where the cumulative count first crosses the minimum — makes the two
  // leading layers permanently invisible, so a session whose tools and system hold
  // across an hour would be reported as having no warm prefix at all. That is not
  // conservatism, it is a wrong answer to the M2 question.
  let lastCacheable = -1;
  rows.forEach((row, i) => {
    if (row.hash && row.tokens > 0 && row.cumulative >= min) lastCacheable = i;
  });

  const eligible = [];
  const ineligible = [];
  rows.forEach((row, i) => {
    const shared = { layer: row.layer, tokens: row.tokens };
    if (!row.hash) {
      ineligible.push({ ...shared, reason: INELIGIBLE.NO_HASH });
      return;
    }
    if (row.tokens === 0) {
      ineligible.push({ ...shared, reason: INELIGIBLE.EMPTY_LAYER });
      return;
    }
    if (i > lastCacheable) {
      ineligible.push({ ...shared, reason: INELIGIBLE.BELOW_MIN_CACHEABLE, cumulative: row.cumulative, min });
      return;
    }
    if (eligible.length >= maxBreakpoints) {
      // The earliest boundaries are kept: they are the longest-lived prefixes, and a
      // provider that allows four breakpoints spends them best at the stable front.
      ineligible.push({ ...shared, reason: INELIGIBLE.NO_BREAKPOINTS_LEFT });
      return;
    }
    eligible.push({
      layer: row.layer,
      hash: row.hash,
      tokens: row.tokens,
      cumulative_tokens: row.cumulative,
      tokens_provenance: row.provenance,
      ttl_s,
    });
  });

  return Object.freeze({
    eligible: Object.freeze(eligible),
    ineligible: Object.freeze(ineligible),
    cacheable_tokens: eligible.reduce((sum, e) => sum + e.tokens, 0),
    ttl_s,
  });
}

export default planCacheWrites;
