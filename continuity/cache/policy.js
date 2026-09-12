/**
 * Cache tunables, in one injected object.
 *
 * Same reasoning as `session/policy.js`: the architecture fixes some of these numbers
 * and leaves others open, and a single place makes the open ones visible instead of
 * scattering magic numbers through the ledger and the sweeper.
 *
 * Nothing here is a price. These are the knobs that decide when a belief stops being
 * usable, not what a belief is worth.
 */

/** §9.3 fixes 90 days; §12.3 fixes the 1 h deletion grace. The rest are chosen here. */
export const DEFAULT_CACHE_POLICY = Object.freeze({
  /**
   * §9.3: a pricing record older than this is still used, but every term it produces
   * is downgraded to `estimated` and labelled `cache-model-stale`.
   */
  maxAgeDays: 90,
  /**
   * §12.3: a `cache_entries` row is deleted at `written_at + ttl_s + graceMs`. The
   * grace exists so an entry that just expired is still *visible* as `expired` rather
   * than vanishing — "expired" and "never existed" must stay distinguishable.
   */
  expiryGraceMs: 60 * 60 * 1000,
  /**
   * §4.2: an entry past half its TTL is reported one confidence step lower, because a
   * belief about a window that is mostly gone is weaker than a fresh one.
   */
  halfLifeDegrade: true,
  /**
   * §9.3: providers whose pricing record must load or the process must not start.
   * Empty by default — a bad provider entry degrades that provider, it does not stop
   * the router.
   */
  strictProviders: Object.freeze([]),
  /** How long `turn_results` rows are kept; mirrors the M1 turn retention default. */
  resultRetentionDays: 30,
  /** Rows per sweep pass, so a long-idle database cannot stall a request thread. */
  sweepBatch: 5000,
});

/** @returns {Readonly<typeof DEFAULT_CACHE_POLICY>} */
export function createCachePolicy(overrides = {}) {
  const merged = { ...DEFAULT_CACHE_POLICY, ...(overrides || {}) };
  const num = (key, min) => {
    const v = Number(merged[key]);
    if (!Number.isFinite(v) || v < min) return DEFAULT_CACHE_POLICY[key];
    return v;
  };
  return Object.freeze({
    ...merged,
    maxAgeDays: num("maxAgeDays", 1),
    expiryGraceMs: num("expiryGraceMs", 0),
    resultRetentionDays: num("resultRetentionDays", 1),
    sweepBatch: num("sweepBatch", 1),
    halfLifeDegrade: merged.halfLifeDegrade !== false,
    strictProviders: Object.freeze(
      Array.isArray(merged.strictProviders) ? merged.strictProviders.map((p) => String(p)) : []
    ),
  });
}

export const maxAgeMs = (policy = DEFAULT_CACHE_POLICY) => policy.maxAgeDays * 86_400_000;

export default DEFAULT_CACHE_POLICY;
