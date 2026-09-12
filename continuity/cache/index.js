/**
 * The M2 cache surface.
 *
 * Everything M2 knows about a cache is reachable from here, and everything reachable
 * from here is an observation or a belief about one. There is no cost, no candidate and
 * no decision in this tree: pricing terms are *carried* so a later milestone can price
 * with them, and `economics_available` is the flag that says whether it may.
 *
 * The pieces, in the order they are used on a real turn:
 *
 *   1. `loadCacheModels()` builds the registry once at startup (§9.3).
 *   2. M1's `observeTurn()` hashes the prefix layers and records the turn.
 *   3. `createCacheLedger().describeBelief()` answers the M2 question for a route —
 *      what do we believe about this session's cache state, and how strong is the
 *      evidence? — with §9.1 invalidation applied read-side.
 *   4. after the provider answers, `observeCacheResult()` records what it reported and
 *      updates the beliefs.
 *
 * Step 3 is what a future engine consults; step 4 is what makes step 3 worth consulting.
 */

export {
  CACHE_CONFIDENCE,
  CACHE_CONFIDENCES,
  CACHE_EVIDENCE,
  PROVIDER_EVIDENCE,
  isCacheConfidence,
  raiseWithEvidence,
  assertConfidenceEvidence,
  degradeCacheConfidence,
  cacheStrength,
  isColdOrUnusable,
} from "./confidence.js";
export { DEFAULT_CACHE_POLICY, createCachePolicy, maxAgeMs } from "./policy.js";
export {
  CACHE_LAYERS,
  CacheEntryError,
  cacheEntryKey,
  createCacheEntry,
  expiresAt,
  deleteAfter,
  entryState,
  applyEvidence,
} from "./entry.js";
export { INELIGIBLE, planCacheWrites } from "./estimator.js";
export { COLD_REASON, indexEntries, createCacheLedger, describeCacheBelief } from "./ledger.js";
export {
  RESULT_STATUS,
  NO_ENTRIES,
  classifyCacheResult,
  attributeRead,
  planEvidenceEntries,
  observeCacheResult,
} from "./observer.js";
export * from "./pricing/index.js";
