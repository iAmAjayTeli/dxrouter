/**
 * `executorAdapter` — `RouteExecutor` port over 9Router's executor layer (§11.2).
 *
 * The outbound half of the bilingual layer. The engine hands over a `Route` and a
 * `NormalizedRequest`; this file turns that into `getExecutor(provider).execute()`,
 * and turns the fetch `Response` back into the port's `ExecutionResult`.
 *
 * M0 status: implemented and tested, NOT called from the request path (§14).
 *
 * §11.4 forbids this adapter from *deciding* anything: no account walk, no
 * fallback, no retry across connections. It performs exactly the one attempt the
 * engine asked for and reports what happened. Retry inside `BaseExecutor.execute`
 * (URL fallbacks, 429 backoff) is the inherited transport's business and stays
 * where it is.
 *
 * ### Why the provider body arrives out-of-band
 *
 * `NormalizedRequest` deliberately discards the provider wire format — that is the
 * point of the port. But the executor needs a body in the *upstream's* dialect,
 * produced by `open-sse/translator`. Rather than smuggle a provider-shaped field
 * into the port (which would leak a 9Router format into `continuity/`, breaking
 * I1's spirit), the host attaches the translated body to the request object
 * side-channel with `attachHostRequest()`. The engine never sees it; only the two
 * halves of this adapter do.
 */

import { getExecutor } from "open-sse/executors/index.js";
import { defineRouteExecutor } from "../../continuity/ports/routeExecutor.js";
import { systemClock } from "../../continuity/ports/clock.js";
import { classifyStatus, classifyThrown, parseRetryAfter } from "./failureFields.js";
import { normalizeUsage, extractReportedModel } from "./usageFields.js";

/**
 * Per-request provider payload, keyed on the NormalizedRequest identity. A WeakMap
 * so nothing here extends the lifetime of a request body.
 */
const HOST_REQUESTS = new WeakMap();

/**
 * Attach the translated, provider-format body that belongs to `req`.
 *
 * @param {object} req a NormalizedRequest
 * @param {{body: object, stream?: boolean, proxyOptions?: object|null}} hostRequest
 */
export function attachHostRequest(req, hostRequest) {
  if (!req || typeof req !== "object") {
    throw new ExecutorAdapterError("attachHostRequest requires the NormalizedRequest it belongs to");
  }
  if (!hostRequest || typeof hostRequest.body !== "object" || hostRequest.body === null) {
    throw new ExecutorAdapterError("attachHostRequest requires { body } in the provider's format");
  }
  HOST_REQUESTS.set(req, hostRequest);
  return req;
}

/** @returns {object|undefined} */
export function getHostRequest(req) {
  return HOST_REQUESTS.get(req);
}

export class ExecutorAdapterError extends Error {
  constructor(message, { code = "EXECUTOR_ADAPTER_FAILED" } = {}) {
    super(message);
    this.name = "ExecutorAdapterError";
    this.code = code;
  }
}

/**
 * The failure taxonomy and the retry-hint reader live in `failureFields.js` and are
 * re-exported here, unchanged, so this module's port surface is what it always was.
 *
 * They moved for the same reason `usageFields.js` did: this file imports
 * `open-sse/executors/index.js`, a bundler alias no bare-node process can resolve, and the
 * M2 cache observer now needs the same taxonomy to describe a failed attempt made on the
 * inherited path. See that file's header.
 */
export { classifyStatus, classifyThrown, parseRetryAfter, describeFailure } from "./failureFields.js";

/**
 * Usage-field vocabulary and the reported-model reader live in `usageFields.js` and are
 * re-exported here, unchanged, so this module's port surface is what it always was.
 *
 * They moved because this file imports `open-sse/executors/index.js` — a bundler alias no
 * bare-node process can resolve — and the cache observer and the CLI's probe both need to
 * read a provider's usage without a transport attached. See that file's header.
 */
export { normalizeUsage, extractReportedModel, usageIsEstimated } from "./usageFields.js";

