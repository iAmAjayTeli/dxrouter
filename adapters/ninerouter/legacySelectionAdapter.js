/**
 * `legacySelectionAdapter` — reads the *existing* account walk in the port's
 * vocabulary (§14).
 *
 * ### What this is for
 *
 * `src/sse/handlers/chat.js` picks an account with a `while (true)` loop over
 * `getProviderCredentials(provider, excludeConnectionIds, model)`, excluding a
 * connection each time one fails. That loop is, and in M0 remains, the authority.
 *
 * Shadow mode (M3) has to answer one question: *would the engine have chosen what
 * the legacy walk actually chose?* Answering it requires the walk's choices in the
 * same vocabulary the engine speaks — `Route`s and error classes, not credential
 * objects. That translation is this file. Building it now, against the walk as it
 * exists, means M3 is a wiring change rather than an archaeology project.
 *
 * ### What this is NOT
 *
 * - Not a replacement for `accountFallback` / `getProviderCredentials`. M0 is
 *   explicit: do not replace the walk, do not call the decision engine from the
 *   live request path.
 * - Not wired. Nothing in `src/` or `open-sse/` imports this file, by design.
 * - Not a writer. The recorder keeps its observations in memory and hands them
 *   back; persisting a comparison is M3's job, and M0's store is a container only.
 *
 * It is therefore passive by construction: every function here takes what the walk
 * already computed and returns a frozen value. None of them can change a routing
 * outcome, which is what makes attaching it later a safe change.
 */

import { createRoute } from "../../continuity/ports/routeExecutor.js";
import { systemClock } from "../../continuity/ports/clock.js";

/** How a single pass of the legacy walk ended. */
export const LEGACY_OUTCOMES = Object.freeze([
  "selected", // an account was handed to handleChatCore
  "failed", // the attempt errored and the connection was excluded
  "exhausted", // no more accounts; the walk returned an error response
  "all_rate_limited", // getProviderCredentials reported every account limited
  "no_credentials", // provider has no active connection at all
]);

/**
 * The walk's chosen (provider, model, connection) as a port `Route`.
 *
 * `credentials.connectionId` is the walk's own identifier for the account, and the
 * same value the CredentialStore port hands out, so the two sides line up without
 * a lookup table.
 */
export function legacyRoute({ provider, model, credentials = null, connectionId = null } = {}) {
  return createRoute({
    provider,
    model,
    connection_id: connectionId ?? credentials?.connectionId ?? null,
  });
}

/**
 * 9Router surfaces failures as an HTTP status plus a message. The engine's taxonomy
 * is closed, so the mapping is explicit and unmapped statuses stay `unknown`
 * rather than becoming a plausible guess (I3).
 */
export function classifyLegacyFailure({ status = null, message = "" } = {}) {
  const s = Number(status);
  if (s === 429) return "rate_limit";
  if (s === 401 || s === 403) return "auth";
  if (s === 402) return "quota";
  if (s === 408 || s === 504) return "timeout";
  if (s === 400 || s === 422) return "schema";
  if (Number.isFinite(s) && s >= 500) return "server";
  const m = String(message || "").toLowerCase();
  if (m.includes("rate limit") || m.includes("too many requests")) return "rate_limit";
  if (m.includes("quota") || m.includes("insufficient")) return "quota";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (m.includes("unauthorized") || m.includes("invalid api key")) return "auth";
  return "unknown";
}

/** One observed pass of the walk. Frozen: an observation cannot be edited later. */
export function describeLegacyStep({
  outcome,
  provider,
  model,
  connectionId = null,
  attempt = 0,
  excluded = [],
  status = null,
  message = null,
  at = null,
}) {
  if (!LEGACY_OUTCOMES.includes(outcome)) {
    throw new Error(`unknown legacy outcome "${outcome}" — extend LEGACY_OUTCOMES deliberately`);
  }
  return Object.freeze({
    outcome,
    route: legacyRoute({ provider, model, connectionId }),
    attempt,
    // A copy: the walk mutates its own Set as it goes, and an observation that
    // changes after the fact is worthless for a shadow-mode diff.
    excluded: Object.freeze([...excluded]),
    error_class: outcome === "failed" || outcome === "all_rate_limited" ? classifyLegacyFailure({ status, message }) : null,
    status: status ?? null,
    message: message ? String(message).slice(0, 500) : null,
    at,
  });
}

/**
 * Collects the steps of one request's walk.
 *
 * Usage, when M3 wires it: construct per request, call `step()` at each pass, read
 * `steps()` / `chosen()` afterwards. In-memory only.
 *
 * @param {object} [deps]
 * @param {object} [deps.clock] the Clock port — never `Date.now()` directly (I6)
 */
export function createLegacySelectionRecorder({ clock = systemClock } = {}) {
  const steps = [];

  return Object.freeze({
    step(info) {
      const observed = describeLegacyStep({ ...info, attempt: steps.length, at: clock.now() });
      steps.push(observed);
      return observed;
    },
    /** The account the walk actually used, or `null` when it never got one. */
    chosen() {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].outcome === "selected") return steps[i].route;
      }
      return null;
    },
    /** Connections the walk burned before succeeding — the cost of not deciding. */
    burned() {
      return steps.filter((s) => s.outcome === "failed").map((s) => s.route.connection_id).filter(Boolean);
    },
    steps() {
      return Object.freeze([...steps]);
    },
  });
}

export default createLegacySelectionRecorder;
