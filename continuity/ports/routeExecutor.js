/**
 * Port: `RouteExecutor` (outbound) — §11.2.
 *
 * The engine's only way to reach a provider. `executorAdapter` implements it over
 * the inherited executor + translator layer; the engine knows nothing about URLs,
 * headers, SSE framing or provider quirks.
 *
 * `reported_model` is mandatory in the contract even when a provider omits it
 * (then `null`). It is the hook for silent-substitution detection, and making it
 * optional now would mean an adapter change later to get it back.
 */

import { PortContractError } from "./normalizedRequest.js";

/** Exhaustive error taxonomy. Anything unmapped is `unknown`, never invented. */
export const ERROR_CLASSES = Object.freeze([
  "rate_limit",
  "auth",
  "quota",
  "timeout",
  "schema",
  "server",
  "unknown",
]);

function fail(message, field) {
  throw new PortContractError(message, { port: "RouteExecutor", field });
}

/**
 * A route is the (provider, model, connection) triple the engine chose. The
 * connection id is opaque to the engine — it comes from the CredentialStore port
 * and goes straight back to the adapter.
 */
export function createRoute({ provider, model, connection_id = null } = {}) {
  if (typeof provider !== "string" || !provider) fail("route.provider must be a non-empty string", "provider");
  if (typeof model !== "string" || !model) fail("route.model must be a non-empty string", "model");
  return Object.freeze({ provider, model, connection_id });
}

/** Validate an ExecutionResult coming back from an adapter. */
export function assertExecutionResult(result) {
  if (!result || typeof result !== "object") fail("ExecutionResult must be an object");
  if (typeof result.status !== "number") fail("ExecutionResult.status must be a number", "status");
  if (result.usage !== null && result.usage !== undefined && typeof result.usage !== "object") {
    fail("ExecutionResult.usage must be an object or null", "usage");
  }
  if (result.error_class !== null && result.error_class !== undefined && !ERROR_CLASSES.includes(result.error_class)) {
    fail(`unknown error_class "${result.error_class}"`, "error_class");
  }
  if (!("reported_model" in result)) {
    fail("ExecutionResult.reported_model is mandatory (use null when the provider omits it)", "reported_model");
  }
  return result;
}

/**
 * Wrap an implementation so the port's shape is checked once, at wiring time,
 * instead of at the first failing request.
 *
 * @param {{execute: (route: object, req: object, signal?: AbortSignal) => Promise<object>}} impl
 */
export function defineRouteExecutor(impl) {
  if (!impl || typeof impl.execute !== "function") {
    fail("a RouteExecutor must expose execute(route, req, signal)");
  }
  return Object.freeze({
    async execute(route, req, signal) {
      const result = await impl.execute(route, req, signal);
      return assertExecutionResult(result);
    },
  });
}

export { PortContractError };
