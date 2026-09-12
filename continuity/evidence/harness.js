/**
 * The evidence harness spine (§19.4).
 *
 * A measure is a reducer. This file is everything a measure needs *around* the reducing:
 * the versions that make a result interpretable later, the run id, the `experiments` row
 * builder, and the review rules.
 *
 * Three things are deliberate.
 *
 * **Versions are mandatory and plural.** A number without the harness that produced it
 * and the engine it measured is not evidence six months later, it is folklore. The
 * schema makes `harness_version` and `engine_version` NOT NULL; this module makes them
 * impossible to omit accidentally.
 *
 * **A result must carry `n` and an error band.** `describeError` refuses to invent one:
 * when a measure cannot state a band it says `unavailable`, and §10.4's rule against
 * false precision applies to research output too.
 *
 * **`verdict` starts `pending` and no code path sets anything else.** Grading is a human
 * action with a name attached (`experimentsRepo.setVerdict`, which refuses a graded
 * verdict without `reviewed_by`). "A run does not unblock anything by existing."
 */

import { createHash, randomUUID } from "node:crypto";

import { ESTIMATOR_VERSION } from "../prefix/tokens.js";
import { CONTINUITY_SCHEMA_VERSION } from "../store/sqlite/schema.js";
import { M3_GATE, QUESTIONS, questionForMeasure, unblocksFor } from "./questions.js";

/** Bumped when a measure's method changes, so old rows stay interpretable. */
export const HARNESS_VERSION = "h1";

/**
 * What was measured. Not a package version: the engine's observable behaviour is its
 * schema, its estimator and its milestone, and a package bump that changes none of those
 * would only add noise to the comparison.
 */
export const ENGINE_VERSION = `m2:schema${CONTINUITY_SCHEMA_VERSION}:${ESTIMATOR_VERSION}`;

/** Statuses a measure run can end in. `blocked` is a first-class outcome, not a failure. */
export const RUN_STATUS = Object.freeze({ OK: "ok", BLOCKED: "blocked", ERROR: "error" });

/** Why a run produced no measurement. Recorded, so "no data" is never mistaken for zero. */
export const BLOCKED_REASON = Object.freeze({
  NO_FIXTURES: "no_fixtures",
  NO_ROWS: "no_rows",
  NO_CREDENTIALS: "no_credentials",
  NOT_OPTED_IN: "not_opted_in",
  NO_EXECUTOR: "no_executor",
  INSUFFICIENT_PROJECT_KINDS: "insufficient_project_kinds",
  // Two populations added together is not a bigger sample. A measure handed both observed
  // traffic and fixtures reports this rather than a number computed across the join.
  MIXED_POPULATION: "mixed_population",
});

/** Deterministic run id when a clock and a sequence are supplied; random otherwise. */
export function runId({ measure, ran_at, salt = null } = {}) {
  if (!measure || !Number.isFinite(ran_at)) return randomUUID();
  const h = createHash("sha256").update(`${measure} ${ran_at} ${salt ?? ""}`).digest("hex").slice(0, 16);
  return `exp_${h}`;
}

/**
 * A stated error band, or an honest refusal to state one.
 *
 * `n < 2` cannot support a band at all, and a single observation dressed as a zero-width
 * interval would be the most misleading number the harness could emit.
 */
export function describeError({ n = 0, values = null, unit = "" } = {}) {
  if (!Array.isArray(values) || values.length < 2 || n < 2) return { band: "unavailable", basis: "sample too small" };
  const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 2) return { band: "unavailable", basis: "no finite values" };
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (sorted.length - 1);
  const sd = Math.sqrt(variance);
  // Normal-approximation 95% interval on the mean. Stated as an approximation, because
  // that is what it is; the basis string travels with the number into the report.
  const half = 1.96 * (sd / Math.sqrt(sorted.length));
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    band: `${round(mean)} +/- ${round(half)}${unit}`,
    basis: "normal approximation, 95%",
    mean: round(mean),
    sd: round(sd),
    p50: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

/**
 * Build the `experiments` row for a completed run.
 *
 * `verdict` is not a parameter. It is always `pending`, because this function runs at the
 * end of a measurement and a measurement has no opinion about its own sufficiency.
 */
export function buildExperimentRow({ measure, result, ran_at, inputs = {}, notes = [], report_path = null, salt = null } = {}) {
  if (!measure) throw new Error("[continuity][evidence] a run needs a measure name");
  if (!Number.isFinite(ran_at)) throw new Error("[continuity][evidence] ran_at must come from the injected clock");
  const question = result?.question ?? questionForMeasure(measure);
  if (!question) throw new Error(`[continuity][evidence] measure ${measure} answers no numbered question (§23)`);

  return Object.freeze({
    id: runId({ measure, ran_at, salt }),
    question,
    measure,
    ran_at,
    harness_version: HARNESS_VERSION,
    engine_version: ENGINE_VERSION,
    inputs_json: JSON.stringify(inputs ?? {}),
    result_json: JSON.stringify(result ?? {}),
    n: Number.isInteger(result?.n) ? result.n : 0,
    verdict: "pending",
    reviewed_by: null,
    reviewed_at: null,
    unblocks: unblocksFor(question),
    report_path,
    error_band: result?.error?.band ?? "unavailable",
    harness_notes: Array.isArray(notes) && notes.length ? notes.join("; ") : null,
  });
}

/**
 * Whether the M3 gate is open, computed from persisted rows only.
 *
 * Returns a per-question row rather than a bare boolean so the answer is explainable: an
 * operator asking "why is M3 blocked?" gets the questions and their verdicts, not a
 * `false`.
 */
export function evaluateGate(latestRows = [], { gate = M3_GATE } = {}) {
  const byQuestion = new Map((latestRows || []).map((r) => [r.question, r]));
  const questions = gate.map((id) => {
    const row = byQuestion.get(id) ?? null;
    const verdict = row?.verdict ?? "missing";
    return Object.freeze({
      question: id,
      blocks: QUESTIONS[id]?.blocks?.join(",") ?? null,
      measures: QUESTIONS[id]?.measures ?? [],
      verdict,
      reviewed_by: row?.reviewed_by ?? null,
      reviewed_at: row?.reviewed_at ?? null,
      ran_at: row?.ran_at ?? null,
      measure: row?.measure ?? null,
      report_path: row?.report_path ?? null,
      // A `sufficient` without a reviewer is not sufficient. The repository refuses to
      // write one, and this recomputes the rule rather than trusting that it held.
      satisfied: verdict === "sufficient" && Boolean(String(row?.reviewed_by ?? "").trim()),
    });
  });
  return Object.freeze({ open: questions.every((q) => q.satisfied), questions: Object.freeze(questions) });
}

export default buildExperimentRow;
