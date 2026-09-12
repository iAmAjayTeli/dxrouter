/**
 * Advisory per-session write lock (§12.2).
 *
 * One writer per session, using the two columns `sessions.lock_owner` / `lock_at`
 * that M0 already created. No external locking dependency, as §11 requires — and no
 * read-then-write either: acquisition is a *single conditional UPDATE*, so two
 * processes racing for the same session cannot both believe they won. The condition
 * carries the whole policy:
 *
 *   lock_owner IS NULL            free
 *   lock_owner = :owner           already ours (re-entrant within a process)
 *   lock_at <= :staleCutoff       abandoned by a dead writer, takeover permitted
 *
 * A crashed process leaves a lock behind forever otherwise, which would silently turn
 * a session read-only; the 60 s stale window is what makes the failure self-healing.
 *
 * If the lock cannot be taken inside the budget (250 ms), the caller does NOT block
 * and does NOT skip the turn: §12.2 says it proceeds with its identity confidence
 * degraded one step and the label `identity-degraded-by-lock`. Degrading is the
 * conservative direction — it can only make a later milestone claim *less* about a
 * warm prefix, never more.
 *
 * Pure with respect to time and identity: `now` and `owner` are injected. `sleep` is
 * injected too, so the concurrency tests do not have to spend real milliseconds — and
 * because the clock is injected, the retry loop is bounded by an attempt count as well
 * as by elapsed time. A frozen clock (a test one, or a coarse platform timer that does
 * not tick inside the budget) must still terminate; a lock loop that can spin forever
 * would hang a request, which is the one failure an observation path may never cause.
 */

import { DEFAULT_SESSION_POLICY } from "./policy.js";

/** Owner token shape: `<pid>:<tag>`. The pid is host knowledge, so it is passed in. */
export function formatLockOwner(pid, tag) {
  const safeTag = String(tag ?? "dxr").replace(/[^A-Za-z0-9._-]/g, "");
  return `${pid}:${safeTag}`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One acquisition attempt. Returns what actually happened, read back from the row
 * rather than inferred from a driver-specific `changes` count.
 *
 * @returns {{acquired: boolean, took_over: boolean, held_by: string|null}}
 */
export function tryAcquireSessionLock(db, { sessionId, owner, now, policy = DEFAULT_SESSION_POLICY }) {
  const staleCutoff = now - policy.lockStaleMs;
  const before = db.get(`SELECT lock_owner, lock_at, closed_at FROM sessions WHERE id = ?`, [sessionId]) ?? null;

  db.run(
    `UPDATE sessions
        SET lock_owner = ?, lock_at = ?
      WHERE id = ?
        AND closed_at IS NULL
        AND (lock_owner IS NULL OR lock_owner = ? OR lock_at IS NULL OR lock_at <= ?)`,
    [owner, now, sessionId, owner, staleCutoff],
  );

  const after = db.get(`SELECT lock_owner FROM sessions WHERE id = ?`, [sessionId]) ?? null;
  const acquired = !!after && after.lock_owner === owner;
  const tookOver =
    acquired && !!before?.lock_owner && before.lock_owner !== owner && Number.isInteger(before.lock_at)
      ? before.lock_at <= staleCutoff
      : false;

  return { acquired, took_over: tookOver, held_by: acquired ? owner : (after?.lock_owner ?? null) };
}

/**
 * Attempt acquisition repeatedly until the budget is spent.
 *
 * @param {object} args
 * @param {object} args.db store handle
 * @param {string} args.sessionId
 * @param {string} args.owner
 * @param {{now: () => number}} args.clock injected Clock port
 * @param {object} [args.policy]
 * @param {(ms:number)=>Promise<void>} [args.sleep]
 * @returns {Promise<{acquired: boolean, took_over: boolean, attempts: number,
 *                    waited_ms: number, held_by: string|null}>}
 */
export async function acquireSessionLock({
  db,
  sessionId,
  owner,
  clock,
  policy = DEFAULT_SESSION_POLICY,
  sleep = defaultSleep,
}) {
  const started = clock.now();
  const maxAttempts = Math.max(1, Math.ceil(policy.lockAcquireBudgetMs / Math.max(1, policy.lockRetryDelayMs)) + 1);
  let attempts = 0;
  let last = { acquired: false, took_over: false, held_by: null };

  for (;;) {
    attempts += 1;
    last = tryAcquireSessionLock(db, { sessionId, owner, now: clock.now(), policy });
    if (last.acquired) break;
    if (attempts >= maxAttempts) break;
    const elapsed = clock.now() - started;
    if (elapsed + policy.lockRetryDelayMs > policy.lockAcquireBudgetMs) break;
    await sleep(policy.lockRetryDelayMs);
  }

  return { ...last, attempts, waited_ms: clock.now() - started };
}

/** Release, but only if we still hold it: a stale takeover must not be undone. */
export function releaseSessionLock(db, { sessionId, owner }) {
  db.run(`UPDATE sessions SET lock_owner = NULL, lock_at = NULL WHERE id = ? AND lock_owner = ?`, [sessionId, owner]);
}

/**
 * Sweeper duty: clear locks older than the stale window on still-open sessions.
 * Returns the ids cleared, so the sweep can be reported rather than assumed.
 */
export function releaseStaleLocks(db, { now, policy = DEFAULT_SESSION_POLICY }) {
  const cutoff = now - policy.lockStaleMs;
  const rows =
    db.all(`SELECT id FROM sessions WHERE closed_at IS NULL AND lock_owner IS NOT NULL AND lock_at <= ?`, [cutoff]) || [];
  if (rows.length) {
    db.run(
      `UPDATE sessions SET lock_owner = NULL, lock_at = NULL
        WHERE closed_at IS NULL AND lock_owner IS NOT NULL AND lock_at <= ?`,
      [cutoff],
    );
  }
  return rows.map((r) => r.id);
}

export default acquireSessionLock;
