/**
 * `adapters/ninerouter` — the only bilingual layer in the codebase (§11.4).
 *
 * Everything here may import from `src/`, `open-sse/` *and* `continuity/ports/`.
 * Nothing in `continuity/` may import anything from here — that direction is the
 * one CI enforces (`scripts/check-import-boundary.mjs`), because it is the one that
 * would quietly turn the engine back into a 9Router-shaped thing.
 *
 * M0 wired the ports and proved they work without putting them on the request path.
 * M1 adds exactly one live call — `sessionObserver`, which observes and persists a
 * turn and returns nothing routable. The DXR engine is still OFF and
 * `accountFallback` remains authoritative.
 */

export { normalizeRequest, toProtocol, PROTOCOL_BY_FORMAT, NormalizeAdapterError } from "./normalizeAdapter.js";
export {
  createExecutorAdapter,
  attachHostRequest,
  getHostRequest,
  classifyStatus,
  classifyThrown,
  parseRetryAfter,
  normalizeUsage,
  extractReportedModel,
  ExecutorAdapterError,
} from "./executorAdapter.js";
export {
  createCredentialAdapter,
  loadConnectionSnapshot,
  toDescriptor,
  toCredentials,
  toEpochMs,
} from "./credentialAdapter.js";
export {
  createCatalogAdapter,
  buildModelDescriptors,
  describeProviderModels,
  catalogVersionOf,
} from "./catalogAdapter.js";
export { createClockAdapter, createOffsetClock } from "./clockAdapter.js";
export {
  createLegacySelectionRecorder,
  describeLegacyStep,
  classifyLegacyFailure,
  legacyRoute,
  LEGACY_OUTCOMES,
} from "./legacySelectionAdapter.js";
export {
  observeNormalizedTurn,
  sweepContinuity,
  toObservationRequest,
  resolveObserverEnv,
} from "./sessionObserver.js";
export {
  getContinuityStore,
  openContinuityAdapter,
  createContinuityBackup,
  CONTINUITY_FILE,
  __resetContinuityStore,
} from "./continuityDb.js";
