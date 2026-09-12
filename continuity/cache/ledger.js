/**
 * The CacheLedger — what we currently believe about a route's cache, and how strongly.
 *
 * This is the module the M2 goal names: given a session's prefix layers (from M1) and a
 * candidate route, it answers "is that material warm, on what evidence, and how much of
 * it" without deciding anything and without pricing anything.
 *
 * Three rules are structural here rather than remembered:
 *
 *  1. **The warm region is a prefix, not a set.** A provider serves a cache read for a
 *     matching *prefix*; a warm `messages` layer behind a changed `system` layer is
 *     worth nothing. So the ledger walks tools → system → messages and stops at the
 *     first layer that is not usable. `warm_prefix` is that run, and everything behind
 *     it is reported cold with a reason.
 *  2. **Tokens are reported per confidence class.** `confirmed_tokens` and
 *     `assumed_tokens` are separate numbers. A merged total exists for convenience but
 *     carries `warm_tokens_provenance`, which is `confirmed` only when every layer in
 *     the warm prefix was provider-reported (I3).
 *  3. **Invalidation is read-side.** §9.1 says a changed layer invalidates everything
 *     behind it. It does *not* say the rows are deleted: the old prefix may still be
 *     live upstream, and a later turn may return to it. So `applyInvalidation` masks a
 *     belief for this turn and leaves the store alone.
 *  4. **A layer can be *partly* warm, and only M1 may say so.** A `messages` layer that
 *     grew has a different hash, but the bytes the provider cached last turn are still a
 *     prefix of what we are about to send, and the provider will still read them back.
 *     Scoring that layer fully cold under-predicts every growing conversation, which is
 *     most of them. So a caller may pass `carried`: the earlier hash for a layer that
 *     M1's `classifyMessageSequences` has already judged to be an extension. The ledger
 *     believes the *stored* entry for that earlier hash and nothing more — the caller
 *     supplies a hash, never a token count — and marks the layer `partial`, because a
 *     partly warm layer cannot have a warm layer behind it.
 *
 * Pure: entries in, belief out. `now` is a parameter, the store is somebody else's job.
 */

import { PREFIX_LAYERS } from "../prefix/hasher.js";
import { CACHE_CONFIDENCE, CACHE_EVIDENCE, isColdOrUnusable } from "./confidence.js";
import { cacheEntryKey, createCacheEntry, entryState } from "./entry.js";
import { planCacheWrites } from "./estimator.js";
import { DEFAULT_CACHE_POLICY } from "./policy.js";
import { PRICING_STATUS } from "./pricing/schema.js";

/** Why a layer contributes nothing this turn. */
export const COLD_REASON = Object.freeze({
  NO_ENTRY: "no_entry",
  HASH_MISMATCH: "hash_mismatch",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
  INVALIDATED: "invalidated",
  BEHIND_COLD_LAYER: "behind_cold_layer",
  NO_CACHE_MODEL: "no_cache_model",
  CARRIED_GONE: "carried_gone",
});

/**
 * Index a set of `cache_entries` rows for lookup.
 *
 * Accepts raw database rows or frozen entries; both go through `createCacheEntry`, so a
 * row that would violate the entry contract (a `confirmed` row with no provider
 * evidence, say) fails loudly at read time instead of being believed.
 */
export function indexEntries(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row) continue;
    const entry = createCacheEntry(row);
    map.set(cacheEntryKey(entry), entry);
  }
  return map;
}

/**
 * @param {object} args
 * @param {Iterable<object>} [args.entries] `cache_entries` rows for the routes of interest
 * @param {object} args.registry a pricing registry (`get`, `statusOf`, `labelsFor`)
 * @param {number} args.now epoch ms
 * @param {object} [args.policy]
 */
