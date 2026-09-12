/**
 * App-side session observation (M1).
 *
 * The request path calls exactly one function from here, `observeChatTurn`, and it is
 * a *side channel*: it returns nothing the handler uses, it cannot fail the request,
 * and it never delays the upstream call. Legacy 9Router routing — combo expansion,
 * `accountFallback`, retries, provider selection — is untouched and remains
 * authoritative (§12).
 *
 * Three guards, in order:
 *
 *   1. the `sessions` flag (`DXR_SESSIONS`, on by default; `off` is the M1 rollback);
 *   2. a try/catch around normalization, so a body shape nobody anticipated cannot
 *      throw inside a live completion;
 *   3. fire-and-forget scheduling, so neither a SQLite write nor a 250 ms advisory
 *      lock wait can appear in a user-visible latency number.
 *
 * The store is memoised on `global` (like `src/lib/db/driver.js`) so Next.js dev
 * hot-reload does not open a second handle on the same file.
 */

import { normalizeRequest } from "../../../adapters/ninerouter/normalizeAdapter.js";
import {
  observeNormalizedTurn,
  resolveObserverEnv,
  sweepContinuity,
} from "../../../adapters/ninerouter/sessionObserver.js";
import { getContinuityStore } from "../../../adapters/ninerouter/continuityDb.js";
import { createClockAdapter } from "../../../adapters/ninerouter/clockAdapter.js";
import { getFlags } from "./flags.js";
import { rememberTurn } from "./cache.js";

if (!global._dxrSessions) global._dxrSessions = { lastSweepAt: 0, warned: false, inFlight: 0 };
const state = global._dxrSessions;

/** Observation is on unless an operator turned it off. */
export function sessionsEnabled(flags = getFlags()) {
  return flags?.sessions !== false;
}

function warnOnce(message) {
  if (state.warned) return;
  state.warned = true;
  console.warn(`[DXR][sessions] ${message}`);
}

/**
 * Housekeeping, at most once per `sweepIntervalMs` per process.
 *
 * Piggy-backing on request traffic rather than owning a timer: an idle router does not
 * need to close idle sessions promptly, and the sweep is idempotent, so "eventually,
 * when something happens" is the right cadence for it.
 */
async function maybeSweep({ env, clock }) {
  const { policy } = resolveObserverEnv(env);
  const now = clock.now();
  if (state.lastSweepAt && now - state.lastSweepAt < policy.sweepIntervalMs) return null;
  state.lastSweepAt = now;
  return sweepContinuity({ env, clock });
}

/**
 * Observe one chat turn. Fire-and-forget, never throws, returns immediately.
 *
 * @param {object} args
 * @param {object} args.body the parsed client body
 * @param {*} [args.headers] Headers instance or plain object
 * @param {string} [args.pathname]
 * @param {string} [args.format] 9Router format when already detected
 * @param {boolean} [args.wait] await the write instead of scheduling it (tests)
 * @param {object} [args.retain] the live request object, for M2 result correlation
 * @returns {Promise<object|null>|null} the observation when `wait`, else null
 */
export function observeChatTurn({ body, headers = null, pathname = "", format = null, wait = false, retain = null } = {}) {
  if (!sessionsEnabled()) return null;

  let normalized;
  try {
    const { projectRoot } = resolveObserverEnv(process.env);
    normalized = normalizeRequest({
      body,
      headers,
      pathname,
      format,
      projectRoot,
      arrivedAt: createClockAdapter().now(),
    });
  } catch (e) {
    // A body the normalizer rejects is not an error the client should hear about: the
    // request is still perfectly routable by the legacy path.
    warnOnce(`normalize skipped: ${e?.message || e}`);
    return null;
  }

  const run = async () => {
    const clock = createClockAdapter();
    const record = await observeNormalizedTurn({ normalized, env: process.env, clock });
    await maybeSweep({ env: process.env, clock }).catch(() => null);
    return record;
  };

  // M2 correlation (§12): the observation is filed under the live request object so a
  // provider result, which arrives several frames later, can find the turn it belongs to.
  // Storing a promise is not awaiting one — this call remains a dead end either way.
  if (wait) {
    const pending = run();
    if (retain) rememberTurn(retain, pending);
    return pending;
  }

  state.inFlight += 1;
  // Deliberately not awaited: observation must not sit between the client and the
  // upstream call. `observeNormalizedTurn` already swallows its own failures; this
  // catch is the last resort for a rejection thrown outside it.
  const pending = run();
  if (retain) rememberTurn(retain, pending);
  pending
    .catch((e) => warnOnce(`observation skipped: ${e?.message || e}`))
    .finally(() => {
      state.inFlight -= 1;
    });
  return null;
}

/** Read access for the CLI and future dashboard panels. Never used for routing. */
export async function getSessionStore() {
  return getContinuityStore();
}

/** Test seam: forget the sweep throttle and the one-shot warning. */
export function __resetSessionObservation() {
  state.lastSweepAt = 0;
  state.warned = false;
  state.inFlight = 0;
}

export default observeChatTurn;
