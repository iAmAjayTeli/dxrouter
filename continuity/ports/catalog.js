/**
 * Port: `Catalog` — §11.3.
 *
 * The set of routable (provider, model) pairs and their capabilities, plus a
 * `version()` string that goes into every persisted Decision. The version is what
 * makes a stored decision explainable months later: without it, a decision made
 * against a since-changed catalog looks like an engine bug.
 */

import { PortContractError } from "./normalizedRequest.js";

function fail(message, field) {
  throw new PortContractError(message, { port: "Catalog", field });
}

/**
 * Capability fields are intentionally tri-state: `true` / `false` / `null` for
 * unknown. I4 (unknown cache semantics contribute zero) depends on `null` being
 * distinguishable from `false` — an unknown capability must never be treated as an
 * absent one.
 */
export function createModelDescriptor({
  provider,
  model,
  context_window = null,
  max_output = null,
  supports_tools = null,
  supports_caching = null,
  cache_ttl_s = null,
} = {}) {
  if (typeof provider !== "string" || !provider) fail("model.provider must be a non-empty string", "provider");
  if (typeof model !== "string" || !model) fail("model.model must be a non-empty string", "model");
  return Object.freeze({
    provider,
    model,
    context_window,
    max_output,
    supports_tools,
    supports_caching,
    cache_ttl_s,
  });
}

/**
 * @param {{models: () => Array, version: () => string}} impl
 */
export function defineCatalog(impl) {
  if (!impl || typeof impl.models !== "function" || typeof impl.version !== "function") {
    fail("a Catalog must expose models() and version()");
  }
  return Object.freeze({
    models: () => {
      const rows = impl.models();
      if (!Array.isArray(rows)) fail("Catalog.models() must return an array", "models");
      return rows;
    },
    version: () => {
      const v = impl.version();
      if (typeof v !== "string" || !v) fail("Catalog.version() must return a non-empty string", "version");
      return v;
    },
  });
}

export { PortContractError };