export function createCacheLedger({ entries = [], registry, now = 0, policy = DEFAULT_CACHE_POLICY } = {}) {
  if (!registry || typeof registry.get !== "function") {
    throw new Error("[continuity][ledger] a pricing registry is required; cache belief without a cache model is I4");
  }
  const index = entries instanceof Map ? entries : indexEntries(entries);

  /**
   * One layer's belief, before the prefix walk.
   *
   * `carriedHash` is the fallback: an earlier prefix for this same layer that M1 has
   * judged the current one to extend. It is consulted only when the current hash has no
   * usable entry, and a hit is reported as `partial` — the warm region is that earlier
   * prefix, and the tokens are the ones the *stored entry* recorded, never a count the
   * caller supplied. That is what keeps a partial hit an observation rather than an
   * arithmetic guess (I3).
   */
  function layerBelief(provider, model, layer, hash, carriedHash = null) {
    if (!hash) return { layer, hash: null, warm: false, reason: COLD_REASON.NO_ENTRY, tokens: 0 };
    const exact = index.get(cacheEntryKey({ provider, model, prefix_hash: hash, layer }));
    const carried = carriedHash && carriedHash !== hash
      ? index.get(cacheEntryKey({ provider, model, prefix_hash: carriedHash, layer }))
      : null;
    const entry = exact ?? carried ?? null;
    if (!entry) {
      return {
        layer,
        hash,
        warm: false,
        reason: carriedHash && carriedHash !== hash ? COLD_REASON.CARRIED_GONE : COLD_REASON.NO_ENTRY,
        tokens: 0,
        carried_hash: carriedHash && carriedHash !== hash ? carriedHash : undefined,
      };
    }
    const partial = !exact;

    const state = entryState(entry, now, policy);
    if (isColdOrUnusable(state.confidence)) {
      return {
        layer,
        hash,
        warm: false,
        reason: state.expired ? COLD_REASON.EXPIRED : COLD_REASON.UNKNOWN,
        tokens: 0,
        stored_confidence: state.stored_confidence,
        evidence: state.evidence,
      };
    }
    return {
      layer,
      hash,
      warm: true,
      /** True when the warm region is the earlier prefix, not the whole current layer. */
      partial,
      carried_hash: partial ? carriedHash : undefined,
      confidence: state.confidence,
      stored_confidence: state.stored_confidence,
      evidence: state.evidence,
      tokens: state.tokens,
      tokens_provenance: state.tokens_provenance,
      remaining_ms: state.remaining_ms,
      half_life_passed: state.half_life_passed,
      written_at: entry.written_at,
      reads_observed: entry.reads_observed,
    };
  }

  /**
   * The M2 question, answered for one route.
   *
   * @param {object} args
   * @param {string} args.provider pricing-key provider (not a 9Router alias)
   * @param {string} args.model
   * @param {object} args.layers an M1 `prefixLayerSummary()`
   * @param {string[]} [args.invalidated] layers this turn invalidated (§9.1), read-side
   * @param {Record<string, string>} [args.carried] layer -> earlier prefix hash that M1
   *        has judged the current layer to extend.
   */
  function describeBelief({ provider, model, layers, invalidated = [], carried = null } = {}) {
    const pricing = registry.get(provider);
    const { status, cause, detail } = registry.statusOf(provider);
    const invalid = new Set(invalidated || []);
    const noModel = pricing.mechanism === "none";

    const perLayer = [];
    let broken = false;
    for (const layer of PREFIX_LAYERS) {
      const hash = layers?.[`${layer}_hash`] ?? null;
      let belief = noModel
        ? { layer, hash, warm: false, reason: COLD_REASON.NO_CACHE_MODEL, tokens: 0 }
        : layerBelief(provider, model, layer, hash, carried?.[layer] ?? null);

      // Invalidation masks an *exact* hit and nothing else. §9.1 says a changed layer is
      // no longer the cached one — which is a statement about the layer as it now stands,
      // not about the earlier prefix it grew out of. A grown `messages` layer is always
      // invalidated, so masking partial hits here would make rule 4 unreachable and every
      // growing conversation would be reported cold from its second turn onward.
      if (belief.warm && !belief.partial && invalid.has(layer)) {
        belief = { layer, hash, warm: false, reason: COLD_REASON.INVALIDATED, tokens: 0 };
      }
      if (broken && belief.warm) {
        belief = { layer, hash, warm: false, reason: COLD_REASON.BEHIND_COLD_LAYER, tokens: 0 };
      }
      // A cold layer breaks the prefix, and so does a *partly* warm one: the provider's
      // window ends inside it, so nothing behind it can be in that window either.
      if (!belief.warm || belief.partial) broken = true;
      perLayer.push(Object.freeze(belief));
    }

    const warm = perLayer.filter((l) => l.warm);
    const confirmed_tokens = warm
      .filter((l) => l.confidence === CACHE_CONFIDENCE.CONFIRMED)
      .reduce((s, l) => s + l.tokens, 0);
    const assumed_tokens = warm
      .filter((l) => l.confidence === CACHE_CONFIDENCE.ASSUMED)
      .reduce((s, l) => s + l.tokens, 0);

    // The aggregate is the weakest link in the warm prefix, not the best one: a prefix
    // is only as trustworthy as the least-evidenced layer it depends on.
    let confidence = CACHE_CONFIDENCE.UNKNOWN;
    if (warm.length) confidence = assumed_tokens > 0 ? CACHE_CONFIDENCE.ASSUMED : CACHE_CONFIDENCE.CONFIRMED;
    else if (noModel) confidence = CACHE_CONFIDENCE.UNKNOWN;
    else if (perLayer.some((l) => l.reason === COLD_REASON.EXPIRED)) confidence = CACHE_CONFIDENCE.EXPIRED;

    return Object.freeze({
      provider,
      model,
      mechanism: pricing.mechanism,
      pricing_status: status,
      pricing_cause: cause,
      pricing_detail: detail,
      pricing_version: pricing.version,
      pricing_verification: pricing.verification_method,
      labels: Object.freeze(registry.labelsFor(provider)),
      /** The contiguous warm run, in layer order. Empty means a cold route. */
      warm_prefix: Object.freeze(warm.map((l) => l.layer)),
      /**
       * The layers whose warm region is an earlier prefix rather than the whole layer.
       * Reported separately so a reader can see that `warm_tokens` stops mid-layer, which
       * is the difference between "the tail is cached" and "the tail up to here is".
       */
      partial_layers: Object.freeze(warm.filter((l) => l.partial).map((l) => l.layer)),
      layers: Object.freeze(perLayer),
      confidence,
      confirmed_tokens,
      assumed_tokens,
      warm_tokens: confirmed_tokens + assumed_tokens,
      /**
       * `confirmed` only when every warm layer was provider-reported. Any assumed layer
       * makes the merged total an estimate, and saying so here is what stops a later
       * caller summing the two into something it calls a measurement (I3).
       */
      warm_tokens_provenance:
        warm.length === 0 ? "unavailable" : assumed_tokens > 0 || status === PRICING_STATUS.STALE ? "estimated" : "confirmed",
      /** Zero cache economics may be claimed at all when this is true (I4). */
      economics_available: !noModel,
    });
  }

  /**
   * Re-run a belief with this turn's invalidation applied. Kept separate from
   * `describeBelief` so the unmasked belief stays inspectable: an operator asking "why
   * did nothing hit?" needs to see both the entry that exists and the invalidation that
   * masked it.
   */
  function applyInvalidation(belief, invalidated = []) {
    const carried = {};
    for (const l of belief.layers) if (l.carried_hash) carried[l.layer] = l.carried_hash;
    return describeBelief({
      provider: belief.provider,
      model: belief.model,
      layers: Object.fromEntries(belief.layers.map((l) => [`${l.layer}_hash`, l.hash])),
      invalidated,
      carried: Object.keys(carried).length ? carried : null,
    });
  }

  /** What this turn would write, if anything. Delegates the rules to the estimator. */
  function planWrites({ provider, layers } = {}) {
    return planCacheWrites({ model: registry.get(provider), layers });
  }

  return Object.freeze({
    now,
    size: index.size,
    entries: index,
    registry,
    describeBelief,
    applyInvalidation,
    planWrites,
    layerBelief,
  });
}

/** Convenience: the belief for one route, without holding on to a ledger. */
export function describeCacheBelief(args) {
  const { entries, registry, now, policy, ...rest } = args || {};
  return createCacheLedger({ entries, registry, now, policy }).describeBelief(rest);
}

export { CACHE_EVIDENCE };
export default createCacheLedger;
