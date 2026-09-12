/**
 * App-side flag surface.
 *
 * `continuity/flags.js` is pure and never touches `process`; this module is the
 * only place that binds it to the real environment, and caches the result so a
 * flag cannot change mid-process (which would make a decision trace unreadable).
 */

import {
  resolveFlags as resolvePure,
  describeFlags,
  isEngineDisabled,
  unimplementedRequests,
} from "../../../continuity/flags.js";

export { describeFlags, isEngineDisabled };

/** @returns {Readonly<object>} flags resolved once from `process.env`. */
export function getFlags() {
  if (!global._dxrFlags) global._dxrFlags = resolvePure(process.env);
  return global._dxrFlags;
}

/** Re-resolve from an explicit env. Test seam only. */
export function resolveFlags(env = process.env) {
  return resolvePure(env);
}

/**
 * Tell the operator about switches they set that this build cannot honour yet.
 *
 * Silence would be the harmful default: someone who exports
 * `DXR_CACHE_ECONOMICS=1` on an M0 build would otherwise believe cache-aware
 * routing is live. A flag that misrepresents its own state is worse than a missing
 * flag, so an unimplemented request is reported at startup.
 *
 * @returns {string[]} the warning lines (also logged)
 */
export function warnUnimplementedFlags({ env = process.env, log = console.warn } = {}) {
  const lines = unimplementedRequests(env).map(
    (f) => `[dxr] ${f.env} is set but ${f.flag} ships in ${f.milestone} — it has no effect on this build.`
  );
  for (const line of lines) log(line);
  return lines;
}

/** Test seam: drop the cached resolution. */
export function __resetFlags() {
  global._dxrFlags = null;
}
