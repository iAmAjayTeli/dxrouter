/**
 * Group G — concurrency (§14 G, §§11, 12.2).
 *
 * One writer per session, and the failure mode that matters is not a crash: it is a
 * second writer quietly believing it owns the session. So the tests check the *record*
 * as well as the outcome — a turn that could not take the lock must be graded one step
 * weaker and carry `identity-degraded-by-lock`, while the session row keeps the best
 * grade it ever earned. Contention may cost confidence; it may never rewrite history.
 *
 * The lock is the two `sessions.lock_owner` / `lock_at` columns and a single
 * conditional UPDATE — no external locking dependency (§11), which is also why these
 * tests can drive it directly by writing the columns a dead process would have left.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  acquireSessionLock,
  formatLockOwner,
  releaseSessionLock,
  releaseStaleLocks,
  tryAcquireSessionLock,
} from "../../continuity/session/locks.js";
import { DEFAULT_SESSION_POLICY, resolveSessionPolicy } from "../../continuity/session/policy.js";
import { IDENTITY_CONFIDENCE, M1_LABELS } from "../../continuity/identity/confidence.js";
import { observeTurn } from "../../continuity/session/observer.js";
import { messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

describe("G — concurrency", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });

  const harness = async () => {
    const h = await openHarness({ tag: "conc" });
    open.push(h);
    return h;
  };

  const lockRow = (h, id) => h.db.get("SELECT lock_owner, lock_at FROM sessions WHERE id = ?", [id]);
  const holdLock = (h, id, owner, at = h.at()) =>
    h.db.run("UPDATE sessions SET lock_owner = ?, lock_at = ? WHERE id = ?", [owner, at, id]);

  it("names its owner as pid:tag, sanitizing the tag", async () => {
    expect(formatLockOwner(1234, "dxr")).toBe("1234:dxr");
    expect(formatLockOwner(7, "a b/c;d")).toBe("7:abcd");
    expect(formatLockOwner(7, null)).toBe("7:dxr");
  });

  it("serial turns each take and release the lock", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g1" }));
    expect(lockRow(h, first.session_id)).toMatchObject({ lock_owner: null, lock_at: null });

    h.tick(1000);
    const second = await h.observe(turnRequest({ msgs: messages(3), key: "cc-g1" }));
    expect(second.lock).toMatchObject({ acquired: true, took_over: false });
    expect(second.identity_confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(second.labels).toEqual([]);
    expect(lockRow(h, first.session_id).lock_owner).toBeNull();
  });

  it("takes no lock on the turn that creates the session: nobody knows its id yet", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g2" }));
    expect(first.created_session).toBe(true);
    expect(first.lock).toBeNull();
  });

  it("is re-entrant for the same owner and exclusive against another", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g3" }));
    const id = r.session_id;

    const mine = tryAcquireSessionLock(h.db, { sessionId: id, owner: "1:test", now: h.at() });
    expect(mine).toMatchObject({ acquired: true, took_over: false, held_by: "1:test" });
    const again = tryAcquireSessionLock(h.db, { sessionId: id, owner: "1:test", now: h.at() + 1 });
    expect(again.acquired).toBe(true);

    const theirs = tryAcquireSessionLock(h.db, { sessionId: id, owner: "9:other", now: h.at() + 2 });
    expect(theirs).toMatchObject({ acquired: false, held_by: "1:test" });

    // A release by the wrong owner must be a no-op, or a stale takeover could be undone.
    releaseSessionLock(h.db, { sessionId: id, owner: "9:other" });
    expect(lockRow(h, id).lock_owner).toBe("1:test");
    releaseSessionLock(h.db, { sessionId: id, owner: "1:test" });
    expect(lockRow(h, id).lock_owner).toBeNull();
  });

  it("degrades confidence one step and labels the turn when the lock is held", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g4" }));
    holdLock(h, first.session_id, "9:other");
    h.tick(10);

    const contended = await h.observe(turnRequest({ msgs: messages(3), key: "cc-g4" }));
    expect(contended.session_id).toBe(first.session_id);
    expect(contended.lock.acquired).toBe(false);
    expect(contended.identity_confidence_resolved).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(contended.identity_confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(contended.labels).toEqual([M1_LABELS.IDENTITY_DEGRADED_BY_LOCK]);

    const row = h.db.get("SELECT identity_confidence, labels FROM turns WHERE session_id = ? AND idx = 1", [
      first.session_id,
    ]);
    expect(row.identity_confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(row.labels).toBe(M1_LABELS.IDENTITY_DEGRADED_BY_LOCK);
    // The session keeps the best grade it ever earned: contention costs this turn its
    // confidence, not the session its history.
    expect(h.db.get("SELECT identity_confidence FROM sessions WHERE id = ?", [first.session_id]).identity_confidence)
      .toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    // Someone else's lock is left exactly as it was found.
    expect(lockRow(h, first.session_id).lock_owner).toBe("9:other");
  });

  it("degrades to the floor and stops there", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1) }));
    holdLock(h, first.session_id, "9:other");
    h.tick(10);
    const contended = await h.observe(turnRequest({ msgs: messages(3) }));
    // An inferred turn that was already weak cannot fall below `unknown`.
    expect(contended.identity_confidence_resolved).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(contended.identity_confidence).toBe(IDENTITY_CONFIDENCE.WEAKLY_INFERRED);
    expect(contended.observed).toBe(true);
  });

  it("takes over a lock abandoned by a dead writer, after the stale window", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g5" }));
    holdLock(h, first.session_id, "9:crashed");

    // One millisecond before the window: still theirs.
    h.tick(DEFAULT_SESSION_POLICY.lockStaleMs - 1);
    const early = await h.observe(turnRequest({ msgs: messages(3), key: "cc-g5" }));
    expect(early.lock).toMatchObject({ acquired: false, took_over: false });

    // Past it: taken over, and the takeover is recorded rather than silent.
    h.tick(2);
    const late = await h.observe(turnRequest({ msgs: messages(5), key: "cc-g5" }));
    expect(late.lock).toMatchObject({ acquired: true, took_over: true });
    expect(late.notes).toContain("stale_lock_taken_over");
    expect(late.identity_confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(late.labels).toEqual([]);
    expect(lockRow(h, first.session_id).lock_owner).toBeNull();
  });

  it("survives a process restart that left its lock behind", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g6" }));
    // What a killed process leaves: a lock owned by a pid that no longer exists.
    holdLock(h, first.session_id, formatLockOwner(999999, "dxr"));

    h.tick(DEFAULT_SESSION_POLICY.lockStaleMs + 1);
    const resumed = await observeTurn({
      store: h.store,
      request: turnRequest({ msgs: messages(3), key: "cc-g6" }),
      clock: h.clock,
      newId: h.newId,
      owner: formatLockOwner(1234, "dxr"),
      sleep: async () => {},
    });
    expect(resumed.session_id).toBe(first.session_id);
    expect(resumed.lock.took_over).toBe(true);
    expect(resumed.identity_confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
  });

  it("clears stale locks in the sweep and reports which ones", async () => {
    const h = await harness();
    const a = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g7a" }));
    const b = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g7b" }));
    holdLock(h, a.session_id, "9:crashed", h.at() - DEFAULT_SESSION_POLICY.lockStaleMs - 1);
    holdLock(h, b.session_id, "9:busy", h.at());

    const cleared = releaseStaleLocks(h.db, { now: h.at() });
    expect(cleared).toEqual([a.session_id]);
    expect(lockRow(h, a.session_id).lock_owner).toBeNull();
    expect(lockRow(h, b.session_id).lock_owner).toBe("9:busy");
  });

  it("gives up inside the budget and always terminates, even on a frozen clock", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g8" }));
    holdLock(h, r.session_id, "9:other");

    let slept = 0;
    const result = await acquireSessionLock({
      db: h.db,
      sessionId: r.session_id,
      owner: "1:test",
      // A clock that never ticks: the retry loop must be bounded by attempts too, or a
      // coarse platform timer could spin a request forever.
      clock: { now: () => h.at() },
      sleep: async (ms) => {
        slept += ms;
      },
    });
    expect(result.acquired).toBe(false);
    expect(result.held_by).toBe("9:other");
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.attempts).toBeLessThanOrEqual(
      Math.ceil(DEFAULT_SESSION_POLICY.lockAcquireBudgetMs / DEFAULT_SESSION_POLICY.lockRetryDelayMs) + 1,
    );
    expect(slept).toBeLessThanOrEqual(DEFAULT_SESSION_POLICY.lockAcquireBudgetMs);
  });

  it("acquires on a retry when the holder releases mid-budget", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g9" }));
    holdLock(h, r.session_id, "9:other");

    let releasedAfter = 0;
    const result = await acquireSessionLock({
      db: h.db,
      sessionId: r.session_id,
      owner: "1:test",
      clock: h.clock,
      policy: resolveSessionPolicy({ lockRetryDelayMs: 10, lockAcquireBudgetMs: 250 }),
      sleep: async (ms) => {
        h.tick(ms);
        releasedAfter += 1;
        if (releasedAfter === 2) h.db.run("UPDATE sessions SET lock_owner = NULL WHERE id = ?", [r.session_id]);
      },
    });
    expect(result.acquired).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.waited_ms).toBeGreaterThan(0);
  });

  it("refuses to lock a closed session", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g10" }));
    h.store.sessions.closeSession(h.db, { id: r.session_id, closed_at: h.at(), close_reason: "explicit" });
    const attempt = tryAcquireSessionLock(h.db, { sessionId: r.session_id, owner: "1:test", now: h.at() });
    expect(attempt.acquired).toBe(false);
  });

  it("records both turns when two writers race on one session", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g11" }));
    h.tick(10);

    // Two observations started before either finished. Whatever the interleaving, the
    // index is allocated inside the write transaction, so neither turn is lost and
    // neither overwrites the other.
    const [a, b] = await Promise.all([
      observeTurn({
        store: h.store,
        request: turnRequest({ msgs: messages(3), key: "cc-g11" }),
        clock: h.clock,
        newId: h.newId,
        owner: "1:test",
        sleep: async () => {},
      }),
      observeTurn({
        store: h.store,
        request: turnRequest({ msgs: messages(3), key: "cc-g11" }),
        clock: h.clock,
        newId: h.newId,
        owner: "2:test",
        sleep: async () => {},
      }),
    ]);

    expect(a.session_id).toBe(first.session_id);
    expect(b.session_id).toBe(first.session_id);
    expect([a.turn_idx, b.turn_idx].sort()).toEqual([1, 2]);
    expect(h.store.turns.countTurns(h.db, first.session_id)).toBe(3);
    expect(h.db.get("SELECT turn_count FROM sessions WHERE id = ?", [first.session_id]).turn_count).toBe(3);
    // At most one of them held the lock; the other, if any, said so in its record.
    const degraded = [a, b].filter((r) => r.labels.includes(M1_LABELS.IDENTITY_DEGRADED_BY_LOCK));
    expect(degraded.length).toBeLessThanOrEqual(1);
    for (const r of degraded) expect(r.identity_confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(lockRow(h, first.session_id).lock_owner).toBeNull();
  });

  it("does not let two independent sessions contend at all", async () => {
    const h = await harness();
    const a = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g12a", root: "/repo/a" }));
    const b = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g12b", root: "/repo/b" }));
    expect(a.session_id).not.toBe(b.session_id);
    h.tick(10);

    const [a2, b2] = await Promise.all([
      h.observe(turnRequest({ msgs: messages(3), key: "cc-g12a", root: "/repo/a" })),
      h.observe(turnRequest({ msgs: messages(3), key: "cc-g12b", root: "/repo/b" })),
    ]);
    for (const r of [a2, b2]) {
      expect(r.lock).toMatchObject({ acquired: true });
      expect(r.labels).toEqual([]);
      expect(r.identity_confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
      expect(r.turn_idx).toBe(1);
    }
    expect(a2.session_id).toBe(a.session_id);
    expect(b2.session_id).toBe(b.session_id);
  });

  it("releases the lock even when the write fails", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "cc-g13" }));
    h.tick(10);
    const brokenStore = {
      ...h.store,
      turns: {
        ...h.store.turns,
        insertTurnAtNextIndex: () => {
          throw new Error("write failed");
        },
      },
    };
    await expect(
      observeTurn({
        store: brokenStore,
        request: turnRequest({ msgs: messages(3), key: "cc-g13" }),
        clock: h.clock,
        newId: h.newId,
        owner: "1:test",
        sleep: async () => {},
      }),
    ).rejects.toThrow(/write failed/);
    // A held lock after a failed write would turn the session read-only for a minute.
    expect(lockRow(h, r.session_id).lock_owner).toBeNull();
  });
});
