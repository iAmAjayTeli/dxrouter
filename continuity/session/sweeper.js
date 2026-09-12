/**
 * Sweeper — the only component permitted to mutate a closed session (§4.3), and the
 * one that makes idle sessions, abandoned locks and old turns disappear on their own.
 *
 * Six duties, deliberately independent so a failure in one still lets the others run
 * and so each is separately testable:
 *
 *   1. idle close        an open session silent longer than the idle timeout is closed
 *                        with `idle_timeout`
 *   2. stale locks       a lock older than the 60 s stale window is cleared
 *   3. orphan close      an open session with no turns and no prefix state, older than
 *                        the idle window, is closed with `swept`
 *   4. retention         turns older than 30 days are deleted, then sessions closed
 *                        longer ago than the session retention window
 *   5. cache expiry      a cache entry is removed one grace hour after `written_at +
 *                        ttl_s` (§12.3). Not before: an expired row is still the record
 *                        of a write that happened, and an operator debugging a cold
 *                        route needs to see that it was ever warm
 *   6. result retention  `turn_results` older than the result retention window go the
 *                        same way M1 turns do
 *
 * The close reason is never null (§5) and never invented: `idle_timeout` means the
 * clock said so, `swept` means the row was structurally incomplete. Neither is ever
 * recorded as a prefix discontinuity, because the ratio between compaction and
 * discontinuity closes is the evidence Open Question Q5 depends on, and padding it
 * with janitorial closes would corrupt that evidence.
 *
 * Time is injected. The sweeper never sets a timer itself — the host decides when to
 * call it (on start and hourly), because a timer is host lifecycle, not engine logic.
 */

import { DEFAULT_CACHE_POLICY } from "../cache/policy.js";
import { CLOSE_REASON, isIdle } from "./lifecycle.js";
import { releaseStaleLocks } from "./locks.js";
import { DEFAULT_SESSION_POLICY } from "./policy.js";

const DAY_MS = 86400000;

/**
 * @param {object} args
 * @param {object} args.store openContinuityStore output
 * @param {{now: () => number}} args.clock
 * @param {object} [args.policy]
 * @param {object} [args.cachePolicy]
 * @returns {{at: number, idle_closed: string[], swept: string[], locks_released: string[],
 *            turns_deleted: number, sessions_deleted: number, cache_entries_deleted: number,
 *            turn_results_deleted: number}}
 */
export function sweepSessions({ store, clock, policy = DEFAULT_SESSION_POLICY, cachePolicy = DEFAULT_CACHE_POLICY }) {
  const { db, sessions, turns } = store;
  const now = clock.now();

  const result = {
    at: now,
    idle_closed: [],
    swept: [],
    locks_released: [],
    turns_deleted: 0,
    sessions_deleted: 0,
    cache_entries_deleted: 0,
    turn_results_deleted: 0,
  };

  // 1 + 3. Idle and orphan closes. One pass over the same candidate set: a session is
  // only examined at all once it has been silent for the idle window, so a live
  // conversation is never touched by either rule.
  const idleCandidates = sessions.listIdleOpenSessions(db, now - policy.idleTimeoutMs);
  for (const session of idleCandidates) {
    if (!isIdle(session, now, policy)) continue;
    const hasTurns = turns.countTurns(db, session.id) > 0;
    const reason = hasTurns ? CLOSE_REASON.IDLE_TIMEOUT : CLOSE_REASON.SWEPT;
    db.transaction(() => {
      sessions.closeSession(db, { id: session.id, closed_at: now, close_reason: reason });
    });
    if (hasTurns) result.idle_closed.push(session.id);
    else result.swept.push(session.id);
  }

  // 2. Abandoned locks on sessions that are still open and still being used.
  result.locks_released = releaseStaleLocks(db, { now, policy });

  // 4. Retention. Turns first: they are the bulk, and deleting a session cascades to
  // its turns anyway, so doing it in this order never leaves an orphan turn.
  db.transaction(() => {
    const before = turns.countAllTurns(db);
    turns.deleteTurnsBefore(db, now - policy.turnRetentionDays * DAY_MS);
    result.turns_deleted = before - turns.countAllTurns(db);

    const sessionsBefore = sessions.countSessions(db);
    sessions.deleteSessionsClosedBefore(db, now - policy.sessionRetentionDays * DAY_MS);
    result.sessions_deleted = sessionsBefore - sessions.countSessions(db);
  });

  // 5 + 6. The M2 tables. Guarded on presence rather than assumed: a store opened
  // before migration 003 has no `cache_entries`, and a sweeper that threw there would
  // take the four M1 duties down with it.
  if (store.cache && store.turnResults) {
    db.transaction(() => {
      result.cache_entries_deleted = store.cache.deleteExpiredCacheEntries(db, now, {
        graceMs: cachePolicy.expiryGraceMs,
      });
      const resultsBefore = store.turnResults.countTurnResults(db);
      store.turnResults.deleteTurnResultsBefore(db, now - cachePolicy.resultRetentionDays * DAY_MS);
      result.turn_results_deleted = resultsBefore - store.turnResults.countTurnResults(db);
    });
  }

  return result;
}

export default sweepSessions;
