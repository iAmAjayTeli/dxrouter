/**
 * Q2 on real traffic — `prefix_stability` reading the M1 record it was blind to.
 *
 * Every session in this file is produced by calling the **live M1 observer** through the
 * shared harness: `harness.observe(turnRequest(...))` is the same function
 * `src/lib/dxr/sessions.js` calls on the request path, writing real rows into a real
 * SQLite file. Nothing here hand-writes a `turns` row, and nothing stubs the reader, because
 * the blocker being verified was precisely that the measure could not consume what M1
 * persists — a test that assembled the rows itself would pass while the blocker stood.
 *
 * The claims under test, in the order the brief lists them:
 *
 *   real observed rows reach the measure · observed traffic is `population: real` and is
 *   never relabelled synthetic · fixtures stay synthetic · the two populations never share
 *   one `n` · sessions group by project kind, with an unresolvable root reported as unknown
 *   rather than invented · per-layer churn, unbroken-run lengths and session-end censoring
 *   are computed from the observed invalidations · the bands cluster over sessions.
 *
 * One negative claim matters as much as the rest: M1 keeps no cache ledger, so an observed
 * session must report `warm_turns: null`. A zero there would be a fabricated measurement of
 * the exact quantity Q1 exists to establish (I4).
 */

import { afterEach, describe, it, expect } from "vitest";

import { FIXTURE_SOURCES } from "../../continuity/evidence/fixtures.js";
import { BLOCKED_REASON, RUN_STATUS } from "../../continuity/evidence/harness.js";
import { OBSERVED_SOURCE, observedSessions, projectKindOf } from "../../continuity/evidence/observed.js";
import { measurePrefixStability } from "../../continuity/evidence/measures/prefixStability.js";
import { sweepSessions } from "../../continuity/session/sweeper.js";
import { makeTmpDir, openHarness, removeTmpDir, messages, SYSTEM, TOOLS, turnRequest } from "./helpers/harness.js";

/** A second tool set, so a turn can break the `tools` layer the way a real client does. */
const TOOLS_PLUS = [...TOOLS, { name: "run_tests", description: "run the suite", parameters: { type: "object", properties: {} } }];

/**
 * Drive one session through `k` turns of the real observer.
 *
 * `mutate(i)` returns whatever should differ on turn `i` — a changed tool list or system
 * prompt is what produces a genuine front-layer invalidation, computed by M1's own hasher
 * rather than declared by the test.
 */
async function runSession(h, { key, root, turns: k, mutate = () => ({}) }) {
  const out = [];
  for (let i = 0; i < k; i += 1) {
    h.tick(1000);
    out.push(await h.observe(turnRequest({ key, root, msgs: messages(i * 2 + 1, `${key} `), ...mutate(i) })));
  }
  return out;
}

