/**
 * `cacheObserver` — the host side of M2 observation.
 *
 * One live call, mirroring `sessionObserver`: a provider result goes in, a content-free
 * record comes out, and **nothing routable is returned**. Legacy `accountFallback` has
 * already chosen the provider and the model by the time this runs; this file cannot change
 * that choice, and there is no code path here that could.
 *
 * Three host concerns that cannot live in `continuity/` (I1):
 *
 *  1. **The alias → pricing-key map** (`pricingKeys.js`, re-exported below). 9Router
 *     carries 81 provider aliases; §9.2 names ten vendors. The mapping is deliberately
 *     conservative and explicit: an alias that is not
 *     listed maps to nothing, `registry.get` resolves the `default` record
 *     (`mechanism: none`), and the route contributes zero claimed cache economics (I4).
 *     Guessing — `codex` → openai, `gemini-cli` → google — is exactly the "silently fall
 *     back to another provider" the invariants forbid, because those aliases reach
 *     different endpoints with different cache behaviour under a familiar-looking name.
 *  2. **Usage shape.** The engine expects `{input, output, cache_read, cache_write}` with
 *     `null` meaning "the provider said nothing". `usageFields.normalizeUsage` owns the
 *     provider-specific field hunting for both the executor port and this observer, so it
 *     is reused rather than duplicated — one place where a new provider's field name has
 *     to be learned, and one place a missing spelling has to be fixed.
 *  3. **Fail-open.** `observeCacheResult` throws on real failure so tests can see it. Here
 *     that becomes a swallowed warning. An observation may never change a response.
 *
 * A fourth, added with the failure path: **classification lives here.** The inherited
 * request path reports facts — an HTTP status, a thrown error, response headers, two
 * timings — and the engine stores columns. Naming a 429 `rate_limit` is neither, so it
 * happens in this layer, with the same closed taxonomy the `RouteExecutor` port uses
 * (`failureFields.js`). A failed attempt arrives here as `status: "error"` with
 * `usage: null`, and nothing in this file invents a count to put beside it: the engine
 * records the attempt with unavailable usage and no cache belief (I3, I4).
 */

import { observeCacheResult } from "../../continuity/cache/observer.js";
import { resolveFlags } from "../../continuity/flags.js";
import { createClockAdapter } from "./clockAdapter.js";
import { getContinuityStore } from "./continuityDb.js";
import { describeFailure } from "./failureFields.js";
import { normalizeUsage } from "./usageFields.js";
import { recordUsageFields } from "./usageFieldEvidence.js";
import { getPricingRegistry } from "./pricingSource.js";
import { PRICING_KEY_BY_ALIAS, pricingKeyForProvider } from "./pricingKeys.js";

// The alias map lives in its own module so the bare-node CLI can read it without
// pulling `open-sse` in through `executorAdapter`. Re-exported here because this is
// where a reader looking for host-side cache concerns will expect to find it.
export { PRICING_KEY_BY_ALIAS, pricingKeyForProvider };

/**
 * `{input, output, cache_read, cache_write, estimated}`; absent counts stay `null`.
 *
 * `estimated` is 9Router's own marker: `finalizeStream()` substitutes a byte-length
 * estimate when a provider returns no usage at all, and `formatUsage()` stamps the object.
 * It is carried through rather than dropped so the engine can record the count with the
 * right provenance instead of filing an estimate as something a provider reported (I3).
 */
export function toEngineUsage(raw) {
  const u = normalizeUsage(raw);
  if (!u) return { input: null, output: null, cache_read: null, cache_write: null, estimated: false };
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    // Null and zero are different answers, and `normalizeUsage` already preserves the
    // distinction. Collapsing it here would turn provider silence into a measured miss.
    cache_read: u.cache_read_tokens,
    cache_write: u.cache_write_tokens,
    estimated: u.estimated === true,
  };
}

/** Whether M2 observation is enabled at all. `DXR_CACHE_TRACKING=off` is the rollback. */
export function cacheTrackingEnabled(env = process.env) {
  return resolveFlags(env).cacheTracking !== false;
}

/**
 * Record what a provider actually did for one observed turn. Never throws.
 *
 * @param {object} args
 * @param {object} args.observation the record `observeNormalizedTurn` returned
 * @param {object} args.result `{provider, model, reported_model, status, http_status, usage,
 *        attempt_id, at}`, plus, when the attempt failed: `{error, headers, ttfb_ms,
 *        total_ms}` — a thrown error's `{name, message}`, the response headers (read only
 *        for a retry hint), and whatever timings the host had. None of them is required.
 * @param {object} [args.store]
 * @param {object} [args.registry]
 * @param {object} [args.env]
 * @param {{now: () => number}} [args.clock]
 * @param {(msg: string) => void} [args.warn]
 * @returns {Promise<object>} a content-free record, or `{observed: false, reason}`
 */
export async function observeProviderResult({
  observation,
  result,
  store = null,
  registry = null,
  env = process.env,
  clock = createClockAdapter(),
  warn = (msg) => console.warn(`[DXR][cache] ${msg}`),
} = {}) {
  try {
    if (!cacheTrackingEnabled(env)) return { observed: false, reason: "cache_tracking_off" };
    // No observed turn means M1 recorded nothing for this request (sessions off, or its
    // own fail-open path). There is nothing to attach a result to, and manufacturing a
    // session out of a response would create continuity state from the wrong direction.
    if (!observation?.observed || !observation?.session_id) return { observed: false, reason: "no_observed_turn" };
    if (!result || typeof result !== "object") return { observed: false, reason: "no_result" };

    const handle = store || (await getContinuityStore());
    const models = registry || getPricingRegistry({ clock });
    const provider = typeof result.provider === "string" ? result.provider : null;
    // Only for an attempt that did not end cleanly. A successful result carries no failure
    // columns rather than four zeros, which is the difference between "it did not fail" and
    // "it failed in 0ms with no error class".
    const failed = (result.status ?? "ok") !== "ok";
    const failure = failed
      ? describeFailure({
          http_status: result.http_status ?? null,
          error: result.error ?? null,
          headers: result.headers ?? null,
          ttfb_ms: result.ttfb_ms ?? null,
          total_ms: result.total_ms ?? null,
          now: clock.now(),
        })
      : null;

    // I-8: one raw usage sample per provider per field signature, numbers only, written
    // only when an operator asked for it. This is the evidence that decides whether a
    // spelling in `usageFields.js` is real, and no other artefact in the system records
    // what a provider's usage object actually looked like.
    recordUsageFields({ provider, usage: result.usage, env });

    return observeCacheResult({
      store: handle,
      clock,
      registry: models,
      observation,
      result: {
        provider,
        pricing_key: pricingKeyForProvider(provider),
        model: typeof result.model === "string" ? result.model : null,
        reported_model: typeof result.reported_model === "string" ? result.reported_model : null,
        status: result.status,
        http_status: result.http_status,
        usage: toEngineUsage(result.usage),
        attempt_id: typeof result.attempt_id === "string" ? result.attempt_id : null,
        at: Number.isFinite(result.at) ? result.at : undefined,
        ...(failure ?? {}),
      },
    });
  } catch (e) {
    // The one rule of this file, same as `sessionObserver`: a broken observation is a
    // missing row, never a failed completion.
    warn(`cache observation skipped: ${e?.message || e}`);
    return { observed: false, reason: "error", error: e?.message || String(e) };
  }
}

export default observeProviderResult;
