/**
 * `usageFields` — the one place that knows what a provider calls its token counts.
 *
 * Split out of `executorAdapter.js` for two reasons, both structural:
 *
 *  1. `executorAdapter` imports `open-sse/executors/index.js`, a bundler alias. Anything
 *     that touches it is unreachable from bare node, which is where the CLI and the cache
 *     probe run. The field vocabulary has no business being locked behind a transport.
 *  2. Two callers need the same vocabulary — the `RouteExecutor` port and the M2 cache
 *     observer. A second copy would drift, and a drifted copy of *this* table is silent:
 *     it does not fail, it just reports `null` where a provider reported a number.
 *
 * The rule the table exists to keep: **absent stays `null`, never `0`.** I4 needs
 * "the provider said nothing" to be distinguishable from "the provider said zero", and a
 * zero here reads downstream as a measured cache miss — a fabricated measurement.
 *
 * One deliberate omission worth stating, because it looks like a gap: DeepSeek's
 * `prompt_cache_miss_tokens` is **not** mapped to anything. It is the *uncached remainder*
 * of the prompt, not a cache write. Mapping it would put a number that means "we paid full
 * price for this" into a column that means "we cached this", which is worse than not
 * reading the field at all.
 */

/**
 * Every spelling of "tokens read from cache" this repository has seen a provider use.
 *
 * Order matters: the first field present with a finite number wins. Explicit vendor fields
 * come before the nested `*_details` shapes so a provider that reports both agrees with
 * itself, and the camelCase Gemini spellings are listed because Gemini reaches the observer
 * un-normalized on two of the four call paths.
 */
export const CACHE_READ_FIELDS = Object.freeze([
  "cache_read_input_tokens", // Anthropic
  "cache_read_tokens", // our own canonical shape, when it round-trips
  "cached_tokens", // OpenAI chat, flattened by requestDetail.js
  "prompt_tokens_details.cached_tokens", // OpenAI chat, raw
  "input_tokens_details.cached_tokens", // OpenAI Responses / Codex
  "prompt_cache_hit_tokens", // DeepSeek
  "cachedContentTokenCount", // Gemini, raw usageMetadata
  "cached_content_token_count", // Gemini, snake-cased by a translator
]);

/** Every spelling of "tokens written to cache". Gemini and DeepSeek report none. */
export const CACHE_WRITE_FIELDS = Object.freeze([
  "cache_creation_input_tokens", // Anthropic
  "cache_write_input_tokens",
  "cache_creation_tokens",
  "prompt_tokens_details.cache_creation_tokens", // our OpenAI-forwarding shape
]);

export const INPUT_FIELDS = Object.freeze(["input_tokens", "prompt_tokens", "promptTokenCount", "prompt_eval_count"]);
export const OUTPUT_FIELDS = Object.freeze(["output_tokens", "completion_tokens", "candidatesTokenCount", "eval_count"]);
export const TOTAL_FIELDS = Object.freeze(["total_tokens", "totalTokenCount"]);

/** Read `a.b.c` off `u`, or a plain key. Only finite numbers count as a report. */
function pickFrom(u, keys) {
  for (const k of keys) {
    const v = k.includes(".") ? k.split(".").reduce((o, p) => (o == null ? o : o[p]), u) : u[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Fold the many provider usage shapes into one. Absent fields stay `null`, never
 * zero: I4 needs "unknown" to be distinguishable from "none", and a zero here
 * would later read as a confirmed cache miss.
 *
 * @param {object|null} raw a provider usage object, or a response carrying `.usage`
 * @returns {{input_tokens: number|null, output_tokens: number|null, total_tokens: number|null,
 *            cache_read_tokens: number|null, cache_write_tokens: number|null,
 *            estimated: boolean}|null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const u = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
  const usage = {
    input_tokens: pickFrom(u, INPUT_FIELDS),
    output_tokens: pickFrom(u, OUTPUT_FIELDS),
    total_tokens: pickFrom(u, TOTAL_FIELDS),
    cache_read_tokens: pickFrom(u, CACHE_READ_FIELDS),
    cache_write_tokens: pickFrom(u, CACHE_WRITE_FIELDS),
  };
  const known = Object.values(usage).some((v) => v !== null);
  if (!known) return null;
  // `estimated` is 9Router's own marker, set by `formatUsage()` when a provider returned
  // no usage at all and the stream length was measured instead. It travels with the number
  // rather than being stripped, because a count whose provenance is lost is a count that
  // will eventually be cited as provider-reported.
  return { ...usage, estimated: usageIsEstimated(u) };
}

/** Whether this usage object is 9Router's own estimate rather than a provider report. */
export function usageIsEstimated(raw) {
  if (!raw || typeof raw !== "object") return false;
  const u = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
  return u.estimated === true;
}

/** The model the provider says it served, for silent-substitution detection. */
export function extractReportedModel(payload) {
  if (!payload || typeof payload !== "object") return null;
  const m = payload.model || payload.modelVersion || payload.response?.model || payload.model_version || null;
  return typeof m === "string" && m ? m : null;
}

export default normalizeUsage;