describe("Q2-A — the measure reads what M1 actually persisted", () => {
  let dir;
  let h;
  afterEach(() => {
    h?.close();
    h = null;
    dir && removeTmpDir(dir);
  });

  /** Three project kinds, driven through the live observer. §23's minimum population. */
  async function threeKinds() {
    dir = makeTmpDir("q2-observed");
    h = await openHarness({ dir, tag: "q2" });
    // Kind one: a stable front — the tools and system prompt never change, only the
    // conversation grows. This is the shape a cache window would survive.
    await runSession(h, { key: "k1", root: "/repo/one", turns: 5 });
    // Kind two: the client swaps its tool list on turn 2, which M1's hasher sees as a
    // `tools` invalidation. Nothing in the test declares the invalidation.
    await runSession(h, {
      key: "k2",
      root: "/repo/two",
      turns: 5,
      mutate: (i) => (i >= 2 ? { tools: TOOLS_PLUS } : {}),
    });
    // Kind three: a changed system prompt, the other front layer.
    await runSession(h, {
      key: "k3",
      root: "/repo/three",
      turns: 4,
      mutate: (i) => (i >= 3 ? { system: `${SYSTEM} Be brief.` } : {}),
    });
    return h;
  }

  it("reduces observed sessions into Q2, and calls the population real", async () => {
    await threeKinds();
    const out = measurePrefixStability({ store: h.store });

    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.question).toBe("Q2");
    // `n` is sessions, because sessions are the independent unit the bands cluster over.
    expect(out.n).toBe(3);
    expect(out).toMatchObject({
      population: "real",
      population_source: OBSERVED_SOURCE,
      n_observed: 3,
      n_captured: 0,
      n_synthetic: 0,
    });
    // The turn counts came from the store, not from the test's arithmetic.
    expect(out.sessions.map((s) => s.turns).sort()).toEqual([4, 5, 5]);
    expect(out.notes.join(" ")).toMatch(/observed M1 traffic from this deployment/);
    // Observed traffic is not a fixture, and cannot be reported as one.
    expect(FIXTURE_SOURCES).not.toContain(OBSERVED_SOURCE);
    expect(out.sessions.every((s) => s.fixture_source === OBSERVED_SOURCE)).toBe(true);
  });

  it("computes per-layer churn from the invalidations M1 recorded", async () => {
    await threeKinds();
    const out = measurePrefixStability({ store: h.store });
    const layer = (name) => out.by_layer.find((l) => l.layer === name);

    // Post-turn-0 only: turn 0 invalidates everything by construction.
    expect(layer("messages").turns).toBe(11);
    // Every subsequent turn extends the conversation, so `messages` churns on all of them.
    expect(layer("messages").churn_pct).toBe(100);
    // `tools` churned on exactly one observed turn: k2's turn 2, where the client swapped
    // its tool list. `system` churned on two — k3's turn 3, and k2's turn 2 as well, because
    // a break in an earlier layer breaks the prefix everything after it sat on. That cascade
    // is M1's rule, recorded by M1; this measure reads the list rather than re-deriving it.
    expect(layer("tools").churned_turns).toBe(1);
    expect(layer("system").churned_turns).toBe(2);
    // The band clusters over the three sessions, not the eleven turns.
    expect(layer("tools").churn_error.basis).toMatch(/cluster bootstrap|sample too small/);
  });

  it("measures unbroken runs, and censors the run still open at the end of a session", async () => {
    await threeKinds();
    const out = measurePrefixStability({ store: h.store });

    // One run per break, plus the still-open run each session ends with. k1 never broke,
    // so it contributes one censored run; k2 and k3 broke once each.
    expect(out.front_runs_observed).toBe(5);
    expect(out.front_runs_censored).toBe(3);
    expect(out.front_run_turns.basis).toMatch(/Kaplan-Meier/);
    // k1 held for all four post-zero turns; the longest run cannot exceed that.
    expect(Math.max(...out.sessions.map((s) => s.longest_front_run))).toBe(4);
    const broke = out.sessions.filter((s) => s.front_breaks > 0);
    expect(broke).toHaveLength(2);
  });

  it("reports no warm turns at all, because M1 records requests and not beliefs (I4)", async () => {
    await threeKinds();
    const out = measurePrefixStability({ store: h.store });
    // Null, not zero: a zero here would be a measurement of cache warmth nobody took.
    expect(out.sessions.every((s) => s.warm_turns === null)).toBe(true);
    expect(out.notes.join(" ")).toMatch(/warm_turns is unavailable/);
  });
});

