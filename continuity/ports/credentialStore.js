/**
 * Port: `CredentialStore` — §11.3.
 *
 * `list()` returns connection *descriptors*: enough for eligibility filtering
 * (provider, id, active, priority, rate-limit window) and nothing secret.
 * `get(id)` returns the secret and is the only call that ever yields one — §11.4
 * forbids the adapter from holding plaintext beyond the call, so the engine must
 * treat the result as single-use and never persist it.
 */

import { PortContractError } from "./normalizedRequest.js";

function fail(message, field) {
  throw new PortContractError(message, { port: "CredentialStore", field });
}

/** Shape a host connection record into the engine-visible descriptor. */
export function createConnectionDescriptor({
  id,
  provider,
  auth_type = null,
  label = null,
  active = true,
  priority = null,
  rate_limited_until = null,
} = {}) {
  if (typeof id !== "string" || !id) fail("connection.id must be a non-empty string", "id");
  if (typeof provider !== "string" || !provider) fail("connection.provider must be a non-empty string", "provider");
  return Object.freeze({
    id,
    provider,
    auth_type,
    label,
    active: active !== false,
    priority,
    rate_limited_until,
  });
}

/**
 * @param {{list: () => Array, get: (id: string) => any}} impl
 */
export function defineCredentialStore(impl) {
  if (!impl || typeof impl.list !== "function" || typeof impl.get !== "function") {
    fail("a CredentialStore must expose list() and get(id)");
  }
  return Object.freeze({
    list: (...args) => {
      const rows = impl.list(...args);
      if (!Array.isArray(rows)) fail("CredentialStore.list() must return an array", "list");
      return rows;
    },
    get: (id) => impl.get(id),
  });
}

export { PortContractError };
