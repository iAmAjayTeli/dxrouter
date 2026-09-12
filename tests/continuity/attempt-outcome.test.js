/**
 * M2 group D — a failed provider attempt, from the fact to the measurement (Q3).
 *
 * 9Router's `accountFallback` produces failed attempts on its own: a 429 from one account,
 * a refused socket, a 500, and then the next account serves the turn. Before this milestone
 * none of that reached the observation data, so Q3's own question — after traffic is
 * *forced* off a route, does the session come back to it? — had no forced moves to measure.
 *
 * The rule every test here is about: a failed attempt is an attempt that reported nothing.
 * It is not a measured zero, not a successful observation with empty usage, and not evidence
 * about a provider's cache. The three ways that could go wrong are each pinned below:
 *
 *   1. usage — absent stays NULL and `usage_provenance` stays `unavailable` (I4);
 *   2. belief — the classifier returns `unknown`/`attempt_failed`, and no `cache_entries`
 *      row is written, so a failure can neither create a belief nor disturb one;
 *   3. denominator — a failure is an `attempt` and never a `response`, so Q1's coverage
 *      percentage cannot read an outage as a provider that stays silent about its cache.
 *
 * The store is a real SQLite file and the observations are real M1 observations, because
 * every claim is a claim about a persisted row. The classification path is the shipped
 * adapter (`observeProviderResult` → `describeFailure`), not a hand-written `error_class`:
 * the taxonomy mapping is exactly the part that would otherwise be asserted twice and
 * implemented nowhere.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CACHE_CONFIDENCE,
  CACHE_EVIDENCE,
  assertConfidenceEvidence,
  raiseWithEvidence,
} from "../../continuity/cache/confidence.js";
import {
  NO_ENTRIES,
  RESULT_STATUS,
  classifyCacheResult,
  planEvidenceEntries,
  usageProvenance,
} from "../../continuity/cache/observer.js";
import { DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";
import { createMemorySource, loadCacheModels } from "../../continuity/cache/pricing/index.js";
import { measureCoverage } from "../../continuity/evidence/measures/coverage.js";
import { harvestMoves, measureReturnRate } from "../../continuity/evidence/measures/returnRate.js";
import { TOKEN_PROVENANCE } from "../../continuity/prefix/tokens.js";
import { classifyStatus, classifyThrown, describeFailure, parseRetryAfter } from "../../adapters/ninerouter/failureFields.js";
import { observeProviderResult } from "../../adapters/ninerouter/cacheObserver.js";

import { messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

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

function registry(now = NOW) {
  return loadCacheModels({
    source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }),
    now,
    policy: DEFAULT_CACHE_POLICY,
  });
}

/** A provider's own usage object, in the shape an OpenAI-compatible upstream sends. */
const PROVIDER_USAGE = { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } };

let h;

beforeEach(async () => {
  h = await openHarness({ tag: "m2-outcome" });
});

afterEach(() => {
  const dir = h?.dir;
  h?.close();
  if (dir) removeTmpDir(dir);
});

/** One M1 observation for turn `i` of one session, through the live observer. */
function observe(i, { key = "s-fallback", root = "/repo/one" } = {}) {
  h.tick(1000);
  return h.observe(turnRequest({ key, root, msgs: messages(i * 2 + 1, "attempt ") }));
}

/**
 * Report one provider result the way the request path does: raw facts in, no `error_class`,
 * and the adapter doing the classifying. `provider: "vendor"` maps to no alias, so the
 * pricing key falls back to the provider name and resolves the vendor record; `"other"`
 * resolves `default` (`mechanism: none`), which is the I4 path.
 */
function report(observation, result) {
  return observeProviderResult({
    observation,
    result: { provider: "vendor", model: "vendor-model", at: h.at(), ...result },
    store: h.store,
    registry: registry(),
    clock: h.clock,
    // No env: the usage-field evidence writer is opt-in and must stay off in a test.
    env: {},
  });
}

const lastRow = () => h.db.get("SELECT * FROM turn_results ORDER BY at DESC, seq DESC LIMIT 1");
const countEntries = () => Number(h.db.get("SELECT COUNT(*) AS n FROM cache_entries")?.n) || 0;