describe("Q2-B — grouping, provenance and the populations that must not mix", () => {
  let dir;
  let h;
  afterEach(() => {
    h?.close();
    h = null;
    dir && removeTmpDir(dir);
  });

  it("groups by the project root M1 stored, and never guesses one it does not have", async () => {
    dir = makeTmpDir("q2-kinds");
    h = await openHarness({ dir, tag: "q2" });
    await runSession(h, { key: "k1", root: "/repo/one", turns: 3 });
    await runSession(h, { key: "k2", root: "/repo/two", turns: 3 });
    await runSession(h, { key: "k3", root: "/repo/three", turns: 3 });
    // A client that sent no project root. The only honest kind for it is "none".
    await runSession(h, { key: "k4", root: null, turns: 3 });

    const out = measurePrefixStability({ store: h.store });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.project_kinds).toHaveLength(3);
    expect(out.project_kinds_unknown).toBe(1);
    expect(out.notes.join(" ")).toMatch(/no resolvable project root and are grouped as project_kind=null/);

    // Four groups, the unknown one last and named as unknown rather than folded into a
    // neighbour — the difference between "we do not know" and a fabricated kind.
    expect(out.by_project_kind).toHaveLength(4);
    expect(out.by_project_kind.at(-1)).toMatchObject({ project_kind: null, project_kind_source: "unknown", sessions: 1 });
    for (const row of out.by_project_kind.slice(0, 3)) {
      expect(row.sessions).toBe(1);
      expect(row.project_kind_source).toMatch(/^project_root(_hash)?$/);
      // One session per kind, so each kind's own band is honestly unavailable rather
      // than a zero-width interval computed over a single cluster.
      expect(row.front_held_error.band).toBe("unavailable");
    }
  });

  it("keeps a fixture population synthetic, and refuses to pool it with observed traffic", async () => {
    dir = makeTmpDir("q2-mixed");
    h = await openHarness({ dir, tag: "q2" });
    await runSession(h, { key: "k1", root: "/repo/one", turns: 3 });
    await runSession(h, { key: "k2", root: "/repo/two", turns: 3 });
    await runSession(h, { key: "k3", root: "/repo/three", turns: 3 });

    const synthetic = ["kind-a", "kind-b", "kind-c"].map((kind, i) => ({
      fixture_id: `f${i}`,
      fixture_source: "synthetic",
      project_kind: kind,
      turns: [
        { i: 0, invalidated: ["tools", "system", "messages"] },
        { i: 1, invalidated: ["messages"] },
        { i: 2, invalidated: ["messages"] },
      ],
    }));

    // Fixtures alone: still synthetic, still reported as such.
    const fixturesOnly = measurePrefixStability({ replays: synthetic });
    expect(fixturesOnly).toMatchObject({ status: RUN_STATUS.OK, population: "synthetic", population_source: "synthetic", n_synthetic: 3, n_observed: 0 });
    expect(fixturesOnly.notes.join(" ")).toMatch(/sessions are synthetic/);

    // Both at once is not a bigger sample. It is two populations added together, and the
    // bands would already have been computed across the join by the time anyone read a
    // caveat, so it blocks instead of reporting.
    const both = measurePrefixStability({ store: h.store, replays: synthetic });
    expect(both).toMatchObject({
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.MIXED_POPULATION,
      population_source: "mixed",
      n_observed: 3,
      n_synthetic: 3,
    });
    expect(both.error.band).toBe("unavailable");
    expect(both.notes.join(" ")).toMatch(/measure one population at a time/);
    // Observed traffic keeps its own label inside the blocked result: the mixing is
    // reported, not resolved by relabelling the real sessions.
    expect(both.sessions.filter((s) => s.fixture_source === OBSERVED_SOURCE)).toHaveLength(3);
  });

  it("blocks with no rows rather than reporting an empty population as a number", async () => {
    dir = makeTmpDir("q2-empty");
    h = await openHarness({ dir, tag: "q2" });
    const out = measurePrefixStability({ store: h.store });
    expect(out).toMatchObject({
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NO_ROWS,
      n: 0,
      population: "none",
      population_source: "none",
    });
  });
});

