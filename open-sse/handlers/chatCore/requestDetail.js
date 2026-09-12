import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      // `?? null`, not `|| 0`: an absent field must not arrive downstream as a reported
      // zero. Gemini omits cachedContentTokenCount entirely when nothing was cached, and
      // a fabricated 0 there reads as "the provider measured a cache miss" — a measurement
      // nobody took. Storage is unaffected: canonicalizeUsage() maps a null cache count to
      // 0 for the usage row exactly as it did before, and takes the same branch either way
      // (the key is present, so the Claude cache-fold path stays out of it).
      cached_tokens: usageMetadata.cachedContentTokenCount ?? null,
      reasoning_tokens: usageMetadata.thoughtsTokenCount ?? null
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides
  };
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

/**
 * M2 observation for an attempt that produced no response (§12.1).
 *
 * The success path is observed from inside `saveUsageStats`, which only runs once a
 * provider has answered. A 429, a 500 or a refused socket answers nothing, so without this
 * the observation record contains only the attempts that worked — and the question a later
 * milestone asks of that record is *why a route moved*, which is exactly the information a
 * missing failure row deletes.
 *
 * Three properties this call has to have, and the reason each one matters here:
 *
 *  1. **It changes nothing.** No return value is read, no branch below or above depends on
 *     it, and it cannot throw: the `try/catch` is unconditional. Fallback, retries,
 *     rate-limit handling and `accountFallback` behave exactly as they did.
 *  2. **It reports facts, it does not classify.** An HTTP status, the thrown error's name
 *     and message, the response headers and two timings go out as they were observed.
 *     Naming a 429 `rate_limit` is the host adapter layer's job, not this engine's, and the
 *     message travels only so that layer can classify a transport error by shape — no
 *     provider message is persisted anywhere (§14).
 *  3. **It invents no usage.** `usage: null` means unavailable, and the engine records it as
 *     unavailable. A failed attempt must never become a measured zero, a successful
 *     observation, or a cache event (I3, I4).
 *
 * @param {object} args
 * @param {((result: object) => void)|null} args.onProviderResult the M2 side channel; when
 *        it is null — M2 off, or an inherited caller that never passed one — nothing happens
 * @param {number|null} [args.httpStatus] the status the provider returned, if it answered
 * @param {Error|null} [args.error] a thrown transport failure
 * @param {object|null} [args.headers] response headers, read downstream only for a retry hint
 * @param {number|null} [args.requestStartTime] `Date.now()` at dispatch, for `total_ms`
 * @param {number|null} [args.ttfbMs] time to first byte, when a byte arrived
 */
export function observeFailedAttempt({ onProviderResult = null, provider, model, connectionId = null, endpoint = null, httpStatus = null, error = null, headers = null, requestStartTime = null, ttfbMs = null } = {}) {
  if (typeof onProviderResult !== "function") return;
  try {
    onProviderResult({
      provider,
      model,
      connectionId,
      endpoint,
      status: "error",
      http_status: Number.isFinite(httpStatus) ? httpStatus : null,
      // A plain object, not the Error: nothing downstream should hold a live stack, and
      // `{name, message}` is everything the failure taxonomy reads.
      error: error ? { name: error.name || null, message: error.message || String(error) } : null,
      headers: headers && typeof headers.get === "function" ? headers : null,
      ttfb_ms: Number.isFinite(ttfbMs) ? ttfbMs : null,
      total_ms: Number.isFinite(requestStartTime) ? Date.now() - requestStartTime : null,
      // Unavailable, not zero. See property 3 above.
      usage: null,
    });
  } catch {
    /* ignored on purpose: an observation may never fail a request */
  }
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", silent = false, onProviderResult = null }) {
  // M2 observation side channel: a fire-and-forget notification carrying the usage the
  // provider reported. It cannot change routing, it runs *above* the early returns below
  // so a zero-token or failed attempt is still observed, and its failure is swallowed --
  // observation must never fail a completion.
  if (typeof onProviderResult === "function") {
    try {
      onProviderResult({ provider, model, usage: tokens, connectionId, endpoint });
    } catch {
      /* ignored on purpose */
    }
  }

  if (!tokens || typeof tokens !== "object") return;

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0) return;

  if (!silent) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null
  }).catch(() => {});
}