describe("Q3-A — a failed attempt is an attempt that reported nothing", () => {
  it("records a clean attempt as a response, with the numbers the provider sent", async () => {
    const observation = await observe(0);
    const record = await report(observation, { status: RESULT_STATUS.OK, http_status: 200, usage: PROVIDER_USAGE });

    expect(record).toMatchObject({
      observed: true,
      failed: false,
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
      error_class: null,
    });
    expect(record.entries.length).toBeGreaterThan(0);

    // A row that did not fail carries no failure columns at all. Four zeros would read as
    // "it failed in 0ms with no error class", which is a different statement.
    expect(lastRow()).toMatchObject({
      status: RESULT_STATUS.OK,
      http_status: 200,
      usage_in: 1000,
      usage_cache_read: 800,
      usage_provenance: TOKEN_PROVENANCE.MEASURED,
      error_class: null,
      retry_after_s: null,
      ttfb_ms: null,
      total_ms: null,
    });
  });

  it("records a failed attempt with the facts it had, and no usage it did not have", async () => {
    const observation = await observe(0);
    const record = await report(observation, {
      status: RESULT_STATUS.ERROR,
      http_status: 429,
      headers: new Headers({ "retry-after": "30" }),
      total_ms: 812,
      usage: null,
    });

    expect(record).toMatchObject({
      observed: true,
      failed: true,
      // Not `assumed`: we sent a cacheable prefix to a provider with a verified mechanism,
      // and then nothing came back. The prefix was not observed either way.
      confidence: CACHE_CONFIDENCE.UNKNOWN,
      evidence: CACHE_EVIDENCE.ATTEMPT_FAILED,
      error_class: "rate_limit",
      skipped: NO_ENTRIES.ATTEMPT_FAILED,
    });
    expect(record.entries).toEqual([]);
    expect(countEntries()).toBe(0);

    expect(lastRow()).toMatchObject({
      status: RESULT_STATUS.ERROR,
      http_status: 429,
      // Null, not 0. There is no measured zero here: no usage object arrived at all.
      usage_in: null,
      usage_out: null,
      usage_cache_read: null,
      usage_cache_write: null,
      usage_provenance: TOKEN_PROVENANCE.UNAVAILABLE,
      cache_confidence: CACHE_CONFIDENCE.UNKNOWN,
      // The retry hint the provider actually gave, in seconds, and the timing the host had.
      error_class: "rate_limit",
      retry_after_s: 30,
      total_ms: 812,
      // No first byte ever arrived, so there is no TTFB to record.
      ttfb_ms: null,
    });
  });

  it("stores no provider message anywhere on the failed row", async () => {
    const observation = await observe(0);
    await report(observation, {
      status: RESULT_STATUS.ERROR,
      http_status: 503,
      error: { name: "Error", message: "upstream said: account 12345 is suspended" },
      usage: null,
    });

    const row = lastRow();
    expect(row.error_class).toBe("server");
    // Section 14: the taxonomy is stored, the prose is not — in any column, under any name.
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain("suspended");
      expect(value).not.toContain("12345");
    }
  });

  it("writes no belief for a failure, and does not disturb one already written", async () => {
    const observation = await observe(0);
    await report(observation, { status: RESULT_STATUS.OK, http_status: 200, usage: PROVIDER_USAGE });
    const before = h.db.all("SELECT layer, confidence, evidence FROM cache_entries ORDER BY layer");
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((e) => e.confidence === CACHE_CONFIDENCE.CONFIRMED)).toBe(true);

    // Same session, same prefix, next attempt dies. The provider did report a read once and
    // that happened; a later outage is not evidence against it.
    h.tick(1000);
    const failure = await report(observation, { status: RESULT_STATUS.ERROR, http_status: 500, usage: null });

    expect(failure.entries).toEqual([]);
    expect(h.db.all("SELECT layer, confidence, evidence FROM cache_entries ORDER BY layer")).toEqual(before);
    // Both attempts are on the record, as separate rows of the same turn.
    expect(Number(h.db.get("SELECT COUNT(*) AS n FROM turn_results")?.n)).toBe(2);
  });

  it("keeps a cache read the provider did report before it died", async () => {
    const observation = await observe(0);
    // A stream that reported cached tokens and *then* broke: the number is a measurement
    // whichever way the attempt ended, so it outranks the failure.
    const record = await report(observation, {
      status: RESULT_STATUS.ERROR,
      http_status: null,
      error: { name: "Error", message: "socket hang up" },
      usage: PROVIDER_USAGE,
    });

    expect(record).toMatchObject({
      failed: true,
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
      error_class: "server",
    });
    // Still no `cache_entries` row: a belief is not updated from an attempt that failed,
    // even one that reported a read. `skipped` says which rule did that.
    expect(record.skipped).toBe(NO_ENTRIES.ATTEMPT_FAILED);
    expect(countEntries()).toBe(0);
  });

  it("puts the failure rule between the reported counts and the mechanism", () => {
    const failed = { failed: true, mechanism: "explicit" };
    expect(classifyCacheResult({ ...failed, usage: {} })).toMatchObject({
      confidence: CACHE_CONFIDENCE.UNKNOWN,
      evidence: CACHE_EVIDENCE.ATTEMPT_FAILED,
    });
    // A reported read outranks the failure; the failure outranks "no cache model", because
    // what such a row is evidence of is the failure.
    expect(classifyCacheResult({ ...failed, usage: { cache_read: 900 } }).evidence).toBe(CACHE_EVIDENCE.PROVIDER_REPORTED_READ);
    expect(classifyCacheResult({ failed: true, mechanism: "none", usage: {} }).evidence).toBe(CACHE_EVIDENCE.ATTEMPT_FAILED);
    // And a *reported* zero on a failed attempt is still not a cache read.
    expect(classifyCacheResult({ ...failed, usage: { cache_read: 0 } })).toMatchObject({
      confidence: CACHE_CONFIDENCE.UNKNOWN,
      evidence: CACHE_EVIDENCE.ATTEMPT_FAILED,
      reported: true,
    });
    expect(usageProvenance({ input: null, output: null, cache_read: null, cache_write: null })).toBe(TOKEN_PROVENANCE.UNAVAILABLE);
  });

  it("cannot raise or demote a belief with a failed attempt", () => {
    expect(raiseWithEvidence(CACHE_CONFIDENCE.CONFIRMED, CACHE_EVIDENCE.ATTEMPT_FAILED)).toBe(CACHE_CONFIDENCE.CONFIRMED);
    expect(raiseWithEvidence(CACHE_CONFIDENCE.ASSUMED, CACHE_EVIDENCE.ATTEMPT_FAILED)).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(raiseWithEvidence(CACHE_CONFIDENCE.UNKNOWN, CACHE_EVIDENCE.ATTEMPT_FAILED)).toBe(CACHE_CONFIDENCE.UNKNOWN);
    // Nothing at all becomes `unknown`, never `assumed` by fall-through.
    expect(raiseWithEvidence(undefined, CACHE_EVIDENCE.ATTEMPT_FAILED)).toBe(CACHE_CONFIDENCE.UNKNOWN);
    // And I3 still refuses the one write that would matter.
    expect(() => assertConfidenceEvidence(CACHE_CONFIDENCE.CONFIRMED, CACHE_EVIDENCE.ATTEMPT_FAILED)).toThrow(/provider evidence/);
    // One string for one fact, so a reader of `skipped` and a reader of `evidence` are
    // looking at the same vocabulary.
    expect(NO_ENTRIES.ATTEMPT_FAILED).toBe(CACHE_EVIDENCE.ATTEMPT_FAILED);
  });

  it("skips the entry plan on failure even when the layers were eligible", async () => {
    const pricing = registry().get("vendor");
    // The layers M1 actually recorded for a real turn, so the only difference between the
    // two plans below is the one flag under test.
    const { layers } = await observe(0);
    const ok = planEvidenceEntries({ pricing, layers, usage: { cache_read: 800 }, failed: false });
    expect(ok.skipped).toBe(null);
    expect(ok.planned.length).toBeGreaterThan(0);

    const failed = planEvidenceEntries({ pricing, layers, usage: { cache_read: 800 }, failed: true });
    expect(failed.skipped).toBe(NO_ENTRIES.ATTEMPT_FAILED);
    expect(failed.planned).toEqual([]);
  });
});

