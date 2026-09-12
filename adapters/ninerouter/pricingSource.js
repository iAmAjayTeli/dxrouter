/**
 * `pricingSource` — where cache pricing records are read from on this host.
 *
 * Two layers, in order: the records committed inside the engine, then an operator
 * override directory under the one data root. The override wins per key, which is how
 * §9.2's "correctable without rewriting routing logic" is satisfied in practice — an
 * operator who finds that a provider's TTL changed drops a corrected `anthropic.yaml`
 * into `<data root>/cache-pricing/` and the next start uses it. No release, no patch, no
 * code path that treats a corrected file differently from a shipped one.
 *
 * The path lives here rather than in `continuity/` because a data root is host knowledge
 * (I1). The engine reads its own committed assets through `import.meta.url` and knows
 * nothing about this directory.
 *
 * The override directory is **not** created. An absent directory is the normal case and
 * `createDirectorySource` already returns "no keys" for it; creating it eagerly would
 * suggest to an operator that something is expected there.
 */

import path from "node:path";
import { DATA_DIR } from "../../src/lib/dataDir.js";
import { createDirectorySource, layerSources, shippedSource } from "../../continuity/cache/pricing/source.js";
import { loadCacheModels } from "../../continuity/cache/pricing/loader.js";
import { createCachePolicy } from "../../continuity/cache/policy.js";
import { createClockAdapter } from "./clockAdapter.js";

/** `<data root>/cache-pricing/` — kept in step with `src/lib/dataDir.js`, one root. */
export const PRICING_OVERRIDE_DIR = path.join(DATA_DIR, "cache-pricing");

/** Shipped records, then operator overrides. Later wins, per key. */
export function createPricingSource({ overrideDir = PRICING_OVERRIDE_DIR } = {}) {
  return layerSources(shippedSource(), createDirectorySource(overrideDir, { name: "override" }));
}

let cached = null;

/**
 * The process-wide registry.
 *
 * Memoised because loading it parses eleven files and validates every record, and because
 * a registry that changed between two calls inside one request would make a decision's
 * `pricing_version` unreproducible. `reload()` is the explicit escape hatch for a host
 * that wants a fix picked up without a restart.
 */
export function getPricingRegistry({ clock = createClockAdapter(), overrideDir = PRICING_OVERRIDE_DIR, strictProviders = [] } = {}) {
  if (cached) return cached;
  cached = loadCacheModels({
    source: createPricingSource({ overrideDir }),
    now: clock.now(),
    // Merged through `createCachePolicy` so naming one strict provider cannot silently
    // drop the staleness window along with it.
    policy: strictProviders.length ? createCachePolicy({ strictProviders }) : undefined,
  });
  return cached;
}

export function reloadPricingRegistry(opts = {}) {
  cached = null;
  return getPricingRegistry(opts);
}

export function __resetPricingRegistry() {
  cached = null;
}

export default getPricingRegistry;
