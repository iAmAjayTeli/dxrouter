/**
 * `failureFields` — the one place that decides what a failed attempt was.
 *
 * Split out of `executorAdapter.js` for the same structural reason `usageFields.js` was:
 * `executorAdapter` imports `open-sse/executors/index.js`, a bundler alias no bare-node
 * process can resolve, and two callers now need this vocabulary rather than one —
 *
 *  1. the `RouteExecutor` port, which classifies the attempts it makes itself, and
 *  2. `cacheObserver`, which records a failed attempt that legacy `accountFallback`
 *     made on the inherited path (§12.1). That observation must not drag the routing
 *     engine into the bare-node CLI to learn what a 429 is called.
 *
 * A second copy of a closed taxonomy drifts silently: it does not fail, it just files a
 * `rate_limit` as `unknown` in one half of the system and not the other, and every Q3
 * question about forced moves is asked of that column.
 *
 * The rule these functions exist to keep: **an unmapped failure is `unknown`, never a
 * guess.** I3 applies to failure reasons too — a wrong `quota` would send a later
 * milestone down a wrong recovery path, and a wrong `rate_limit` would put a provider's
 * outage in the column Q3 reads as "the provider told us to move".
 */

/**
 * HTTP status → the port's closed error taxonomy.
 *
 * Anything unmapped becomes `unknown` rather than a guess.
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return null;
  switch (status) {
    case 400:
    case 404:
    case 405:
    case 415:
    case 422:
      return "schema";
    case 401:
    case 403:
      return "auth";
    case 402:
      return "quota";
    case 408:
      return "timeout";
    case 429:
      return "rate_limit";
    case 504:
      return "timeout";
    default:
      break;
  }
  if (status >= 500) return "server";
  return "unknown";
}

/** Thrown transport failures carry no status, so they are classified by shape. */
export function classifyThrown(error) {
  const name = error?.name || "";
  const message = String(error?.message || "").toLowerCase();
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (message.includes("timeout") || message.includes("etimedout")) return "timeout";
  if (
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("socket hang up") ||
    message.includes("fetch failed") ||
    message.includes("network")
  ) {
    return "server";
  }
  return "unknown";
}

const RETRY_AFTER_HEADERS = ["retry-after", "x-ratelimit-reset-after", "ratelimit-reset"];

/** Seconds to wait, when the provider says. `null` means it did not say. */
export function parseRetryAfter(headers, { now = null } = {}) {
  if (!headers || typeof headers.get !== "function") return null;
  for (const name of RETRY_AFTER_HEADERS) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      const base = typeof now === "number" ? now : Date.now();
      return Math.max(0, Math.round((at - base) / 1000));
    }
  }
  return null;
}

/**
 * How one failed attempt ended, from whatever the host actually had at failure time.
 *
 * Every field is independently optional because every one of them is genuinely missing for
 * some real failure: a refused socket has no HTTP status, a connection that never opened has
 * no TTFB, and most 5xx responses name no retry window. Nothing is defaulted to zero — the
 * distinction between "no retry hint" and "retry immediately" is exactly the one I4 is about.
 *
 * @param {object} args
 * @param {number|null} [args.http_status] the status the provider returned, if it answered
 * @param {{name?: string, message?: string}|null} [args.error] a thrown transport failure
 * @param {{get: (name: string) => string|null}|null} [args.headers] response headers, read
 *        only for a retry hint; no other header is looked at and none is stored
 * @param {number|null} [args.ttfb_ms]
 * @param {number|null} [args.total_ms]
 * @param {number|null} [args.now] clock reading, for a `Retry-After` given as a date
 * @returns {{error_class: string|null, retry_after_s: number|null, ttfb_ms: number|null, total_ms: number|null}}
 */
export function describeFailure({ http_status = null, error = null, headers = null, ttfb_ms = null, total_ms = null, now = null } = {}) {
  const status = Number.isFinite(http_status) ? http_status : null;
  // A status the provider actually returned outranks a guess from an error shape: it is the
  // provider's own verdict. With no status, the thrown error is all there is; with neither,
  // the honest answer is that we do not know how it ended.
  const error_class = status !== null ? classifyStatus(status) : error ? classifyThrown(error) : "unknown";
  return {
    error_class,
    retry_after_s: parseRetryAfter(headers, { now }),
    ttfb_ms: Number.isFinite(ttfb_ms) ? Math.max(0, Math.round(ttfb_ms)) : null,
    total_ms: Number.isFinite(total_ms) ? Math.max(0, Math.round(total_ms)) : null,
  };
}

export default describeFailure;