/**
 * The taxonomy lives in the adapter layer, because naming a 429 `rate_limit` is neither a
 * fact the request path has nor a column the engine stores. These are the mappings the
 * observation data will be read through, so they are asserted rather than assumed.
 */
describe("Q3-B — classification of what the host actually had", () => {
  it("maps the statuses a provider returns to the closed taxonomy", () => {
    const classOf = (http_status) => describeFailure({ http_status }).error_class;
    expect(classOf(400)).toBe("schema");
    expect(classOf(404)).toBe("schema");
    expect(classOf(401)).toBe("auth");
    expect(classOf(403)).toBe("auth");
    expect(classOf(402)).toBe("quota");
    expect(classOf(408)).toBe("timeout");
    expect(classOf(429)).toBe("rate_limit");
    expect(classOf(500)).toBe("server");
    expect(classOf(504)).toBe("timeout");
    // Unmapped is `unknown`, never the nearest neighbour: a guess in this column would be
    // read later as a measurement.
    expect(classOf(418)).toBe("unknown");
    // A success has no failure class at all.
    expect(classifyStatus(200)).toBe(null);
  });

  it("classifies a transport failure by shape when there is no status", () => {
    expect(describeFailure({ error: { name: "AbortError" } }).error_class).toBe("timeout");
    expect(describeFailure({ error: { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:443" } }).error_class).toBe("server");
    expect(describeFailure({ error: { name: "Error", message: "socket hang up" } }).error_class).toBe("server");
    expect(describeFailure({ error: { name: "Error", message: "something odd" } }).error_class).toBe("unknown");
    expect(classifyThrown({ name: "TimeoutError" })).toBe("timeout");
    // The status the provider returned outranks a guess from an error shape, and with
    // neither the honest answer is that we do not know how it ended.
    expect(describeFailure({ http_status: 429, error: { name: "AbortError" } }).error_class).toBe("rate_limit");
    expect(describeFailure({}).error_class).toBe("unknown");
  });

  it("reads a retry hint only when the provider gave one", () => {
    const at = 1_700_000_000_000;
    expect(parseRetryAfter(new Headers({ "retry-after": "30" }))).toBe(30);
    expect(parseRetryAfter(new Headers({ "x-ratelimit-reset-after": "12" }))).toBe(12);
    expect(parseRetryAfter(new Headers({ "retry-after": new Date(at + 45_000).toUTCString() }), { now: at })).toBe(45);
    // Absent is null, not 0: "no retry hint" and "retry immediately" are different answers.
    expect(parseRetryAfter(new Headers({}))).toBe(null);
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter(new Headers({ "retry-after": "not a number" }))).toBe(null);
  });

  it("records only the timings it was given", () => {
    expect(describeFailure({ http_status: 500, ttfb_ms: 12.7, total_ms: 900.2 })).toMatchObject({ ttfb_ms: 13, total_ms: 900 });
    expect(describeFailure({ http_status: 500 })).toMatchObject({ ttfb_ms: null, total_ms: null, retry_after_s: null });
  });
});

/**
 * What the rows then support. The fallback here is the shape 9Router already produces: an
 * attempt that fails inside a turn, a second attempt on another route that serves it, and a
 * later turn back on the first route. Nothing in this file causes a move — the rows are
 * written from reported facts, and the measure reads them.
 */
describe("Q3-C — moves, returns and denominators from the persisted rows", () => {
  /** One session: ok, then a 429 with an in-turn fallback, then back to the first route. */
  async function fallbackSession() {
    const t0 = await observe(0);
    await report(t0, { status: RESULT_STATUS.OK, http_status: 200, usage: PROVIDER_USAGE });

    const t1 = await observe(1);
    await report(t1, {
      status: RESULT_STATUS.ERROR,
      http_status: 429,
      headers: new Headers({ "retry-after": "60" }),
      ttfb_ms: null,
      total_ms: 240,
      usage: null,
    });
    h.tick(2000);
    // The next account served the turn: same turn index, next seq, different route.
    await report(t1, { provider: "other", model: "other-model", status: RESULT_STATUS.OK, http_status: 200, usage: null });

    const t2 = await observe(2);
    await report(t2, { status: RESULT_STATUS.OK, http_status: 200, usage: PROVIDER_USAGE });
  }

  it("reads the attempt back with the outcome columns, in route order", async () => {
    await fallbackSession();
    const rows = h.store.turnResults.routeSequence(h.db, {});
    expect(rows.map((r) => [r.turn_idx, r.seq, r.provider, r.status])).toEqual([
      [0, 0, "vendor", "ok"],
      [1, 0, "vendor", "error"],
      [1, 1, "other", "ok"],
      [2, 0, "vendor", "ok"],
    ]);
    // The failed attempt carries what was known at failure time and nothing else.
    expect(rows[1]).toMatchObject({ http_status: 429, error_class: "rate_limit", retry_after_s: 60, total_ms: 240, ttfb_ms: null });
    expect(rows[2]).toMatchObject({ error_class: null, retry_after_s: null, usage_provenance: "unavailable" });
  });

  it("calls a same-turn fallback an in-turn move and a later change between turns", async () => {
    await fallbackSession();
    const moves = harvestMoves(h.store.turnResults.routeSequence(h.db, {}), () => 300);

    expect(moves.map((m) => m.move_cause)).toEqual(["in_turn_fallback", "between_turns"]);
    expect(moves[0]).toMatchObject({
      from: "vendor/vendor-model",
      to: "other/other-model",
      // The status of the attempt the move left, so a reader can see it followed a failure.
      // Not a cause claim: M2 records no reason for a move.
      from_status: "error",
      returned: true,
      event: true,
    });
    // The second move ended the session away from `other`, so it is censored — not a refusal
    // to come back, an observation that stopped.
    expect(moves[1]).toMatchObject({ from: "other/other-model", to: "vendor/vendor-model", returned: false, event: false });
  });

  it("keeps P(return) and the gap opportunity measure as two different numbers", async () => {
    await fallbackSession();
    const result = measureReturnRate({ store: h.store, registry: registry(), pricingKey: "vendor" });

    expect(result.status).toBe("ok");
    expect(result.population).toBe("real");
    expect(result).toMatchObject({
      moves: 2,
      moves_in_turn_fallback: 1,
      moves_between_turns: 1,
      returns_observed: 1,
      // The real Q3 quantity: of the observed moves, how many went back to the route left.
      p_return_after_move_pct: 50,
      moves_censored: 1,
      // The opportunity measure, over inter-turn gaps against a verified window. It is a
      // different question and keeps a different name.
      gap_within_ttl_pct: 100,
    });
    // The old name for the opportunity measure overstated it as a return rate, and must not
    // reappear under either heading.
    expect("return_rate_pct" in result).toBe(false);
    // Only the move whose abandoned route has a verified TTL can be judged against one; the
    // `other` route has no cache model, so it contributes to neither side (I4).
    expect(result).toMatchObject({ judgeable_moves: 1, returns_within_ttl: 1, return_within_ttl_pct: 100 });
    expect(result.time_to_return_ms).toBeTruthy();
    expect(result.error.band).not.toBe("unavailable");
  });

  it("counts a failure as an attempt and never as a response", async () => {
    await fallbackSession();
    const coverage = measureCoverage({ store: h.store, since: 0 });

    // Four attempts were made and three responses came back, so Q1 asks its question of
    // three. Counting the 429 as a fourth would read an outage as a provider that stayed
    // silent about its cache fields.
    expect(coverage).toMatchObject({ status: "ok", population: "real", n: 3, attempts: 4, attempts_failed: 1 });
    expect(coverage.read_coverage_pct).toBe(Math.round((2 / 3) * 1000) / 10);
    expect(coverage.provenance).toMatchObject({ measured: 2, estimated: 0, unavailable: 1 });
    expect(coverage.notes.join(" ")).toContain("not provider silence");

    const vendor = coverage.by_provider.find((r) => r.provider === "vendor");
    expect(vendor).toMatchObject({ attempts: 3, failed: 1, n: 2, reported_read: 2, read_coverage_pct: 100 });
    // The vendor-level view groups by what the adapter mapped the alias to, and both rows
    // stay visible because neither alias maps into the other.
    expect(coverage.by_pricing_key.map((r) => r.provider).sort()).toEqual(["other", "vendor"]);
  });
});
