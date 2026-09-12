/**
 * Group F — session and turn persistence (§14 F, §§10, 12.3).
 *
 * Everything here is asserted against a real SQLite file, and one test closes the
 * handle and reopens the file to prove that recovery is a property of the *database*
 * and not of a warm process. Acceptance criterion 9 ("restart recovery") means exactly
 * that: a new process must be able to continue a conversation it never saw start.
 */

import fs from "node:fs";
import { describe, it, expect, afterEach } from "vitest";

import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { openContinuityStore } from "../../continuity/store/index.js";
import { observeTurn } from "../../continuity/session/observer.js";
import { capDigests } from "../../continuity/store/sqlite/repositories/prefixStateRepo.js";
import { sweepSessions } from "../../continuity/session/sweeper.js";
import { DEFAULT_SESSION_POLICY, resolveSessionPolicy } from "../../continuity/session/policy.js";
import { IDENTITY_CONFIDENCE, IDENTITY_SOURCE } from "../../continuity/identity/confidence.js";
import { ESTIMATOR_VERSION } from "../../continuity/prefix/tokens.js";
import { computePrefixLayers } from "../../continuity/prefix/hasher.js";
import { messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const DAY_MS = 86400000;

describe("F — persistence", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });

  const harness = async (opts = {}) => {
    const h = await openHarness({ tag: "persist", ...opts });
    open.push(h);
    return h;
  };

  it("writes one turn per observation, indexed from zero and never re-used", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(1), key: "cc-f1" }));
    h.tick(1000);
    await h.observe(turnRequest({ msgs: messages(3), key: "cc-f1" }));
    h.tick(1000);
    await h.observe(turnRequest({ msgs: messages(5), key: "cc-f1" }));

    const rows = h.db.all("SELECT idx, at, session_id FROM turns ORDER BY idx");
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2]);
    expect(new Set(rows.map((r) => r.session_id))).toEqual(new Set([first.session_id]));
    expect(rows.map((r) => r.at)).toEqual([1700000000000, 1700000001000, 1700000002000]);
    expect(h.db.get("SELECT turn_count FROM sessions WHERE id = ?", [first.session_id]).turn_count).toBe(3);
  });

  it("stores every §10 field the observation reported", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(3), key: "cc-f2" }));
    h.tick(1000);
    const r2 = await h.observe(turnRequest({ msgs: messages(5), key: "cc-f2" }));

    const row = h.db.get("SELECT * FROM turns WHERE session_id = ? AND idx = ?", [r2.session_id, 1]);
    expect(row).toMatchObject({
      session_id: r.session_id,
      idx: 1,
      at: 1700000001000,
      identity_confidence: IDENTITY_CONFIDENCE.EXPLICIT,
      identity_source: IDENTITY_SOURCE.HEADER,
      relation: "extension",
      protocol: "openai",
      requested_model: "gpt-test",
      message_count: 5,
    });
    expect(row.tools_hash).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(row.system_hash).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(row.messages_hash).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(row.messages_tokens).toBeGreaterThan(0);
    expect(row.messages_tokens_provenance).toBe("estimated");
    expect(row.token_estimator).toBe(ESTIMATOR_VERSION);
    // A request-only observation: response accounting stays null rather than guessed.
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
  });

  it("keeps exactly one prefix-state row per session, always the latest turn", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "cc-f3" }));
    h.tick(1000);
    await h.observe(turnRequest({ msgs: messages(7), key: "cc-f3" }));

    expect(h.db.get("SELECT COUNT(*) AS n FROM session_prefix").n).toBe(1);
    const state = h.store.prefixState.getPrefixState(h.db, r.session_id);
    expect(state.turn_idx).toBe(1);
    expect(state.message_count).toBe(7);
    expect(state.digests).toHaveLength(7);
    expect(state.digests_truncated).toBe(false);
    expect(state.messages_hash).toBe(computePrefixLayers({ messages: messages(7) }).messages.hash);
  });

  it("caps the digest list from the front and records that it did", async () => {
    // The cap is a storage bound, not an identity change: a divergence index may
    // become unavailable, the extension proof does not depend on the stored list.
    expect(capDigests(["a", "b", "c"], 2)).toEqual({ digests: ["a", "b"], truncated: true });
    expect(capDigests(["a", "b"], 2)).toEqual({ digests: ["a", "b"], truncated: false });
    expect(capDigests(null, 2)).toEqual({ digests: null, truncated: false });

    const h = await harness();
    const policy = resolveSessionPolicy({ maxChainMessages: 3 });
    const r = await observeTurn({
      store: h.store,
      request: turnRequest({ msgs: messages(9), key: "cc-f4" }),
      clock: h.clock,
      newId: h.newId,
      owner: "1:test",
      policy,
      sleep: async () => {},
    });
    const state = h.store.prefixState.getPrefixState(h.db, r.session_id);
    expect(state.digests).toHaveLength(3);
    expect(state.digests_truncated).toBe(true);
    expect(state.message_count).toBe(9);
  });

  it("recovers after a restart: a new handle continues a session it never saw start", async () => {
    const first = await harness();
    const before = await first.observe(turnRequest({ msgs: messages(3), key: "cc-restart" }));
    first.tick(1000);
    await first.observe(turnRequest({ msgs: messages(5), key: "cc-restart" }));

    // Close the handle the way a shutting-down process would, then open the file again
    // as a fresh process would. Nothing is carried over in memory.
    first.close();
    expect(fs.existsSync(first.file)).toBe(true);

    const db = await createSqlJsAdapter(first.file);
    const store = openContinuityStore({ db });
    try {
      let now = first.at() + 5000;
      const after = await observeTurn({
        store,
        request: turnRequest({ msgs: messages(7), key: "cc-restart" }),
        clock: { now: () => now },
        newId: () => "should-not-be-used",
        owner: "2:test",
        sleep: async () => {},
      });
      expect(after.session_id).toBe(before.session_id);
      expect(after.created_session).toBe(false);
      expect(after.turn_idx).toBe(2);
      expect(after.relation).toBe("extension");
      expect(after.identity_confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
      now += 1;
      // The inferred path recovers too, and it is the harder case: it depends on the
      // prefix state and the candidate lookup both surviving the restart.
      const inferred = await observeTurn({
        store,
        request: turnRequest({ msgs: messages(9) }),
        clock: { now: () => now },
        newId: () => "inferred-new",
        owner: "2:test",
        sleep: async () => {},
      });
      expect(inferred.session_id).toBe(before.session_id);
      // The turn is graded for the evidence *this* turn had: no key was sent, so the
      // identity was re-derived from the recovered prefix state. The session keeps the
      // best grade it ever earned, which is still explicit.
      expect(inferred.identity_confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
      expect(inferred.identity_source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
      expect(store.sessions.getSession(db, before.session_id).identity_confidence).toBe(
        IDENTITY_CONFIDENCE.EXPLICIT,
      );
      expect(store.turns.countTurns(db, before.session_id)).toBe(4);
    } finally {
      db.close();
    }
  });

  it("survives an interrupted write without a half-recorded turn", async () => {
    const h = await harness();
    const good = await h.observe(turnRequest({ msgs: messages(1), key: "cc-f5" }));
    h.tick(1000);

    // Fail inside the transaction, after the session row and the turn would have been
    // written. Both halves must roll back together: a turn without its prefix state
    // would make the next comparison read stale evidence.
    const brokenStore = {
      ...h.store,
      prefixState: {
        ...h.store.prefixState,
        upsertPrefixState: () => {
          throw new Error("disk full");
        },
      },
    };
    await expect(
      observeTurn({
        store: brokenStore,
        request: turnRequest({ msgs: messages(3), key: "cc-f5" }),
        clock: h.clock,
        newId: h.newId,
        owner: "1:test",
        sleep: async () => {},
      }),
    ).rejects.toThrow(/disk full/);

    expect(h.store.turns.countTurns(h.db, good.session_id)).toBe(1);
    const state = h.store.prefixState.getPrefixState(h.db, good.session_id);
    expect(state.turn_idx).toBe(0);
    expect(state.message_count).toBe(1);
    expect(h.db.get("SELECT turn_count FROM sessions WHERE id = ?", [good.session_id]).turn_count).toBe(1);
  });

  it("applies retention: old turns go, then long-closed sessions, and nothing else", async () => {
    const h = await harness();
    const old = await h.observe(turnRequest({ msgs: messages(1), key: "cc-old" }));
    h.tick(DEFAULT_SESSION_POLICY.idleTimeoutMs + 1);
    sweepSessions({ store: h.store, clock: h.clock });
    expect(h.db.get("SELECT close_reason FROM sessions WHERE id = ?", [old.session_id]).close_reason).toBe(
      "idle_timeout",
    );

    // Ten days on: inside the 30 day window, so nothing is deleted.
    h.tick(10 * DAY_MS);
    const quiet = sweepSessions({ store: h.store, clock: h.clock });
    expect(quiet).toMatchObject({ turns_deleted: 0, sessions_deleted: 0 });
    expect(h.db.get("SELECT COUNT(*) AS n FROM turns").n).toBe(1);

    // Past the window: the turn is deleted first, then the session row itself.
    h.tick(25 * DAY_MS);
    const swept = sweepSessions({ store: h.store, clock: h.clock });
    expect(swept.turns_deleted).toBe(1);
    expect(swept.sessions_deleted).toBe(1);
    expect(h.db.get("SELECT COUNT(*) AS n FROM turns").n).toBe(0);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(0);
    expect(h.db.get("SELECT COUNT(*) AS n FROM session_prefix").n).toBe(0);
  });

  it("honours a shorter retention override without touching a live session", async () => {
    const h = await harness();
    const live = await h.observe(turnRequest({ msgs: messages(1), key: "cc-live" }));
    h.tick(2 * DAY_MS);
    const r = sweepSessions({
      store: h.store,
      clock: h.clock,
      policy: resolveSessionPolicy({ turnRetentionDays: 1, sessionRetentionDays: 1 }),
    });
    // The session was closed by the idle rule in this same sweep, but its close time is
    // now, so the session row stays; only the day-old turn is inside the delete window.
    expect(r.turns_deleted).toBe(1);
    expect(r.sessions_deleted).toBe(0);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", [live.session_id]).n).toBe(1);
  });

  it("uses parameterized statements, so a hostile-looking key is just data", async () => {
    const h = await harness();
    // The key is rejected by the whitelist long before SQL, and the project root is a
    // stored label. Both go through bound parameters: the tables must still be here.
    const r = await h.observe(
      turnRequest({ msgs: messages(1), key: "x'; DROP TABLE turns; --", root: "/repo/'); DROP TABLE sessions; --" }),
    );
    expect(r.observed).toBe(true);
    expect(h.db.get("SELECT COUNT(*) AS n FROM turns").n).toBe(1);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(1);
    expect(h.db.get("SELECT project_root FROM sessions WHERE id = ?", [r.session_id]).project_root).toContain("DROP");
  });
});
