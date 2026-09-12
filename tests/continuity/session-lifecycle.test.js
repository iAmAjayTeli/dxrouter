/**
 * Group E — session lifecycle (§14 E, §§5, 8, 9).
 *
 * Three things have to hold. The transition table must be a table, not a habit: an
 * illegal move throws rather than quietly landing. The five close reasons must all be
 * reachable and each must mean what it says — in particular `client_compaction_suspected`
 * and `prefix_discontinuity` must not be interchangeable, because the ratio between
 * them is the evidence a later milestone reads. And a closed session must stay closed.
 *
 * Nothing here decides anything: a boundary is recorded, never acted on.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  CLOSE_REASON,
  CLOSE_REASON_VALUES,
  SESSION_STATE,
  SessionLifecycleError,
  assertTransition,
  canTransition,
  detectCompaction,
  isCloseReason,
  isIdle,
  isSessionState,
} from "../../continuity/session/lifecycle.js";
import { DEFAULT_SESSION_POLICY, resolveSessionPolicy } from "../../continuity/session/policy.js";
import { MESSAGE_RELATION } from "../../continuity/prefix/extension.js";
import { sweepSessions } from "../../continuity/session/sweeper.js";
import { SYSTEM, TOOLS, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

describe("E1 — states and transitions are a table, not a habit", () => {
  it("names exactly the four §5 states and the five close reasons", () => {
    expect(Object.values(SESSION_STATE)).toEqual(["new", "active", "reevaluating", "closed"]);
    expect([...CLOSE_REASON_VALUES].sort()).toEqual([
      "client_compaction_suspected",
      "explicit",
      "idle_timeout",
      "prefix_discontinuity",
      "swept",
    ]);
    for (const s of Object.values(SESSION_STATE)) expect(isSessionState(s)).toBe(true);
    for (const r of CLOSE_REASON_VALUES) expect(isCloseReason(r)).toBe(true);
    expect(isSessionState("paused")).toBe(false);
    expect(isCloseReason("because")).toBe(false);
  });

  it("allows the lifecycle path and refuses everything else", () => {
    expect(canTransition(SESSION_STATE.NEW, SESSION_STATE.ACTIVE)).toBe(true);
    expect(canTransition(SESSION_STATE.ACTIVE, SESSION_STATE.ACTIVE)).toBe(true);
    expect(canTransition(SESSION_STATE.ACTIVE, SESSION_STATE.REEVALUATING)).toBe(true);
    expect(canTransition(SESSION_STATE.REEVALUATING, SESSION_STATE.ACTIVE)).toBe(true);
    for (const from of Object.values(SESSION_STATE)) {
      expect(canTransition(from, SESSION_STATE.CLOSED)).toBe(from !== SESSION_STATE.CLOSED);
    }
    expect(canTransition(SESSION_STATE.NEW, SESSION_STATE.REEVALUATING)).toBe(false);
    expect(canTransition("nonsense", SESSION_STATE.ACTIVE)).toBe(false);
  });

  it("never reopens a closed session", () => {
    expect(ALLOWED_TRANSITIONS[SESSION_STATE.CLOSED]).toEqual([]);
    for (const to of Object.values(SESSION_STATE)) {
      expect(() => assertTransition(SESSION_STATE.CLOSED, to)).toThrow(SessionLifecycleError);
    }
  });

  it("throws with a code a caller can branch on", () => {
    try {
      assertTransition(SESSION_STATE.CLOSED, SESSION_STATE.ACTIVE);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.name).toBe("SessionLifecycleError");
      expect(e.code).toBe("SESSION_ILLEGAL_TRANSITION");
    }
  });
});

describe("E2 — idleness is a clock fact, not an opinion", () => {
  const policy = DEFAULT_SESSION_POLICY;
  const at = 1_000_000;

  it("uses last_seen_at, falling back to opened_at", () => {
    expect(isIdle({ last_seen_at: at, opened_at: 0 }, at + policy.idleTimeoutMs, policy)).toBe(true);
    expect(isIdle({ last_seen_at: at, opened_at: 0 }, at + policy.idleTimeoutMs - 1, policy)).toBe(false);
    expect(isIdle({ opened_at: at }, at + policy.idleTimeoutMs, policy)).toBe(true);
  });

  it("refuses to judge without integer times", () => {
    expect(isIdle({ last_seen_at: null, opened_at: null }, at, policy)).toBe(false);
    expect(isIdle({ last_seen_at: at }, null, policy)).toBe(false);
  });

  it("honours an overridden timeout, and rejects a nonsense one", () => {
    const short = resolveSessionPolicy({ idleTimeoutMs: 1000 });
    expect(isIdle({ last_seen_at: at }, at + 1000, short)).toBe(true);
    expect(resolveSessionPolicy({ idleTimeoutMs: 0 }).idleTimeoutMs).toBe(policy.idleTimeoutMs);
    expect(resolveSessionPolicy({ idleTimeoutMs: "abc" }).idleTimeoutMs).toBe(policy.idleTimeoutMs);
    expect(resolveSessionPolicy({ compactionShrinkMaxBp: 20000 }).compactionShrinkMaxBp).toBe(9000);
  });
});

describe("E3 — compaction is distinguished from discontinuity, conservatively", () => {
  const base = { tools_hash: "t", system_hash: "s", messages_tokens: 10000, message_count: 60 };

  it("fires on tools+system stable and materially fewer tokens", () => {
    const r = detectCompaction({
      prev: base,
      next: { ...base, messages_tokens: 500, message_count: 2 },
      relation: MESSAGE_RELATION.DIVERGENCE,
    });
    expect(r.compaction).toBe(true);
    expect(r.basis).toBe("tokens");
    expect(r.shrink_bp).toBe(500);
    expect(r.reason).toBeNull();
  });

  it("does not fire when the shrink is not material", () => {
    const r = detectCompaction({
      prev: base,
      next: { ...base, messages_tokens: 9900 },
      relation: MESSAGE_RELATION.SHORTENED,
    });
    expect(r.compaction).toBe(false);
    expect(r.reason).toBe("token_count_not_materially_shorter");
    expect(r.shrink_bp).toBe(9900);
  });

  it("does not fire when the tools or the system prompt changed", () => {
    const shorter = { ...base, messages_tokens: 100 };
    expect(
      detectCompaction({ prev: base, next: { ...shorter, tools_hash: "t2" }, relation: MESSAGE_RELATION.DIVERGENCE })
        .reason,
    ).toBe("tools_layer_changed");
    expect(
      detectCompaction({ prev: base, next: { ...shorter, system_hash: "s2" }, relation: MESSAGE_RELATION.DIVERGENCE })
        .reason,
    ).toBe("system_layer_changed");
  });

  it("does not fire while the messages layer is still extending", () => {
    for (const relation of [MESSAGE_RELATION.EXTENSION, MESSAGE_RELATION.IDENTICAL, MESSAGE_RELATION.INDETERMINATE]) {
      const r = detectCompaction({ prev: base, next: { ...base, messages_tokens: 10 }, relation });
      expect(r.compaction, relation).toBe(false);
      expect(r.reason).toBe("messages_layer_not_shortened");
    }
  });

  it("falls back to the message count and says which basis it used", () => {
    const r = detectCompaction({
      prev: { ...base, messages_tokens: null },
      next: { tools_hash: "t", system_hash: "s", messages_tokens: null, message_count: 2 },
      relation: MESSAGE_RELATION.SHORTENED,
    });
    expect(r.basis).toBe("message_count");
    expect(r.compaction).toBe(true);
    expect(r.shrink_bp).toBe(333);
  });

  it("reports no evidence rather than guessing when both bases are missing", () => {
    const r = detectCompaction({
      prev: { tools_hash: "t", system_hash: "s" },
      next: { tools_hash: "t", system_hash: "s" },
      relation: MESSAGE_RELATION.SHORTENED,
    });
    expect(r.compaction).toBe(false);
    expect(r.basis).toBeNull();
    expect(r.reason).toBe("no_comparable_size_evidence");
  });
});

describe("E4 — the lifecycle as it is actually persisted", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });

  const harness = async () => {
    const h = await openHarness({ tag: "life" });
    open.push(h);
    return h;
  };

  const stateOf = (h, id) =>
    h.db.get("SELECT state, closed_at, close_reason, turn_count FROM sessions WHERE id = ?", [id]);

  it("opens active and stays active while the prefix extends", async () => {
    const h = await harness();
    const t1 = await h.observe(turnRequest({ msgs: messages(1) }));
    expect(stateOf(h, t1.session_id)).toMatchObject({ state: "active", closed_at: null, close_reason: null });
    h.tick(1000);
    await h.observe(turnRequest({ msgs: messages(3) }));
    expect(stateOf(h, t1.session_id)).toMatchObject({ state: "active", turn_count: 2 });
  });

  it("closes with prefix_discontinuity when an explicit key restarts the conversation", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(4), key: "cc-life" }));
    h.tick(1000);
    // A divergence that is NOT a shrink: same number of messages, different content.
    // Otherwise the shorter-and-same-tools signature would (correctly) read as a
    // compaction, and the two reasons must stay distinguishable.
    const after = await h.observe(turnRequest({ msgs: messages(4, "other "), key: "cc-life" }));

    expect(after.session_id).not.toBe(first.session_id);
    expect(after.closed_predecessor).toEqual({
      session_id: first.session_id,
      reason: CLOSE_REASON.PREFIX_DISCONTINUITY,
    });
    expect(stateOf(h, first.session_id)).toMatchObject({
      state: "closed",
      close_reason: CLOSE_REASON.PREFIX_DISCONTINUITY,
    });
    expect(h.db.get("SELECT predecessor_id FROM sessions WHERE id = ?", [after.session_id]).predecessor_id).toBe(
      first.session_id,
    );
  });

  it("closes with client_compaction_suspected when the same key comes back much shorter", async () => {
    const h = await harness();
    const long = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "x".repeat(400) + i,
    }));
    const before = await h.observe(turnRequest({ msgs: long, key: "cc-comp" }));
    h.tick(1000);
    const after = await h.observe(
      turnRequest({ msgs: [{ role: "user", content: "summary" }, { role: "user", content: "carry on" }], key: "cc-comp" }),
    );

    expect(after.boundary).toBe(CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED);
    expect(stateOf(h, before.session_id)).toMatchObject({
      state: "closed",
      close_reason: CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED,
    });
    // A successor, not a merge, not a rebase: the new session only points backwards.
    expect(after.created_session).toBe(true);
    expect(after.predecessor_id).toBe(before.session_id);
  });

  it("closes an idle session with idle_timeout, and an empty one as swept", async () => {
    const h = await harness();
    const used = await h.observe(turnRequest({ msgs: messages(1) }));
    const emptyId = "empty-1";
    h.store.sessions.insertSession(h.db, {
      id: emptyId,
      project_root: "/repo/one",
      project_root_hashed: false,
      identity_confidence: "unknown",
      identity_source: "new",
      client_key: null,
      predecessor_id: null,
      state: "active",
      opened_at: h.at(),
      last_seen_at: h.at(),
      turn_count: 0,
    });

    h.tick(DEFAULT_SESSION_POLICY.idleTimeoutMs + 1);
    const sweep = sweepSessions({ store: h.store, clock: h.clock });

    expect(sweep.idle_closed).toEqual([used.session_id]);
    expect(sweep.swept).toEqual([emptyId]);
    expect(stateOf(h, used.session_id).close_reason).toBe(CLOSE_REASON.IDLE_TIMEOUT);
    expect(stateOf(h, emptyId).close_reason).toBe(CLOSE_REASON.SWEPT);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL").n).toBe(0);
  });

  it("keeps the first true close reason when a close is attempted twice", async () => {
    const h = await harness();
    const t = await h.observe(turnRequest({ msgs: messages(1) }));
    h.store.sessions.closeSession(h.db, {
      id: t.session_id,
      closed_at: h.at(),
      close_reason: CLOSE_REASON.EXPLICIT,
    });
    h.tick(DEFAULT_SESSION_POLICY.idleTimeoutMs + 1);
    sweepSessions({ store: h.store, clock: h.clock });
    // `explicit` is the typed reason for a client-signalled close; M1 has no such
    // signal on the request path, so the store API is where it enters. Either way the
    // sweeper must not overwrite it.
    expect(stateOf(h, t.session_id).close_reason).toBe(CLOSE_REASON.EXPLICIT);
  });

  it("does not close a session that is still being used", async () => {
    const h = await harness();
    const t = await h.observe(turnRequest({ msgs: messages(1) }));
    h.tick(DEFAULT_SESSION_POLICY.idleTimeoutMs - 1);
    const sweep = sweepSessions({ store: h.store, clock: h.clock });
    expect(sweep.idle_closed).toEqual([]);
    expect(stateOf(h, t.session_id).closed_at).toBeNull();
  });

  it("never records a state or close reason outside the enums", async () => {
    const h = await harness();
    await h.observe(turnRequest({ msgs: messages(2), key: "cc-x" }));
    h.tick(1000);
    await h.observe(turnRequest({ msgs: [{ role: "user", content: "restart" }], key: "cc-x" }));
    h.tick(DEFAULT_SESSION_POLICY.idleTimeoutMs + 1);
    sweepSessions({ store: h.store, clock: h.clock });

    for (const row of h.db.all("SELECT state, close_reason FROM sessions")) {
      expect(Object.values(SESSION_STATE)).toContain(row.state);
      if (row.close_reason !== null) expect(CLOSE_REASON_VALUES).toContain(row.close_reason);
    }
    for (const row of h.db.all("SELECT boundary FROM turns WHERE boundary IS NOT NULL")) {
      expect(CLOSE_REASON_VALUES).toContain(row.boundary);
    }
  });
});