describe("Q2-C — the reader itself: windows, orphans and what a turn may carry", () => {
  let dir;
  let h;
  afterEach(() => {
    h?.close();
    h = null;
    dir && removeTmpDir(dir);
  });

  it("carries M1's own per-layer hashes and invalidation list, and no cache belief", async () => {
    dir = makeTmpDir("q2-reader");
    h = await openHarness({ dir, tag: "q2" });
    await runSession(h, { key: "k1", root: "/repo/one", turns: 3, mutate: (i) => (i === 2 ? { tools: TOOLS_PLUS } : {}) });

    const [session] = observedSessions({ store: h.store });
    expect(session.fixture_source).toBe(OBSERVED_SOURCE);
    expect(session.project_kind).toBe("/repo/one");
    expect(session.turns.map((t) => t.i)).toEqual([0, 1, 2]);
    // The invalidation list is read back as a list, through the one parser that is the
    // inverse of the writer — not re-derived from the hashes by this measure.
    //
    // Turn 0 invalidated nothing, and that is what M1 stored: no prefix preceded it, so
    // there was nothing to break. A synthetic fixture conventionally marks turn 0 as
    // breaking every layer, which is why the measure skips index 0 either way rather than
    // trusting the list there.
    expect(session.turns[0].invalidated).toEqual([]);
    expect(session.turns[1].invalidated).toEqual(["messages"]);
    // The tool swap on turn 2 broke `tools`, and with it everything the prefix carried
    // after `tools`.
    expect(session.turns[2].invalidated).toEqual(expect.arrayContaining(["tools", "system", "messages"]));
    // Layer hashes travel so a later measure can compare prefixes; no request content does.
    expect(session.turns[0].layers.tools_hash).toEqual(expect.any(String));
    expect(JSON.stringify(session)).not.toMatch(/turn 0|coding agent/);
    // M1 keeps no cache ledger. The absence is structural, not a null slot to be filled.
    expect(session.turns.every((t) => !("belief" in t))).toBe(true);
  });

  it("drops the leading run of a session the window cut into, rather than counting it short", async () => {
    dir = makeTmpDir("q2-window");
    h = await openHarness({ dir, tag: "q2" });
    await runSession(h, { key: "k1", root: "/repo/one", turns: 6 });
    const cut = h.at() - 2500;
    await runSession(h, { key: "k2", root: "/repo/two", turns: 3 });
    await runSession(h, { key: "k3", root: "/repo/three", turns: 3 });

    const whole = measurePrefixStability({ store: h.store });
    expect(whole.truncated_sessions).toBe(0);

    // The same store, seen through a window that starts mid-session for k1. Its opening
    // stretch is *left*-censored — we cannot see how long the front had already held — and
    // Kaplan-Meier cannot express that, so the run is dropped, never counted as a short one.
    const windowed = measurePrefixStability({ store: h.store, since: cut });
    const k1 = windowed.sessions.find((s) => s.truncated);
    expect(k1).toBeTruthy();
    expect(k1.first_turn_idx).toBeGreaterThan(0);
    expect(windowed.truncated_sessions).toBe(1);
    expect(windowed.notes.join(" ")).toMatch(/leading run is left-censored and was dropped, not counted short/);
    expect(windowed.front_runs_observed).toBeLessThan(whole.front_runs_observed);
  });

  it("drops turns whose session retention already swept, instead of inventing a session for them", async () => {
    dir = makeTmpDir("q2-orphan");
    h = await openHarness({ dir, tag: "q2" });
    await runSession(h, { key: "k1", root: "/repo/one", turns: 3 });
    await runSession(h, { key: "k2", root: "/repo/two", turns: 3 });
    expect(observedSessions({ store: h.store })).toHaveLength(2);

    // Retention deletes sessions, and a `turns` row can outlive its parent. A measure that
    // grouped by `session_id` alone would report those orphans as a session with no kind.
    const id = h.db.get(`SELECT id FROM sessions ORDER BY opened_at LIMIT 1`).id;
    h.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
    const left = observedSessions({ store: h.store });
    expect(left).toHaveLength(1);
    expect(left[0].session_id).not.toBe(id);
  });

  it("reports a hashed project root as hashed, and an unresolvable one as unknown", () => {
    // The path itself is the kind when it is a path; when the deployment hashes roots the
    // kind is the hash, labelled as such, because two sessions in the same repository still
    // group together. Neither is ever derived from prompt content.
    expect(projectKindOf({ project_root: "/repo/one" })).toEqual({ project_kind: "/repo/one", project_kind_source: "project_root" });
    expect(projectKindOf({ project_root: "pr1:abcd", project_root_hashed: 1 })).toEqual({
      project_kind: "pr1:abcd",
      project_kind_source: "project_root_hash",
    });
    expect(projectKindOf({ project_root: "unknown" })).toEqual({ project_kind: null, project_kind_source: "unknown" });
    expect(projectKindOf({})).toEqual({ project_kind: null, project_kind_source: "unknown" });
  });
});
