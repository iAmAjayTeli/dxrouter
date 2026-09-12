/**
 * Port: `Clock` — §11.3.
 *
 * Injected so `decide()` stays pure (I6). A decision that reads `Date.now()`
 * directly is untestable and unreproducible: replaying a fixture would produce a
 * different WAIT arithmetic than the run being explained.
 */

import { PortContractError } from "./normalizedRequest.js";

function fail(message) {
  throw new PortContractError(message, { port: "Clock" });
}

/** @param {{now: () => number}} impl */
export function defineClock(impl) {
  if (!impl || typeof impl.now !== "function") fail("a Clock must expose now()");
  return Object.freeze({
    now: () => {
      const t = impl.now();
      if (typeof t !== "number" || !Number.isFinite(t)) fail("Clock.now() must return epoch milliseconds");
      return t;
    },
  });
}

/** Real time. The only place `Date.now()` is allowed on the engine side. */
export const systemClock = defineClock({ now: () => Date.now() });

/** Deterministic clock for tests and fixture replay. */
export function fixedClock(startMs = 0) {
  let t = startMs;
  return Object.freeze({
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    set: (ms) => {
      t = ms;
      return t;
    },
  });
}

export { PortContractError };
