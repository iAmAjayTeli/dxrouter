/**
 * I-6 and I-5 — the estimators, and the moves they are estimating over.
 *
 * Two claims are tested here, and they are the two that decide whether a §19.4 percentage
 * means anything:
 *
 *  1. **The interval fits the quantity.** A proportion gets Wilson, a clustered mean gets a
 *     seeded cluster bootstrap, a duration that may still be running gets Kaplan-Meier.
 *     The normal approximation `harness.describeError` uses is fine for a genuine mean and
 *     wrong for all three, in a way that is invisible unless someone checks the edges: it
 *     reports +/-0 at p = 0, which reads as certainty produced by having no evidence.
 *  2. **A move is harvested, not assumed.** `harvestMoves` reads route changes out of rows
 *     `accountFallback` already wrote. This file drives real observations into a real
 *     SQLite store, lets the real cache observer persist them, and then asks the measure
 *     what it found — because the failure mode I-5 exists to prevent (counting inter-turn
 *     gaps and calling the result a return rate) is invisible to a test that hands the
 *     measure its own rows.
 *
 * Nothing here is real evidence about any provider: the sessions are the harness's own
 * synthetic ones, and the population labels are asserted to say so.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { bootstrapMeanCI, kaplanMeier, seededRandom, wilsonInterval, Z95 } from "../../continuity/evidence/stats.js";
import { harvestMoves, measureReturnRate } from "../../continuity/evidence/measures/returnRate.js";
import { observeCacheResult, RESULT_STATUS } from "../../continuity/cache/observer.js";
import { createMemorySource, loadCacheModels } from "../../continuity/cache/pricing/index.js";
import { DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";
import { openHarness, removeTmpDir, turnRequest, messages, SYSTEM, TOOLS } from "./helpers/harness.js";

const NOW = 1_700_000_000_000;

const VENDOR_YAML = [
  "provider: vendor",
  "mechanism: explicit",
  "breakpoints: 4",
  "min_cacheable_tokens: 1",
  "ttl_default_s: 300",
  "write_multiplier_default: 1.25",
  "read_multiplier: 0.1",
  "reports_cache_read: true",
  "reports_cache_write: true",
  "verification_method: documentation",
  "verified_at: 2023-11-10",
  "verified_by: test fixture",
  "source: https://example.invalid/docs",
  "version: 1",
].join("\n");

const DEFAULT_YAML = ["provider: default", "mechanism: none", "version: 1"].join("\n");

const registry = (now = NOW) =>
  loadCacheModels({ source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }), now, policy: DEFAULT_CACHE_POLICY });

describe("A — Wilson, where the normal approximation stops being honest", () => {
  it("stays inside [0, 100] and keeps a width at p = 0 and p = 1", () => {
    const none = wilsonInterval(0, 8);
    expect(none.mean).toBe(0);
    expect(none.low_pct).toBe(0);
    // The whole reason for this estimator: 0 of 8 is not "0% +/- 0%". A normal
    // approximation says it is, and a reader would take that for a measured certainty.
    expect(none.high_pct).toBeGreaterThan(20);

    const all = wilsonInterval(8, 8);
    expect(all.mean).toBe(100);
    expect(all.high_pct).toBe(100);
    expect(all.low_pct).toBeLessThan(80);
  });

  it("reports the observed proportion as the point estimate, not the Wilson centre", () => {
    const out = wilsonInterval(1, 10);
    expect(out.mean).toBe(10);
    // The centre the interval is actually built around is shifted toward 50%; a reader
    // checking the arithmetic needs to find it, and must not find it in `mean`.
    expect(out.wilson_centre_pct).toBeGreaterThan(out.mean);
    expect(out.band).toBe(`10% +/- ${out.high_pct - out.mean}%`);
    expect(out.basis).toBe("Wilson score interval, 95%, n=10");
  });

  it("narrows as n grows, at the same proportion", () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);
    expect(large.high_pct - large.low_pct).toBeLessThan(small.high_pct - small.low_pct);
  });

  it("refuses rather than inventing a band", () => {
    for (const bad of [[0, 0], [1, 0], [-1, 5], [6, 5], [Number.NaN, 5]]) {
      expect(wilsonInterval(bad[0], bad[1])).toEqual({ band: "unavailable", basis: "no observations" });
    }
  });

  it("Z95 is the two-sided 95% quantile", () => {
    expect(Z95).toBeCloseTo(1.959964, 6);
  });
});

describe("B — the cluster bootstrap resamples sessions, not turns", () => {
  it("refuses below two clusters instead of returning a zero-width interval", () => {
    const one = bootstrapMeanCI([[100, 100, 100, 100]]);
    expect(one.band).toBe("unavailable");
    expect(one.basis).toMatch(/clusters=1/);
    expect(bootstrapMeanCI([]).band).toBe("unavailable");
    // Two clusters that each hold one value is two independent units: enough to speak.
    expect(bootstrapMeanCI([[0], [100]]).band).not.toBe("unavailable");
  });

  it("is wider than the same values split into more, smaller clusters would suggest", () => {
    const values = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 0));
    // Same 40 observations. Two sessions that disagree carry far less information about
    // sessions than 20 sessions that disagree, and the band has to say so.
    const twoSessions = bootstrapMeanCI([values.slice(0, 20).fill(100), values.slice(20).fill(0)], { seed: 7 });
    const twentySessions = bootstrapMeanCI(
      Array.from({ length: 20 }, (_, i) => [i % 2 === 0 ? 100 : 0, i % 2 === 0 ? 100 : 0]),
      { seed: 7 },
    );
    expect(twoSessions.high - twoSessions.low).toBeGreaterThan(twentySessions.high - twentySessions.low);
  });

  it("is reproducible from its seed, and says so in the basis", () => {
    const clusters = [[1, 2, 3], [10, 11], [5], [7, 8, 9]];
    const a = bootstrapMeanCI(clusters, { seed: 20260901, iterations: 500 });
    const b = bootstrapMeanCI(clusters, { seed: 20260901, iterations: 500 });
    expect(a).toEqual(b);
    expect(a.basis).toMatch(/seed=20260901/);
    expect(a.basis).toMatch(/clusters=4, values=9/);
    expect(bootstrapMeanCI(clusters, { seed: 1, iterations: 500 })).not.toEqual(a);
  });

  it("drops non-numeric values without letting one poison the mean", () => {
    const out = bootstrapMeanCI([[1, Number.NaN, 3], [2, "x"], [4]], { seed: 3 });
    expect(out.n).toBe(4);
    expect(out.mean).toBe(2.5);
  });

  it("seededRandom is deterministic and stays in [0, 1)", () => {
    const a = Array.from({ length: 5 }, seededRandom(42));
    const b = Array.from({ length: 5 }, seededRandom(42));
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("C — Kaplan-Meier keeps a run that has not ended in the risk set", () => {
  it("censored observations raise survival rather than being dropped", () => {
    const events = [{ duration: 2, event: true }, { duration: 4, event: true }, { duration: 6, event: true }];
    const withCensored = [...events, { duration: 10, event: false }, { duration: 12, event: false }];
    const a = kaplanMeier(events);
    const b = kaplanMeier(withCensored);
    expect(a.censored).toBe(0);
    expect(b.censored).toBe(2);
    // Same three events; the two runs still going make survival at the last event higher.
    expect(b.survival_at_horizon).toBeGreaterThan(a.survival_at_horizon);
  });

  it("says 'median not reached' instead of inventing one", () => {
    const out = kaplanMeier([
      { duration: 5, event: true },
      { duration: 30, event: false },
      { duration: 40, event: false },
      { duration: 50, event: false },
    ], { unit: " turns" });
    expect(out.median).toBe(null);
    expect(out.median_reached).toBe(false);
    // "More than half were still unbroken when we stopped watching" is a real answer.
    expect(out.band).toBe("median not reached (> 50 turns)");
  });

  it("finds the median when survival does cross a half", () => {
    const out = kaplanMeier([
      { duration: 1, event: true },
      { duration: 2, event: true },
      { duration: 3, event: true },
      { duration: 4, event: false },
    ], { unit: " ms" });
    expect(out.median_reached).toBe(true);
    expect(out.band).toMatch(/^median 2 ms \(KM, n=4, events=3\)$/);
    expect(out.basis).toMatch(/censored=1/);
  });

  it("restricts the mean to the observed window and never reports an unrestricted one", () => {
    const out = kaplanMeier([{ duration: 10, event: true }, { duration: 20, event: false }]);
    expect(out.restricted_mean).toBeLessThanOrEqual(out.horizon);
    expect(out).not.toHaveProperty("mean");
    expect(out.curve).toEqual([{ t: 10, at_risk: 2, events: 1, survival: 0.5 }]);
  });

  it("refuses with no observations, and ignores unusable rows", () => {
    expect(kaplanMeier([]).band).toBe("unavailable");
    expect(kaplanMeier([{ duration: -1, event: true }, { duration: "x", event: true }]).band).toBe("unavailable");
  });
});

/**
 * The move harvest, against rows the real observer wrote.
 *
 * `record` is the same call `cacheObserver` makes on the live path, so the columns
 * `harvestMoves` reads are the columns production fills in. Two results on one observation
 * share a `turn_idx` and differ in `seq`, which is exactly the shape `accountFallback`
 * leaves behind when its first attempt did not serve the turn.
 */
