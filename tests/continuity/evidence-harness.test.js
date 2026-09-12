/**
 * M2 group D — the evidence harness (§19.4), tested for the property that matters most:
 * that it says "I don't know" out loud.
 *
 * Every other suite here checks that the engine computes the right number. This one
 * checks the opposite — that when the number cannot honestly be computed, the harness
 * produces a `blocked` run with a reason rather than a zero, and that a run cannot grade
 * itself. `n = 0` with `status: blocked` and `n = 0` with `status: ok` mean completely
 * different things to a reviewer, and the difference is the whole point of §19.4.
 *
 * The measures are reducers, so most of them are fed hand-built replay objects: that is
 * the honest way to test a reducer's edges (a 20 %-off prediction, a population with one
 * project kind). Two tests replay the committed fixtures end-to-end so the pipeline
 * itself — M1 layers, ledger belief, `planEvidenceEntries` — is covered by something the
 * repository actually ships.
 */

import fs from "node:fs";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  BLOCKED_REASON,
  ENGINE_VERSION,
  HARNESS_VERSION,
  MEASURE_NAMES,
  M3_GATE,
  QUESTION_IDS,
  RUN_STATUS,
  buildExperimentRow,
  describeError,
  describeInputs,
  evaluateGate,
  measureArithmeticAccuracy,
  measureCacheProbe,
  measureCoverage,
  measurePrefixStability,
  measureReturnRate,
  measureStatus,
  planProbe,
  probeFiller,
  questionForMeasure,
  replayFixture,
  reportFilename,
  renderReport,
  runId,
  runMeasure,
  MeasureError,
} from "../../continuity/evidence/index.js";
import { createMemorySource, loadCacheModels } from "../../continuity/cache/pricing/index.js";
import { DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";
import { observeCacheResult } from "../../continuity/cache/observer.js";
import { CONTINUITY_SCHEMA_VERSION } from "../../continuity/store/sqlite/schema.js";

import { messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const NOW = 1_700_000_000_000;

const VENDOR_YAML = [
  "provider: vendor",
  "mechanism: explicit",
  "breakpoints: 4",
  "min_cacheable_tokens: 1024",
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

const REGISTRY = loadCacheModels({
  source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }),
  now: NOW,
  policy: DEFAULT_CACHE_POLICY,
});

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/cache/${name}.json`, import.meta.url), "utf8"));

/** A replay object shaped like `replayFixture`'s output, for reducer edges. */
function fakeReplay({ id = "f1", source = "synthetic", kind = "kind-a", basis = null, turns = [] } = {}) {
  return {
    fixture_id: id,
    fixture_source: source,
    project_kind: kind,
    expectation_basis: basis,
    pricing_key: "vendor",
    provider: "vendor",
    model: "m",
    mechanism: "explicit",
    n: turns.length,
    turns,
  };
}

describe("D — a stated band, or an honest refusal to state one", () => {
  it("refuses a band below two observations", () => {
    expect(describeError({ n: 1, values: [5] })).toMatchObject({ band: "unavailable", basis: "sample too small" });
    expect(describeError({ n: 0, values: [] }).band).toBe("unavailable");
    // A single observation dressed as a zero-width interval is the most misleading
    // number the harness could emit, so it is unrepresentable rather than discouraged.
    expect(describeError({ n: 5, values: [7] }).band).toBe("unavailable");
  });

  it("states the band, its basis and the distribution behind it", () => {
    const out = describeError({ n: 4, values: [10, 12, 14, 16], unit: "%" });
    expect(out.band).toMatch(/^13 \+\/- [\d.]+%$/);
    expect(out.basis).toBe("normal approximation, 95%");
    expect(out).toMatchObject({ mean: 13, min: 10, max: 16 });
    expect(out.sd).toBeGreaterThan(0);
  });
});

describe("D — an experiments row cannot grade itself", () => {
  const result = { measure: "coverage", question: "Q1", status: RUN_STATUS.OK, n: 12, error: { band: "50 +/- 4%" } };

  it("always writes verdict: pending, with both versions and the band", () => {
    const row = buildExperimentRow({ measure: "coverage", result, ran_at: NOW, notes: ["a", "b"] });
    expect(row).toMatchObject({
      question: "Q1",
      measure: "coverage",
      verdict: "pending",
      harness_version: HARNESS_VERSION,
      engine_version: ENGINE_VERSION,
      n: 12,
      error_band: "50 +/- 4%",
      reviewed_by: null,
      harness_notes: "a; b",
    });
    // `unblocks` travels with the row so a reader does not have to consult §23 to know
    // what a `sufficient` here would release.
    expect(row.unblocks).toMatch(/M/);
    // Derived, not hardcoded: the point of the assertion is that the recorded row names the
    // schema it was produced under, so a migration that bumps the version should not have to
    // edit this test to stay true.
    expect(ENGINE_VERSION).toMatch(new RegExp(`^m2:schema${CONTINUITY_SCHEMA_VERSION}:`));
  });

  it("refuses a run it could not interpret later", () => {
    expect(() => buildExperimentRow({ result, ran_at: NOW })).toThrow(/measure name/);
    expect(() => buildExperimentRow({ measure: "coverage", result })).toThrow(/injected clock/);
    // A measure answering no numbered question would produce a row nobody could act on.
    expect(() => buildExperimentRow({ measure: "made_up", result: { n: 0 }, ran_at: NOW })).toThrow(/§23/);
  });

  it("files arithmetic_accuracy under the question its own result claims", () => {
    // §23 lists the measure under both Q1 and Q6, and `questionForMeasure` finds Q1
    // first. The measure returns Q6 deliberately — it cannot establish that providers
    // report cache fields, only compare arithmetic on turns where they already did — and
    // the row has to honour that, or an arithmetic check would stand in for the coverage
    // evidence that gates M3.
    expect(questionForMeasure("arithmetic_accuracy")).toBe("Q1");
    const row = buildExperimentRow({
      measure: "arithmetic_accuracy",
      result: { question: "Q6", n: 3, error: { band: "1 +/- 1%" } },
      ran_at: NOW,
    });
    expect(row.question).toBe("Q6");
  });

  it("gives the same run the same id, and two runs in one millisecond different ones", () => {
    expect(runId({ measure: "coverage", ran_at: NOW })).toBe(runId({ measure: "coverage", ran_at: NOW }));
    expect(runId({ measure: "coverage", ran_at: NOW, salt: "b" })).not.toBe(runId({ measure: "coverage", ran_at: NOW }));
    expect(runId({})).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("D — the M3 gate is computed, never asserted", () => {
  it("reports a missing question as missing rather than as failing", () => {
    const gate = evaluateGate([]);
    expect(gate.open).toBe(false);
    expect(gate.questions.map((q) => q.question)).toEqual([...M3_GATE]);
    for (const q of gate.questions) expect(q).toMatchObject({ verdict: "missing", satisfied: false });
  });

  it("does not accept a sufficient verdict with no reviewer", () => {
    const rows = M3_GATE.map((question) => ({ question, verdict: "sufficient", reviewed_by: "  " }));
    // The repository refuses to write this row; the gate recomputes the rule anyway,
    // because a gate that trusted the writer would be one bad UPDATE from opening.
    expect(evaluateGate(rows).open).toBe(false);
    const graded = M3_GATE.map((question) => ({ question, verdict: "sufficient", reviewed_by: "a human" }));
    expect(evaluateGate(graded).open).toBe(true);
    expect(evaluateGate([...graded.slice(0, 2), { question: "Q3", verdict: "insufficient", reviewed_by: "a human" }]).open).toBe(
      false,
    );
  });
});

describe("D — coverage says unavailable, not zero", () => {
  it("blocks with a reason when there is nothing to count", () => {
    const out = measureCoverage({});
    expect(out).toMatchObject({
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NO_FIXTURES,
      question: "Q1",
      n: 0,
    });
    expect(out.notes.join(" ")).toMatch(/unavailable, not zero/);
    expect(out.error.band).toBe("unavailable");
  });

  it("labels fixture-derived coverage as unable to answer Q1", () => {
    const replay = replayFixture({ fixture: fixture("synthetic-cache-silent"), registry: REGISTRY, pricingKey: "vendor", startAt: NOW });
    const out = measureCoverage({ replays: [replay] });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.source).toBe("fixtures");
    expect(out.notes.join(" ")).toMatch(/synthetic fixture reports what its author wrote/);
    const [row] = out.by_provider;
    // The silent fixture's whole purpose: a population whose cache economics would rest
    // on `assumed` alone, which is the finding Q1 needs to see.
    expect(row).toMatchObject({ provider: "vendor", reported_read: 0, read_coverage_pct: 0 });
    expect(row.silent_but_assumed).toBe(row.n);
    expect(row.confirmed).toBe(0);
  });
});

describe("D — arithmetic accuracy scores only what a provider reported", () => {
  it("blocks on an empty population and on one with no reported counts", () => {
    expect(measureArithmeticAccuracy({})).toMatchObject({
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NO_FIXTURES,
      question: "Q6",
    });
    const silent = measureArithmeticAccuracy({
      replays: [fakeReplay({ turns: [{ i: 0, predicted_read_tokens: 100, reported_read_tokens: null, reported_write_tokens: null }] })],
    });
    expect(silent).toMatchObject({ status: RUN_STATUS.BLOCKED, blocked_reason: BLOCKED_REASON.NO_ROWS });
    expect(silent.notes.join(" ")).toMatch(/excluded, not scored as exact/);
  });

  it("catches a prediction that is off, and says which way it leans", () => {
    const out = measureArithmeticAccuracy({
      replays: [
        fakeReplay({
          turns: [
            // 20% under on the read, 20% over on the write: both outside the §20 band.
            { i: 1, predicted_read_tokens: 800, reported_read_tokens: 1000, predicted_write_tokens: 1200, reported_write_tokens: 1000 },
            { i: 2, predicted_read_tokens: 1000, reported_read_tokens: 1000, predicted_write_tokens: 1000, reported_write_tokens: 1000 },
          ],
        }),
      ],
    });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.comparisons).toBe(4);
    expect(out.within_band).toBe(2);
    expect(out.within_band_pct).toBe(50);
    // Signed, and reported apart: the direction of each side's bias is the finding.
    expect(out.mean_signed_read_error_pct).toBe(-10);
    expect(out.mean_signed_write_error_pct).toBe(10);
  });

  it("counts a turn with nothing to divide by out of the sample entirely", () => {
    const out = measureArithmeticAccuracy({
      replays: [
        fakeReplay({
          turns: [
            { i: 0, predicted_read_tokens: 0, reported_read_tokens: 0, predicted_write_tokens: 500, reported_write_tokens: 500 },
            { i: 1, predicted_read_tokens: 10, reported_read_tokens: null, predicted_write_tokens: 0, reported_write_tokens: null },
          ],
        }),
      ],
    });
    // A reported zero cannot carry a relative error, so it is not a 0 % success.
    expect(out.read_comparisons).toBe(0);
    expect(out.write_comparisons).toBe(1);
    expect(out.unscored_turns).toBe(1);
  });

  it("names a fixture whose expected counts came from this engine's own estimator", () => {
    const replay = replayFixture({
      fixture: fixture("synthetic-cache-reporting"),
      registry: REGISTRY,
      pricingKey: "vendor",
      startAt: NOW,
    });
    expect(replay.expectation_basis).toBe("engine_estimator");
    const out = measureArithmeticAccuracy({ replays: [replay] });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.self_consistent_turns).toBe(out.scored_turns);
    expect(out.captured_turns).toBe(0);
    const notes = out.notes.join(" ");
    expect(notes).toMatch(/self-consistency checks on the attribution arithmetic, not accuracy against a provider/);
    expect(notes).toMatch(/§20 5% band cannot be established from synthetic reports alone/);
    // And it is a real regression check: the attribution reproduces the fixture's
    // hand-computed counts exactly, so any drift in the estimator or the prefix regions
    // shows up here as a band that is no longer zero.
    expect(out.within_band_pct).toBe(100);
  });
});

describe("D — prefix stability refuses a population of one repository", () => {
  const turns = [
    { i: 0, invalidated: ["tools", "system", "messages"], belief: { warm_prefix: [] } },
    { i: 1, invalidated: ["messages"], belief: { warm_prefix: ["tools", "system"] } },
    { i: 2, invalidated: ["messages"], belief: { warm_prefix: ["tools", "system"] } },
  ];

  it("blocks below three project kinds rather than reporting with a caveat", () => {
    const out = measurePrefixStability({ replays: [fakeReplay({ turns }), fakeReplay({ id: "f2", turns })] });
    expect(out).toMatchObject({
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.INSUFFICIENT_PROJECT_KINDS,
      question: "Q2",
      required_project_kinds: 3,
    });
    // The sessions are still reported: blocked is not the same as discarded.
    expect(out.sessions).toHaveLength(2);
    expect(out.n).toBe(2);
  });

  it("measures the front of the prefix, and never counts turn 0 as instability", () => {
    const replays = ["kind-a", "kind-b", "kind-c"].map((kind, i) => fakeReplay({ id: `f${i}`, kind, turns }));
    const out = measurePrefixStability({ replays });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.project_kinds).toHaveLength(3);
    // Turn 0 invalidates everything by construction; counting it would report every
    // session as maximally unstable.
    expect(out.sessions[0].first_tools_break).toBe(null);
    expect(out.sessions[0].front_held_pct).toBe(100);
    expect(out.notes.join(" ")).toMatch(/synthetic: they exhibit the stability their author wrote/);
  });
});

describe("D — return rate cannot be judged without a window (I4)", () => {
  it("counts a gap it cannot judge instead of scoring it a miss", () => {
    const replay = replayFixture({ fixture: fixture("synthetic-cache-silent"), registry: REGISTRY, pricingKey: "default", startAt: NOW });
    const out = measureReturnRate({ replays: [replay], registry: REGISTRY });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.gaps).toBeGreaterThan(0);
    expect(out.windows).toBe(0);
    expect(out.unjudgeable_gaps).toBe(out.gaps);
    // Renamed from `return_rate_pct`: this is the opportunity measure (the next turn
    // arrived while the window could still have been warm), not P(return after a move).
    expect(out.gap_within_ttl_pct).toBe(null);
    expect(out.return_rate_pct).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/unavailable, not zero \(I4\)/);
  });

  it("judges the gaps it can, against the registry's TTL", () => {
    const replay = replayFixture({
      fixture: fixture("synthetic-cache-silent"),
      registry: REGISTRY,
      pricingKey: "vendor",
      startAt: NOW,
      gapMs: 1000,
    });
    const out = measureReturnRate({ replays: [replay], registry: REGISTRY });
    expect(out.windows).toBe(out.gaps);
    expect(out.gap_within_ttl_pct).toBe(100);
    // A fixture population contributes no real observations, so the gate cannot inherit
    // a sample size from it.
    expect(out).toMatchObject({ n: 0, n_synthetic: out.gaps, population: "synthetic" });
    const slow = measureReturnRate({
      replays: [replayFixture({ fixture: fixture("synthetic-cache-silent"), registry: REGISTRY, pricingKey: "vendor", startAt: NOW, gapMs: 600_000 })],
      registry: REGISTRY,
    });
    // Ten minutes on a five-minute TTL: nothing came back inside the window.
    expect(slow.gap_within_ttl_pct).toBe(0);
    expect(slow.notes.join(" ")).toMatch(/gap timings are the replay's own/);
  });

  it("blocks when no session has a second turn", () => {
    const out = measureReturnRate({ replays: [fakeReplay({ turns: [{ i: 0, at: NOW }] })], registry: REGISTRY });
    expect(out).toMatchObject({ status: RUN_STATUS.BLOCKED, blocked_reason: BLOCKED_REASON.NO_ROWS });
    expect(out.notes.join(" ")).toMatch(/session of one turn has no gap/);
  });
});

describe("D — the probe spends nothing until it is told to", () => {
  it("states the cost before anything is sent", () => {
    const plan = planProbe({ pricingKey: "vendor", model: "m", minTokens: 2048, repetitions: 3 });
    expect(plan).toMatchObject({ requests: 6, prefix_tokens: 2048, approx_input_tokens: 6 * 2048, real_money: true });
    expect(plan.note).toMatch(/nothing is sent unless optIn is true/);
  });

  it("refuses without an explicit opt-in, and without an executor", async () => {
    const executor = { execute: async () => ({ status: 200, usage: {} }) };
    const off = await measureCacheProbe({ executor, clock: { now: () => NOW }, registry: REGISTRY, pricingKey: "vendor", route: { provider: "p", model: "m" } });
    expect(off).toMatchObject({ status: RUN_STATUS.BLOCKED, blocked_reason: BLOCKED_REASON.NOT_OPTED_IN });
    expect(off.probes).toEqual([]);
    // Truthiness is not opt-in: only `true` sends.
    expect((await measureCacheProbe({ optIn: 1, executor, clock: { now: () => NOW }, route: { provider: "p", model: "m" } })).blocked_reason).toBe(
      BLOCKED_REASON.NOT_OPTED_IN,
    );
    const noExec = await measureCacheProbe({ optIn: true, clock: { now: () => NOW }, route: { provider: "p", model: "m" } });
    expect(noExec).toMatchObject({ status: RUN_STATUS.BLOCKED, blocked_reason: BLOCKED_REASON.NO_EXECUTOR });
    expect(noExec.notes.join(" ")).toMatch(/I1/);
  });

  it("sends filler, not user material, and reports silence as a finding", async () => {
    const sent = [];
    const executor = {
      execute: async (route, request) => {
        sent.push(request);
        return { status: 200, usage: { input: 2100, output: 4 }, reported_model: "m" };
      },
    };
    const waits = [];
    const out = await measureCacheProbe({
      optIn: true,
      executor,
      clock: { now: () => NOW },
      registry: REGISTRY,
      pricingKey: "vendor",
      route: { provider: "p", model: "m" },
      minTokens: 64,
      sleep: async (ms) => waits.push(ms),
    });

    expect(out.status).toBe(RUN_STATUS.OK);
    expect(sent).toHaveLength(2);
    // Byte-identical prefixes, or the second call is not a cache test at all.
    expect(sent[0].system).toBe(sent[1].system);
    expect(sent[0].system).toMatch(/^The quick brown fox/);
    expect(probeFiller(64)).toHaveLength(256);
    expect(waits).toEqual([5000]);
    // The provider said nothing about its cache. That is a result, not an error.
    expect(out.silent_reads).toBe(1);
    expect(out.reads_reported).toBe(0);
    expect(out.notes.join(" ")).toMatch(/this route cannot produce confirmed cache evidence today/);
  });
});

describe("D — a recorded run, end to end", () => {
  let h;
  const reports = [];
  const writeReport = (filename, markdown) => {
    reports.push({ filename, markdown });
    return `/reports/${filename}`;
  };

  beforeEach(async () => {
    h = await openHarness({ tag: "m2-evidence" });
    reports.length = 0;
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  async function observeOne(usage) {
    const obs = await h.observe(turnRequest({ msgs: messages(80, "ev ") }));
    return observeCacheResult({
      store: h.store,
      clock: h.clock,
      registry: REGISTRY,
      observation: obs,
      result: { provider: "vendor", pricing_key: "vendor", model: "m", status: "ok", http_status: 200, usage, at: h.at() },
    });
  }

  it("persists one row, renders one report, and grades nothing", async () => {
    await observeOne({ input: 4000, cache_read: 1200, cache_write: 400 });
    const run = await runMeasure({ store: h.store, clock: h.clock, measure: "coverage", args: { store: h.store, since: 0 }, writeReport });

    expect(run.persisted).toBe(true);
    expect(run.result.source).toBe("turn_results");
    expect(run.filename).toBe("Q1-coverage-2023-11-14.md");
    expect(run.report_path).toBe("/reports/Q1-coverage-2023-11-14.md");

    const stored = h.store.experiments.getExperiment(h.db, run.row.id);
    expect(stored).toMatchObject({
      question: "Q1",
      measure: "coverage",
      verdict: "pending",
      reviewed_by: null,
      report_path: "/reports/Q1-coverage-2023-11-14.md",
      harness_version: HARNESS_VERSION,
    });
    // The whole result is kept, so a later reader can re-read the measurement rather
    // than trusting the summary line.
    expect(JSON.parse(stored.result_json).by_provider[0].reported_read).toBe(1);

    const markdown = reports[0].markdown;
    expect(markdown).toMatch(/## How far to trust this/);
    expect(markdown).toMatch(/\*\*Verdict:\*\* `pending` — a run does not unblock anything by existing/);
    expect(markdown).toMatch(/Reviewed by:\*\* _unreviewed_/);
    // The store handle is not serialised into the report.
    expect(markdown).toMatch(/"store": "<injected>"/);
  });

  it("records a measure that threw as an errored run rather than losing it", async () => {
    const run = await runMeasure({
      store: h.store,
      clock: h.clock,
      measure: "coverage",
      // A store handle whose repository throws: the shape a half-migrated database has.
      args: { store: { db: h.db, turnResults: { cacheReportingCoverage: () => { throw new Error("boom"); } } } },
      writeReport,
    });
    expect(run.result.status).toBe(RUN_STATUS.ERROR);
    expect(run.result.notes.join(" ")).toMatch(/measure threw: boom/);
    expect(h.store.experiments.getExperiment(h.db, run.row.id).error_band).toBe("unavailable");
  });

  it("rejects a measure it does not have", async () => {
    await expect(runMeasure({ store: h.store, clock: h.clock, measure: "vibes" })).rejects.toThrow(MeasureError);
    await expect(runMeasure({ store: h.store, measure: "coverage" })).rejects.toThrow(/Clock port/);
    expect(MEASURE_NAMES).toContain("cache_probe");
  });

  it("records the knobs a run was given and none of the material", () => {
    const inputs = describeInputs({
      store: h.store,
      executor: { execute: () => {} },
      since: 0,
      bandPct: 5,
      replays: [{ fixture_id: "f1", fixture_source: "synthetic", pricing_key: "vendor", model: "m", mechanism: "explicit", turns: [{ layers: {} }] }],
    });
    expect(inputs).toMatchObject({ store: "<injected>", executor: "<injected>", since: 0, bandPct: 5 });
    expect(inputs.replays).toEqual([
      { fixture_id: "f1", fixture_source: "synthetic", project_kind: null, pricing_key: "vendor", model: "m", mechanism: "explicit", turns: 1 },
    ]);
    // Not the turns themselves: a fixture body in `inputs_json` would put session
    // material in the evidence table.
    expect(JSON.stringify(inputs)).not.toMatch(/layers/);
  });

  it("only opens the gate once a human has signed for all three questions", async () => {
    await observeOne({ input: 4000, cache_read: 1200 });
    const turns = [
      { i: 0, at: NOW, invalidated: ["tools", "system", "messages"], belief: { warm_prefix: [] } },
      { i: 1, at: NOW + 1000, invalidated: ["messages"], belief: { warm_prefix: ["tools"] } },
    ];
    // Three "project kinds" from one hand-built shape: this test measures the gate
    // mechanism, not prefix stability, and the measure's own notes still say the
    // population is synthetic.
    const replays = ["kind-a", "kind-b", "kind-c"].map((kind, i) => fakeReplay({ id: `f${i}`, kind, turns }));

    const runs = {
      Q1: await runMeasure({ store: h.store, clock: h.clock, measure: "coverage", args: { store: h.store }, writeReport }),
      Q2: await runMeasure({ store: h.store, clock: h.clock, measure: "prefix_stability", args: { replays }, salt: "b", writeReport }),
      Q3: await runMeasure({ store: h.store, clock: h.clock, measure: "return_rate", args: { replays, registry: REGISTRY }, salt: "c", writeReport }),
    };
    for (const [question, run] of Object.entries(runs)) expect(run.row.question, question).toBe(question);

    const before = measureStatus({ store: h.store });
    // Every §23 question appears, including the six no measure answers: a question
    // missing from the output looks answered.
    expect(before.questions.map((q) => q.question)).toEqual([...QUESTION_IDS]);
    expect(before.questions.filter((q) => !q.answerable_here).length).toBeGreaterThan(0);
    expect(before.total_runs).toBe(3);
    expect(before.gate.open).toBe(false);
    for (const q of before.gate.questions) expect(q.verdict).toBe("pending");

    expect(() => h.store.experiments.setVerdict(h.db, runs.Q1.row.id, { verdict: "sufficient", reviewed_by: "  " })).toThrow(
      /requires reviewed_by/,
    );
    expect(measureStatus({ store: h.store }).gate.open).toBe(false);

    for (const run of Object.values(runs)) {
      h.store.experiments.setVerdict(h.db, run.row.id, { verdict: "sufficient", reviewed_by: "a named human", reviewed_at: NOW });
    }
    const after = measureStatus({ store: h.store });
    expect(after.gate.open).toBe(true);
    expect(after.gate.questions.every((q) => q.satisfied && q.reviewed_by === "a named human")).toBe(true);
  });

  it("renders a report for a blocked run too", () => {
    const result = measureCoverage({});
    const row = buildExperimentRow({ measure: "coverage", result, ran_at: NOW, notes: result.notes });
    const markdown = renderReport({ row, result, inputs: {} });
    expect(markdown).toMatch(/\*\*Status:\*\* `blocked` \(`no_fixtures`\)/);
    expect(markdown).toMatch(/Sample size \(n\):\*\* 0/);
    expect(markdown).toMatch(/Error band:\*\* unavailable/);
    expect(reportFilename({ question: "Q1", measure: "coverage", ran_at: NOW })).toBe("Q1-coverage-2023-11-14.md");
  });
});
