/**
 * The five §19.4 measures, and the name → function table `dxrouter measure` dispatches on.
 *
 * Registered by measure name so a measure that answers no numbered question cannot be run:
 * `questionForMeasure` is what `buildExperimentRow` consults, and it throws for an
 * unnamed measure. The list and §23 therefore stay in step by construction.
 */

import { measureArithmeticAccuracy } from "./arithmeticAccuracy.js";
import { measureCacheProbe } from "./cacheProbe.js";
import { measureCoverage } from "./coverage.js";
import { measurePrefixStability } from "./prefixStability.js";
import { measureReturnRate } from "./returnRate.js";

/** Measures that need real provider requests. Kept as data so a host can warn first. */
export const LIVE_MEASURES = Object.freeze(["cache_probe"]);

/**
 * Measures that can read replayed fixtures.
 *
 * Not "instead of persisted rows": `prefix_stability` reduces either observed M1 sessions
 * or fixtures, and reports which it was. `arithmetic_accuracy` is the one that has no other
 * input, because a predicted-versus-reported comparison needs a fixture's declared
 * expectation to compare against.
 */
export const REPLAY_MEASURES = Object.freeze(["prefix_stability", "arithmetic_accuracy"]);

export const MEASURES = Object.freeze({
  cache_probe: measureCacheProbe,
  coverage: measureCoverage,
  prefix_stability: measurePrefixStability,
  return_rate: measureReturnRate,
  arithmetic_accuracy: measureArithmeticAccuracy,
});

export const MEASURE_NAMES = Object.freeze(Object.keys(MEASURES));

export function isMeasure(name) {
  return Object.hasOwn(MEASURES, String(name ?? ""));
}

export {
  measureArithmeticAccuracy,
  measureCacheProbe,
  measureCoverage,
  measurePrefixStability,
  measureReturnRate,
};

// Re-exported from the barrel deliberately: `planProbe` is how a host states the request
// count and the money before the probe sends anything, and a cost warning nobody can
// import through the package entry point is a cost warning that will not be shown.
export { planProbe, probeFiller } from "./cacheProbe.js";