describe("D — moves harvested from turn_results, not from gaps", () => {
  let h;
  beforeEach(async () => {
    h = await openHarness({ tag: "m2-moves", start: NOW });
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  const record = (observation, { provider, pricingKey = "vendor", status = RESULT_STATUS.OK }) =>
    observeCacheResult({
      store: h.store,
      clock: h.clock,
      registry: registry(),
      observation,
      result: {
        provider,
        pricing_key: pricingKey,
        model: `${provider}-model`,
        status,
        http_status: status === RESULT_STATUS.OK ? 200 : 500,
        usage: { input: 100, cache_read: 10 },
        at: h.at(),
      },
    });

  it("an in-turn fallback and a later return are both read off the rows", async () => {
    const first = await h.observe(turnRequest({ msgs: messages(2), system: SYSTEM, tools: TOOLS }));
    // Attempt 0 failed, attempt 1 served the turn: one forced move, inside one turn.
    await record(first, { provider: "alpha", status: RESULT_STATUS.ERROR });
    await record(first, { provider: "beta" });
    h.tick(60_000);
    const second = await h.observe(turnRequest({ msgs: messages(4), system: SYSTEM, tools: TOOLS }));
    await record(second, { provider: "alpha" });

    const rows = h.store.turnResults.routeSequence(h.db, { since: 0 });
    expect(rows).toHaveLength(3);
    const moves = harvestMoves(rows, () => 300);

    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({
      from: "alpha/alpha-model",
      to: "beta/beta-model",
      move_cause: "in_turn_fallback",
      from_status: RESULT_STATUS.ERROR,
      returned: true,
      // 60 s away, against a 300 s window: the return beat the window it left.
      returned_within_ttl: true,
    });
    expect(moves[0].duration_ms).toBe(60_000);
    expect(moves[1]).toMatchObject({ from: "beta/beta-model", to: "alpha/alpha-model", move_cause: "between_turns", returned: false });
    // Nothing came back to beta before the log ended: censored, not refused.
    expect(moves[1].event).toBe(false);
  });

  it("a session that never returns is censored at its last row, not counted as a refusal", async () => {
    const obs = await h.observe(turnRequest({ msgs: messages(2) }));
    await record(obs, { provider: "alpha" });
    h.tick(1_000_000);
    const later = await h.observe(turnRequest({ msgs: messages(4) }));
    await record(later, { provider: "beta" });

    const moves = harvestMoves(h.store.turnResults.routeSequence(h.db, { since: 0 }), () => 300);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ returned: false, event: false, returned_within_ttl: null });
    expect(moves[0].duration_ms).toBe(0);
  });

  it("no verified TTL means the return is unjudgeable, not late", async () => {
    const obs = await h.observe(turnRequest({ msgs: messages(2) }));
    await record(obs, { provider: "alpha" });
    await record(obs, { provider: "beta" });
    h.tick(5000);
    const later = await h.observe(turnRequest({ msgs: messages(4) }));
    await record(later, { provider: "alpha" });

    const moves = harvestMoves(h.store.turnResults.routeSequence(h.db, { since: 0 }), () => null);
    expect(moves[0].returned).toBe(true);
    // I4: with no window to judge against, "inside the window" is unknown, never false.
    expect(moves[0].returned_within_ttl).toBe(null);
  });

  it("a route that never changes produces no moves at all", async () => {
    const obs = await h.observe(turnRequest({ msgs: messages(2) }));
    await record(obs, { provider: "alpha" });
    h.tick(1000);
    const later = await h.observe(turnRequest({ msgs: messages(4) }));
    await record(later, { provider: "alpha" });
    expect(harvestMoves(h.store.turnResults.routeSequence(h.db, { since: 0 }), () => 300)).toEqual([]);
  });

  it("rows from different sessions never form a move across the boundary", () => {
    const rows = [
      { session_id: "s1", turn_idx: 0, seq: 0, at: 1, provider: "alpha", model: "m", pricing_key: "vendor" },
      { session_id: "s2", turn_idx: 0, seq: 0, at: 2, provider: "beta", model: "m", pricing_key: "vendor" },
    ];
    expect(harvestMoves(rows, () => 300)).toEqual([]);
  });

  it("the measure reports P(return) with a Wilson band and names the opportunity measure apart", async () => {
    const first = await h.observe(turnRequest({ msgs: messages(2) }));
    await record(first, { provider: "alpha" });
    await record(first, { provider: "beta" });
    h.tick(30_000);
    const second = await h.observe(turnRequest({ msgs: messages(4) }));
    await record(second, { provider: "alpha" });

    const out = measureReturnRate({ store: h.store, registry: registry(), pricingKey: "vendor" });

    expect(out.status).toBe("ok");
    expect(out.moves).toBe(2);
    expect(out.moves_in_turn_fallback).toBe(1);
    expect(out.moves_between_turns).toBe(1);
    expect(out.returns_observed).toBe(1);
    expect(out.p_return_after_move_pct).toBe(50);
    expect(out.p_return_error.basis).toMatch(/^Wilson score interval, 95%, n=2$/);
    // The two quantities stay distinct: an inter-turn gap is opportunity, not a return.
    expect(out).toHaveProperty("gap_within_ttl_pct");
    expect(out).not.toHaveProperty("return_rate_pct");
    // Real rows, so `n` counts them; nothing synthetic is folded in.
    expect(out.population).toBe("real");
    expect(out.n).toBe(out.gaps + out.moves);
    expect(out.n_synthetic).toBe(0);
    expect(out.time_to_return_ms.basis).toMatch(/^Kaplan-Meier with right-censoring/);
    expect(out.notes.join(" ")).toMatch(/harvested from turn_results/);
  });

  it("`since` excludes older rows from the harvest", async () => {
    const first = await h.observe(turnRequest({ msgs: messages(2) }));
    await record(first, { provider: "alpha" });
    await record(first, { provider: "beta" });
    const cut = h.tick(10_000);
    const second = await h.observe(turnRequest({ msgs: messages(4) }));
    await record(second, { provider: "gamma" });
    await record(second, { provider: "delta" });

    const out = measureReturnRate({ store: h.store, registry: registry(), pricingKey: "vendor", since: cut });
    expect(out.moves).toBe(1);
    expect(out.moves_observed[0]).toMatchObject({ from: "gamma/gamma-model", to: "delta/delta-model" });
  });
});
