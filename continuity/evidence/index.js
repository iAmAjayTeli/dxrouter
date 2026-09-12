/**
 * The evidence harness surface (§19.4): run a measure, record it, report it, read the gate.
 *
 * Order of use:
 *   1. `runMeasure({ store, clock, measure, args })` — runs one measure, writes one
 *      `experiments` row with `verdict: "pending"`, and renders a markdown report.
 *   2. A human reads the report and grades it: `experimentsRepo.setVerdict(...)`.
 *   3. `measureStatus({ store })` — the body of `dxrouter measure --status`, including
 *      whether the M3 gate is open and, if not, which questions are missing.
 *
 * The clock is injected and the report is written through a host callback, so this module
 * has no wall clock and no filesystem — the two things that would otherwise make a
 * measurement unreproducible or a path host-specific.
 */

import { buildExperimentRow, evaluateGate, RUN_STATUS } from "./harness.js";
import { MEASURES, isMeasure, LIVE_MEASURES, MEASURE_NAMES, REPLAY_MEASURES } from "./measures/index.js";
import { M3_GATE, QUESTIONS, QUESTION_IDS, questionForMeasure } from "./questions.js";
import { renderReport, reportFilename } from "./report.js";

export class MeasureError extends Error {
  constructor(message, code = "MEASURE_FAILED") {
    super(`[continuity][evidence] ${message}`);
    this.name = "MeasureError";
    this.code = code;
  }
}

/**
 * Run one measure and persist it.
 *
 * `writeReport(filename, markdown)` is the host's; it should return the path it wrote so
 * the row can point at it. A host that supplies none gets the markdown back and no
 * `report_path` — a run with no report is still a recorded run, and pretending it had a
 * report would leave a reviewer chasing a file that does not exist.
 *
 * @param {object} args
 * @param {object} args.store an open continuity store
 * @param {object} args.clock a Clock port (`now()`)
 * @param {string} args.measure one of MEASURE_NAMES
 * @param {object} [args.args] passed straight to the measure
 * @param {object} [args.inputs] what to record as the run's inputs (defaults to a redacted view of `args`)
 * @param {(filename: string, markdown: string) => string|null} [args.writeReport]
 * @param {string|null} [args.salt] makes two runs in the same millisecond distinct
 */
export async function runMeasure({ store = null, clock = null, measure, args = {}, inputs = null, writeReport = null, salt = null } = {}) {
  if (!isMeasure(measure)) throw new MeasureError(`unknown measure ${measure}; expected one of ${MEASURE_NAMES.join(", ")}`, "UNKNOWN_MEASURE");
  if (!clock || typeof clock.now !== "function") throw new MeasureError("a Clock port is required", "NO_CLOCK");
  const ran_at = clock.now();

  let result;
  try {
    result = await MEASURES[measure](args);
  } catch (err) {
    // A measure that throws is recorded as an errored run rather than swallowed: the
    // harness exists to leave a trace of what was attempted.
    result = Object.freeze({
      measure,
      question: questionForMeasure(measure),
      status: RUN_STATUS.ERROR,
      n: 0,
      error: { band: "unavailable", basis: "the measure threw" },
      notes: Object.freeze([`measure threw: ${String(err?.message ?? err).slice(0, 300)}`]),
    });
  }

  const recordedInputs = inputs ?? describeInputs(args);
  const provisional = buildExperimentRow({ measure, result, ran_at, inputs: recordedInputs, notes: result.notes ?? [], salt });
  const filename = reportFilename({ question: provisional.question, measure, ran_at });
  const markdown = renderReport({ row: provisional, result, inputs: recordedInputs });
  const report_path = typeof writeReport === "function" ? (writeReport(filename, markdown) ?? null) : null;

  const row = buildExperimentRow({
    measure,
    result,
    ran_at,
    inputs: recordedInputs,
    notes: result.notes ?? [],
    report_path,
    salt,
  });
  if (store?.db) store.experiments.insertExperiment(store.db, row);

  return Object.freeze({ row, result, filename, markdown, report_path, persisted: Boolean(store?.db) });
}

/**
 * What to record as a run's inputs: the knobs, never the material.
 *
 * `args` can carry a store handle, an executor and whole fixture bodies. Serialising it
 * verbatim into `inputs_json` would put session content into the evidence table, which §14
 * forbids and no measurement needs. So this records shapes and counts.
 */
export function describeInputs(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === null || value === undefined) continue;
    if (key === "store" || key === "clock" || key === "executor" || key === "sleep" || key === "registry") {
      out[key] = "<injected>";
      continue;
    }
    if (key === "replays") {
      out.replays = (value ?? []).map((r) => ({
        fixture_id: r.fixture_id,
        fixture_source: r.fixture_source,
        project_kind: r.project_kind ?? null,
        pricing_key: r.pricing_key,
        model: r.model,
        mechanism: r.mechanism,
        turns: r.n ?? (r.turns?.length ?? 0),
      }));
      continue;
    }
    if (typeof value === "object") {
      out[key] = Array.isArray(value) ? `<array:${value.length}>` : "<object>";
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The `dxrouter measure --status` body: latest run per question, plus the gate.
 *
 * Every §23 question appears, including the ones no measure answers yet — a question
 * missing from the output looks answered.
 */
export function measureStatus({ store = null, gate = M3_GATE } = {}) {
  const latest = store?.db ? store.experiments.latestByQuestion(store.db) : [];
  const byQuestion = new Map(latest.map((r) => [r.question, r]));
  const questions = QUESTION_IDS.map((id) => {
    const row = byQuestion.get(id) ?? null;
    const q = QUESTIONS[id];
    return Object.freeze({
      question: id,
      summary: q.question,
      measures: q.measures,
      blocks: q.blocks,
      verdict: row?.verdict ?? "no runs",
      n: row?.n ?? 0,
      error_band: row?.error_band ?? null,
      ran_at: row?.ran_at ?? null,
      measure: row?.measure ?? null,
      reviewed_by: row?.reviewed_by ?? null,
      report_path: row?.report_path ?? null,
      // A question with no measure cannot be answered by this harness at all; saying so
      // is different from saying nobody has run it yet.
      answerable_here: q.measures.length > 0,
    });
  });

  return Object.freeze({
    total_runs: store?.db ? store.experiments.countExperiments(store.db) : 0,
    questions: Object.freeze(questions),
    gate: evaluateGate(latest, { gate }),
  });
}

export * from "./harness.js";
export * from "./questions.js";
export * from "./measures/index.js";
export { renderReport, reportFilename } from "./report.js";
export { replayFixture } from "./replay.js";
export {
  applyTurn,
  expandContent,
  expandMessage,
  expandTurns,
  FIXTURE_SOURCES,
  fixtureProjectKind,
  fixtureSource,
  prepareFixture,
} from "./fixtures.js";
