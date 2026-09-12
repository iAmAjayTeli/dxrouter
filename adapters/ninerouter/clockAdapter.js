/**
 * `clockAdapter` — `Clock` port (§11.3).
 *
 * Thin on purpose. The port already ships `systemClock`; this file exists so the
 * host wires *one* named thing per port and so there is a single place to change
 * if 9Router ever needs a monotonic or offset-corrected time source.
 *
 * `decide()` is pure (I6), which is only true if it never reads the wall clock
 * itself. Every time value the engine sees comes through here.
 */

import { defineClock, systemClock } from "../../continuity/ports/clock.js";

/** Real time, for the running server. */
export function createClockAdapter() {
  return systemClock;
}

/**
 * A clock offset by a fixed amount. Not used in M0; it exists because the obvious
 * temptation later is to sprinkle `Date.now() + skew` at call sites instead.
 */
export function createOffsetClock(offsetMs = 0) {
  return defineClock({ now: () => Date.now() + offsetMs });
}

export default createClockAdapter;
