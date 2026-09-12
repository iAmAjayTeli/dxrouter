/**
 * The five ports (§11). This is the entire surface the engine may depend on.
 *
 * If something in `continuity/` appears to need more than what is re-exported
 * here, the correct move is to widen a port — a reviewable change — not to import
 * from `src/` or `open-sse/`. That import is an invariant breach (I1) and CI fails
 * on it (scripts/check-import-boundary.mjs).
 */

export {
  PROTOCOLS,
  PortContractError,
  createNormalizedRequest,
  isNormalizedRequest,
} from "./normalizedRequest.js";

export {
  ERROR_CLASSES,
  assertExecutionResult,
  createRoute,
  defineRouteExecutor,
} from "./routeExecutor.js";

export { createConnectionDescriptor, defineCredentialStore } from "./credentialStore.js";
export { createModelDescriptor, defineCatalog } from "./catalog.js";
export { defineClock, fixedClock, systemClock } from "./clock.js";

/** Names of the five ports, for docs, tests and the boundary check. */
export const PORTS = Object.freeze([
  "NormalizedRequest",
  "RouteExecutor",
  "CredentialStore",
  "Catalog",
  "Clock",
]);
