/**
 * `catalogAdapter` — `Catalog` port over the provider registry (§11.3).
 *
 * Two jobs, and the second is the interesting one:
 *
 * 1. Flatten `PROVIDER_MODELS` into `(provider, model)` descriptors.
 * 2. Tell *declared* capabilities apart from *defaulted* ones.
 *
 * ### Why (2) is not optional
 *
 * `getCapabilitiesForModel()` never returns "I don't know" — it falls through to
 * `DEFAULT_CAPABILITIES`, so an unrecognised model still comes back claiming a
 * 200k context window, 64k output and tool support. Those are sensible transport
 * defaults and wrong inputs for a routing decision: I3 says assumed is not
 * confirmed, and I4 says unknown must contribute zero rather than be treated as a
 * value. Feeding a floor value into the engine as fact is how a router ends up
 * confidently overflowing a context window it never measured.
 *
 * So each field is probed against the floor for the same provider (via a model id
 * that cannot match any rule). A value that is indistinguishable from the floor is
 * reported as `null` — the port's third state — not as the floor number.
 *
 * `supports_caching` and `cache_ttl_s` are **always `null`** in M0: 9Router
 * declares no cache semantics anywhere, and inventing them is precisely what I4
 * forbids. Confirming them per provider is compatibility-probe work (M2), which
 * M0 must not implement.
 *
 * M0 status: implemented and tested, NOT called from the request path.
 */

import crypto from "node:crypto";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { createModelDescriptor, defineCatalog } from "../../continuity/ports/catalog.js";

/**
 * A model id no rule can match: no vendor prefix, no version digits, no family
 * name. Resolving it yields the provider's floor, which is the shape of "nothing
 * is known about this model".
 */
const FLOOR_PROBE_ID = "dxr-floor-probe-unknown";

/** Capability floor per provider, computed once per catalog build. */
function floorFor(provider, cache, resolve) {
  if (!cache.has(provider)) cache.set(provider, resolve(provider, FLOOR_PROBE_ID));
  return cache.get(provider);
}

/**
 * @returns the declared value, or `null` when it is indistinguishable from the
 * provider's floor.
 */
function declaredOnly(value, floorValue) {
  if (value === undefined || value === null) return null;
  return value === floorValue ? null : value;
}

/**
 * Build descriptors for one provider's models.
 *
 * @param {string} provider provider alias, as used by `getExecutor`
 * @param {Array} models registry model entries
 */
export function describeProviderModels(provider, models, { resolve = getCapabilitiesForModel, floors = new Map() } = {}) {
  const out = [];
  for (const raw of Array.isArray(models) ? models : []) {
    const id = typeof raw === "string" ? raw : raw?.id;
    if (typeof id !== "string" || !id) continue;

    const caps = resolve(provider, id) || {};
    const floor = floorFor(provider, floors, resolve) || {};

    out.push(
      createModelDescriptor({
        provider,
        model: id,
        context_window: declaredOnly(caps.contextWindow, floor.contextWindow),
        max_output: declaredOnly(caps.maxOutput, floor.maxOutput),
        supports_tools: declaredOnly(caps.tools, floor.tools),
        // See the header: no cache semantics exist to read, so none are claimed.
        supports_caching: null,
        cache_ttl_s: null,
      })
    );
  }
  return out;
}

/** Flatten the whole registry. */
export function buildModelDescriptors({ providerModels = PROVIDER_MODELS, resolve = getCapabilitiesForModel } = {}) {
  const floors = new Map();
  const out = [];
  for (const [provider, models] of Object.entries(providerModels || {})) {
    out.push(...describeProviderModels(provider, models, { resolve, floors }));
  }
  return out;
}

/**
 * Content hash of the descriptor set.
 *
 * Every persisted Decision carries this. Without it, a decision made against a
 * since-changed catalog is indistinguishable from an engine bug months later — so
 * the version must be derived from the catalog's *content*, not from a package
 * version somebody forgets to bump.
 */
export function catalogVersionOf(descriptors) {
  const canonical = descriptors
    .map((d) =>
      [
        d.provider,
        d.model,
        d.context_window,
        d.max_output,
        d.supports_tools,
        d.supports_caching,
        d.cache_ttl_s,
      ].join("")
    )
    .sort()
    .join("\n");
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `reg-1:${descriptors.length}:${hash}`;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.providerModels] injectable registry, for tests
 * @param {Function} [deps.resolve] injectable capability resolver, for tests
 */
export function createCatalogAdapter({ providerModels = PROVIDER_MODELS, resolve = getCapabilitiesForModel } = {}) {
  // Built once: the registry is static imports, and a Catalog whose contents
  // shift mid-decision would make the recorded version a lie.
  const descriptors = Object.freeze(buildModelDescriptors({ providerModels, resolve }));
  const version = catalogVersionOf(descriptors);

  return defineCatalog({
    models: () => descriptors,
    version: () => version,
  });
}

export default createCatalogAdapter;