function isStreamContentType(response) {
  const ct = response?.headers?.get?.("content-type") || "";
  return ct.includes("text/event-stream") || ct.includes("application/x-ndjson");
}

/**
 * Build a `RouteExecutor`.
 *
 * @param {object} deps
 * @param {object} deps.credentialStore the CredentialStore port; `get(id)` yields
 *   the single-use secret, which is passed straight to the executor and never held.
 * @param {(provider: string) => object} [deps.resolveExecutor] injectable for tests
 * @param {object} [deps.clock] the Clock port; used for latency and `retry_after_s`
 * @param {object} [deps.log] 9Router logger, passed through untouched
 */
export function createExecutorAdapter({
  credentialStore,
  resolveExecutor = getExecutor,
  clock = systemClock,
  log = null,
} = {}) {
  if (!credentialStore || typeof credentialStore.get !== "function") {
    throw new ExecutorAdapterError("createExecutorAdapter requires a CredentialStore port");
  }

  return defineRouteExecutor({
    async execute(route, req, signal) {
      const host = HOST_REQUESTS.get(req);
      if (!host) {
        throw new ExecutorAdapterError(
          "no provider body is attached to this NormalizedRequest — call attachHostRequest() first",
          { code: "MISSING_HOST_REQUEST" }
        );
      }

      const stream = host.stream === true;
      const startedAt = clock.now();
      // `await` because the host store is async; a sync store passes through
      // unchanged. Nothing here retains the secret past this call (§11.4).
      const credentials = route.connection_id ? await credentialStore.get(route.connection_id) : null;

      let executor;
      try {
        executor = resolveExecutor(route.provider);
      } catch (error) {
        throw new ExecutorAdapterError(
          `no executor for provider "${route.provider}": ${error.message}`,
          { code: "NO_EXECUTOR" }
        );
      }

      let response;
      try {
        const out = await executor.execute({
          model: route.model,
          body: host.body,
          stream,
          credentials,
          signal,
          log,
          proxyOptions: host.proxyOptions ?? null,
        });
        response = out?.response ?? out;
      } catch (error) {
        // A thrown transport error is a result, not an exception, as far as the
        // engine is concerned: it must be able to record the attempt.
        return {
          status: 0,
          ok: false,
          error_class: classifyThrown(error),
          error_message: error?.message || String(error),
          retry_after_s: null,
          usage: null,
          reported_model: null,
          stream: null,
          latency_ms: clock.now() - startedAt,
        };
      }

      const status = typeof response?.status === "number" ? response.status : 0;
      const ok = status >= 200 && status < 300;
      const error_class = classifyStatus(status);
      const retry_after_s = parseRetryAfter(response?.headers, { now: clock.now() });
      const latency_ms = clock.now() - startedAt;

      // A streaming success is handed back unread. Usage and the reported model
      // arrive inside the stream, and consuming it here would break the response
      // the caller has to forward. Reading them out of a stream is M1 work.
      if (ok && (stream || isStreamContentType(response))) {
        return {
          status,
          ok,
          error_class: null,
          error_message: null,
          retry_after_s,
          usage: null,
          reported_model: null,
          stream: response.body ?? null,
          latency_ms,
        };
      }

      let payload = null;
      let text = null;
      try {
        text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      return {
        status,
        ok,
        error_class,
        error_message: ok ? null : errorMessageFrom(payload, text, status),
        retry_after_s,
        usage: ok ? normalizeUsage(payload) : null,
        reported_model: extractReportedModel(payload),
        stream: null,
        latency_ms,
      };
    },
  });
}

function errorMessageFrom(payload, text, status) {
  const m =
    payload?.error?.message ||
    payload?.error?.msg ||
    (typeof payload?.error === "string" ? payload.error : null) ||
    payload?.message ||
    null;
  if (typeof m === "string" && m) return m.slice(0, 500);
  if (typeof text === "string" && text) return text.slice(0, 500);
  return `HTTP ${status}`;
}

export default createExecutorAdapter;
