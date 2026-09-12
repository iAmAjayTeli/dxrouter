/**
 * `probeExecutor` — a deliberately minimal `RouteExecutor`, built only for `cache_probe`.
 *
 * `cache_probe` is the one measure that sends real requests, and until now no host could
 * give it an executor: `executorAdapter` needs the `open-sse` bundler alias, which bare node
 * cannot resolve, so the CLI reported `no_executor` and the probe never ran. That made the
 * §23 gate name a measurement nobody could take.
 *
 * This file closes that gap with the smallest thing that can honestly be called an
 * executor, and it is separate from `executorAdapter` on purpose:
 *
 *  - **The operator names the endpoint and the key.** `baseUrl` comes from `--base-url` or
 *    `DXR_PROBE_BASE_URL`; the key comes from an environment variable the operator names
 *    with `--api-key-env`. It reads **no stored 9Router credential**, so probing cannot
 *    quietly spend a connection the operator set up for something else, and there is no
 *    path here that could exfiltrate one.
 *  - **Documented endpoints only.** Two protocols, both the vendors' public chat APIs. No
 *    private endpoint, no subscription-only path, no header that impersonates a client.
 *  - **No translator, no streaming, no retries.** A probe is two small non-streaming calls
 *    with a fixed body. Reusing the routing stack would put probe traffic through combo
 *    expansion and account fallback, which is exactly what a cache measurement must not do.
 *
 * The Anthropic path sets `cache_control: {type: "ephemeral"}` on the system block, because
 * that provider caches nothing without an explicit breakpoint — a probe without it would
 * measure the absence of our own marker and report it as the provider not caching.
 *
 * Returns `null` when it has not been told enough to send anything, so the caller reports
 * `no_executor` rather than half-building one.
 */

import { defineRouteExecutor } from "../../continuity/ports/routeExecutor.js";
import { normalizeUsage, extractReportedModel } from "./usageFields.js";

/** The two request shapes a probe needs. Adding a third is a deliberate act, not a default. */
export const PROBE_PROTOCOLS = Object.freeze(["openai", "anthropic"]);

const DEFAULT_TIMEOUT_MS = 120_000;
const ANTHROPIC_VERSION = "2023-06-01";

/** Loopback may be plain http (a local proxy); anything else must be TLS. */
export function assertSafeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`probe base URL must be https (got ${url.protocol}//${url.hostname})`);
  }
  return url;
}

/** `https://api.x.com/v1` + `/chat/completions` without doubling or dropping a slash. */
function join(baseUrl, suffix) {
  return `${String(baseUrl).replace(/\/+$/, "")}${suffix}`;
}

function classifyStatus(status) {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 408 || status === 504) return "timeout";
  if (status === 400 || status === 422) return "schema";
  if (status >= 500) return "server";
  return status >= 200 && status < 300 ? null : "unknown";
}

/** The provider-shaped body for one probe request. Filler only; never user material. */
export function buildProbeBody({ protocol, model, system, messages, maxTokens = 16 }) {
  if (protocol === "anthropic") {
    return {
      model,
      max_tokens: maxTokens,
      // The explicit breakpoint is the mechanism under test on this provider.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: [{ type: "text", text: String(m.content) }] })),
      stream: false,
    };
  }
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: String(m.content) }))],
    stream: false,
  };
}

function headersFor(protocol, apiKey) {
  const base = { "content-type": "application/json", accept: "application/json" };
  if (protocol === "anthropic") return { ...base, "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
  return { ...base, authorization: `Bearer ${apiKey}` };
}

const pathFor = (protocol) => (protocol === "anthropic" ? "/messages" : "/chat/completions");

/**
 * Build the probe executor, or `null` if the operator has not supplied what it needs.
 *
 * @param {object} args
 * @param {string|null} args.baseUrl provider base URL, e.g. `https://api.anthropic.com/v1`
 * @param {string|null} args.apiKeyEnv the *name* of the env var holding the key
 * @param {string} [args.protocol] `openai` | `anthropic`
 * @param {object} [args.env]
 * @param {typeof fetch} [args.fetchImpl] injected for tests; no test may reach the network
 * @param {number} [args.timeoutMs]
 * @param {(msg: string) => void} [args.warn]
 * @returns {{executor: object|null, reason: string|null, endpoint: string|null}}
 */
export function createProbeExecutor({
  baseUrl = null,
  apiKeyEnv = null,
  protocol = "openai",
  env = process.env,
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  warn = () => {},
} = {}) {
  const url = baseUrl || env.DXR_PROBE_BASE_URL || null;
  const keyName = apiKeyEnv || env.DXR_PROBE_API_KEY_ENV || null;
  if (!url) return { executor: null, reason: "no base URL: pass --base-url or set DXR_PROBE_BASE_URL", endpoint: null };
  if (!PROBE_PROTOCOLS.includes(protocol)) {
    return { executor: null, reason: `unknown probe protocol "${protocol}" (expected ${PROBE_PROTOCOLS.join(" | ")})`, endpoint: null };
  }
  if (!keyName) return { executor: null, reason: "no API key env var named: pass --api-key-env NAME", endpoint: null };
  // The key is read from the named variable, never from a stored connection and never
  // echoed: only its variable name appears in any output this function produces.
  const apiKey = env[keyName];
  if (typeof apiKey !== "string" || !apiKey) return { executor: null, reason: `${keyName} is not set in this environment`, endpoint: null };

  let endpoint;
  try {
    assertSafeBaseUrl(url);
    endpoint = join(url, pathFor(protocol));
  } catch (e) {
    return { executor: null, reason: e.message, endpoint: null };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { executor: null, reason: "no fetch implementation in this runtime", endpoint };

  const executor = defineRouteExecutor({
    async execute(route, req, signal) {
      const body = buildProbeBody({
        protocol,
        model: route.model,
        system: req.system,
        messages: req.messages ?? [],
        maxTokens: req.params?.max_tokens ?? 16,
      });

      let response = null;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: headersFor(protocol, apiKey),
          body: JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // A transport failure is a result: the probe records the attempt rather than
        // aborting the ladder halfway through a paid run.
        warn(`probe request failed: ${e?.message || e}`);
        return { status: 0, ok: false, error_class: "unknown", usage: null, reported_model: null, error_message: String(e?.message || e) };
      }

      const status = response.status;
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const ok = status >= 200 && status < 300;
      return {
        status,
        ok,
        error_class: classifyStatus(status),
        // `normalizeUsage` is the same field table the live observer uses, so a probe and
        // a real request agree about what a provider reported.
        usage: ok ? normalizeUsage(payload) : null,
        reported_model: extractReportedModel(payload),
        error_message: ok ? null : `HTTP ${status}`,
      };
    },
  });

  return { executor, reason: null, endpoint };
}

export default createProbeExecutor;
