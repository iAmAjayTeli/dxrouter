/**
 * App-side cache observation (M2).
 *
 * The request path calls two functions from here and uses the return value of neither.
 * `rememberTurn` files the M1 observation away under the live request object;
 * `makeProviderResultObserver` hands the engine a callback that records what the provider
 * reported once the response is done. Legacy 9Router routing — combo expansion,
 * `accountFallback`, retries, provider selection — is untouched and remains authoritative
 * (§12). Nothing here can change a route, and nothing here is on the critical path.
 *
 * ### Why a WeakMap keyed by the request
 *
 * An observation happens when the body arrives; the usage arrives when the stream ends,
 * several stack frames away, possibly after several failed attempts on other accounts. The
 * two need to be correlated without inventing an id and without threading a context object
 * through inherited code. The live `Request` object is already that identity, and a WeakMap
 * on it means an abandoned request takes its entry with it when it is collected — no
 * timeout sweeper, no leak, no state that outlives the thing it describes.
 *
 * One request can produce several results (retries, account fallback, combo rotation), and
 * they are all recorded against the same M1 turn as separate `turn_results` rows. That is
 * the intended shape: §12.1 keys attempts by sequence within the turn, and the failed
 * attempt is exactly the evidence a later milestone needs.
 *
 * Three guards, in order:
 *   1. the `cacheTracking` flag (`DXR_CACHE_TRACKING=off` is the M2 rollback);
 *   2. a `try/catch` around every entry point, because this runs inside a live completion;
 *   3. fire-and-forget scheduling, so a SQLite write never appears in a latency number.
 */

import { observeProviderResult } from "../../../adapters/ninerouter/cacheObserver.js";
import { getPricingRegistry } from "../../../adapters/ninerouter/pricingSource.js";
import { createClockAdapter } from "../../../adapters/ninerouter/clockAdapter.js";
import { getFlags } from "./flags.js";

if (!global._dxrCache) global._dxrCache = { turns: new WeakMap(), warned: false, inFlight: 0 };
const state = global._dxrCache;

/** Observation is on unless an operator turned it off. */
export function cacheTrackingEnabled(flags = getFlags()) {
  return flags?.cacheTracking !== false;
}

function warnOnce(message) {
  if (state.warned) return;
  state.warned = true;
  console.warn(`[DXR][cache] ${message}`);
}

/**
 * File the M1 observation under this request. `promise` may resolve to
 * `{observed: false, ...}`; that is stored too, because "we know M1 declined" is what
 * stops the result path from waiting on something that will never arrive.
 */
export function rememberTurn(key, promise) {
  if (!key || typeof key !== "object" || !promise) return;
  try {
    state.turns.set(key, promise);
  } catch {
    /* a non-weakref-able key: no correlation, no observation, no failure */
  }
}

/** The filed observation for this request, or null. */
export async function recallTurn(key) {
  if (!key || typeof key !== "object") return null;
  const pending = state.turns.get(key);
  if (!pending) return null;
  try {
    return await pending;
  } catch {
    return null;
  }
}

/**
 * Build the `onProviderResult` callback the engine hands down to its response handlers.
 *
 * Returns `null` when tracking is off, so the inherited call sites see the same `null` they
 * saw before M2 and take the same branch they always took.
 *
 * The callback returns immediately. It is invoked from inside `saveUsageStats`, which sits
 * on the response path of a request the client is still reading.
 *
 * @param {object} key the live request object, the same one passed to `rememberTurn`
 * @returns {((result: object) => void)|null}
 */
export function makeProviderResultObserver(key) {
  if (!cacheTrackingEnabled()) return null;
  if (!key || typeof key !== "object") return null;

  return function onProviderResult(result) {
    // A value that is not an object is not a provider report. It has to be dropped here,
    // because the shape below fills every field with `?? null` and the engine downstream
    // would then see a well-formed result that reported nothing — a `turn_results` row
    // asserting that an attempt happened and stayed silent. That is a measurement nobody
    // took, so a garbage notification writes nothing at all.
    if (!result || typeof result !== "object") return;

    const run = async () => {
      const observation = await recallTurn(key);
      // No M1 turn means nothing to attach to. Manufacturing a session out of a response
      // would build continuity state from the wrong direction.
      if (!observation?.observed) return null;
      const clock = createClockAdapter();
      return observeProviderResult({
        observation,
        result: {
          provider: result?.provider ?? null,
          model: result?.model ?? null,
          reported_model: result?.reported_model ?? null,
          status: result?.status ?? "ok",
          http_status: result?.http_status ?? null,
          usage: result?.usage ?? null,
          // Failure facts, forwarded untouched for the adapter to classify. All four are
          // absent on a successful result and stay absent — a row that did not fail carries
          // no error class, no retry hint and no failure timings rather than zeros. The
          // headers are read for a retry hint and nothing else; none is persisted, and no
          // provider message is stored anywhere (§14).
          error: result?.error ?? null,
          headers: result?.headers ?? null,
          ttfb_ms: result?.ttfb_ms ?? null,
          total_ms: result?.total_ms ?? null,
          at: clock.now(),
        },
        clock,
        registry: getPricingRegistry({ clock }),
        env: process.env,
      });
    };

    state.inFlight += 1;
    run()
      .catch((e) => warnOnce(`cache observation skipped: ${e?.message || e}`))
      .finally(() => {
        state.inFlight -= 1;
      });
  };
}

/** Test seam: forget the one-shot warning and the in-flight counter. */
export function __resetCacheObservation() {
  state.warned = false;
  state.inFlight = 0;
  state.turns = new WeakMap();
}

export default makeProviderResultObserver;
