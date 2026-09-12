/**
 * `credentialAdapter` — `CredentialStore` port over `providerConnections` (§11.3).
 *
 * Two responsibilities, deliberately split:
 *
 * - `list()` is a *snapshot* of descriptors: id, provider, auth type, active flag,
 *   priority, rate-limit window. Synchronous, because `decide()` is pure (I6) and
 *   cannot await. The host loads the snapshot before the decision; the engine reads
 *   it during.
 * - `get(id)` is the only call that yields a secret, and it is async because the
 *   host store is. §11.4: the adapter must not hold plaintext beyond the call, so
 *   nothing is memoised here.
 *
 * M0 status: implemented and tested, NOT called from the request path.
 */

import { createConnectionDescriptor, defineCredentialStore } from "../../continuity/ports/credentialStore.js";

/** Secret-bearing fields on a 9Router connection record. */
const SECRET_FIELDS = Object.freeze([
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
]);

/**
 * A rate-limit window may be stored as epoch ms or as an ISO string. The engine
 * only ever compares it against `Clock.now()`, so it is normalised to epoch ms —
 * and to `null` when it cannot be parsed, never to 0 (which would read as "limited
 * until 1970", i.e. not limited, by accident rather than by fact).
 */
export function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 9Router connection row → engine-visible descriptor. Drops every secret. */
export function toDescriptor(connection) {
  return createConnectionDescriptor({
    id: connection.id,
    provider: connection.provider,
    auth_type: connection.authType ?? null,
    label: connection.displayName || connection.name || connection.email || null,
    active: connection.isActive !== false,
    priority: typeof connection.priority === "number" ? connection.priority : null,
    rate_limited_until: toEpochMs(connection.rateLimitedUntil),
  });
}

/** The secret half, shaped the way `BaseExecutor.buildHeaders` expects it. */
export function toCredentials(connection) {
  if (!connection) return null;
  const out = { id: connection.id, provider: connection.provider, authType: connection.authType ?? null };
  for (const field of SECRET_FIELDS) {
    if (connection[field] !== undefined && connection[field] !== null) out[field] = connection[field];
  }
  // Executors read a few non-secret extras off the credential object (project id
  // for Vertex, expiry for the refresh check), so they travel with it.
  for (const field of ["expiresAt", "expiresIn", "tokenType", "scope", "projectId", "lastRefreshAt"]) {
    if (connection[field] !== undefined) out[field] = connection[field];
  }
  return out;
}

/**
 * Load the descriptor snapshot the engine will read.
 *
 * @param {(filter?: object) => Promise<Array>} getProviderConnections host repo fn
 * @param {object} [filter] passed through to the repo
 * @returns {Promise<Array>} descriptors, secrets already stripped
 */
export async function loadConnectionSnapshot(getProviderConnections, filter = {}) {
  const rows = await getProviderConnections(filter);
  return (Array.isArray(rows) ? rows : []).map(toDescriptor);
}

/**
 * @param {object} deps
 * @param {Array} deps.connections descriptor snapshot, from `loadConnectionSnapshot`
 * @param {(id: string) => Promise<object|null>} deps.getConnectionById host repo fn,
 *   used only by `get(id)` — this is the single-use secret path
 */
export function createCredentialAdapter({ connections = [], getConnectionById = null } = {}) {
  const snapshot = Object.freeze([...connections]);

  return defineCredentialStore({
    list: () => snapshot,
    get: async (id) => {
      if (!getConnectionById) return null;
      const row = await getConnectionById(id);
      return toCredentials(row);
    },
  });
}

export default createCredentialAdapter;
