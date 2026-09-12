/**
 * The numbered questions of §23, and which milestone each one blocks.
 *
 * This file exists so the gate is mechanical rather than cultural. §23 says "M3 does not
 * start until `dxrouter measure --status` reports `sufficient` with a `reviewed_by` for
 * Q1, Q2 and Q3", and a table in a design document cannot enforce that. A table in code,
 * read by the status command and by a script, can.
 *
 * Q4, Q5, Q7, Q8 and Q9 have no harness measure — §23 answers them by hand-labelling,
 * replay-with-labels, backtest or audit. They are listed anyway, with `measures: []`,
 * because a question that is missing from the status output looks answered.
 */

/** Questions whose verdict M3 is blocked on. §20 M3 "Blocked by". */
export const M3_GATE = Object.freeze(["Q1", "Q2", "Q3"]);

export const QUESTIONS = Object.freeze({
  Q1: Object.freeze({
    id: "Q1",
    question:
      "Do the ten required providers actually charge and report cache reads/writes as documented, and what are the real TTLs under real traffic?",
    measures: Object.freeze(["cache_probe", "coverage", "arithmetic_accuracy"]),
    blocks: Object.freeze(["M2", "M3"]),
    method: "write a known prefix, read at intervals, record billed vs reported tokens",
  }),
  Q2: Object.freeze({
    id: "Q2",
    question:
      "What is the true distribution of prefix stability in real agent sessions — how often do tools and system actually hold across a multi-hour task?",
    measures: Object.freeze(["prefix_stability"]),
    blocks: Object.freeze(["M3"]),
    method: "measure on M1 data across at least three project kinds",
  }),
  Q3: Object.freeze({
    id: "Q3",
    question: "What is P(return) in practice — after a forced move, how often does the session come back, and how soon?",
    measures: Object.freeze(["return_rate"]),
    blocks: Object.freeze(["M3"]),
    method: "measure from fixtures and shadow traffic; until measured it is an explicit assumption, never a constant",
  }),
  Q4: Object.freeze({
    id: "Q4",
    question: "Can session boundaries be detected from observable signals at acceptable precision, without an LLM classifier?",
    measures: Object.freeze([]),
    blocks: Object.freeze(["M1"]),
    method: "hand-labelling: label recorded fixtures, measure per-signal precision/recall",
  }),
  Q5: Object.freeze({
    id: "Q5",
    question:
      "How often does client-side compaction produce our compaction signature, and does any client produce it in a case that is not compaction?",
    measures: Object.freeze([]),
    blocks: Object.freeze(["M1"]),
    method: "replay real Claude Code / Cline / Aider sessions against the detector",
  }),
  Q6: Object.freeze({
    id: "Q6",
    question: "Does the cache saving survive real quota dynamics, or do forced moves erase it?",
    measures: Object.freeze(["arithmetic_accuracy"]),
    blocks: Object.freeze(["M4"]),
    method: "the §19.3 replay comparison is exactly this measurement",
  }),
  Q7: Object.freeze({
    id: "Q7",
    question: "Is remaining capacity forecastable to a useful error band from the signals we can see?",
    measures: Object.freeze([]),
    blocks: Object.freeze(["M5", "M6"]),
    method: "backtest against recorded sessions",
  }),
  Q8: Object.freeze({
    id: "Q8",
    question: "Do providers report enough in reported_model for silent substitution to be detectable at all?",
    measures: Object.freeze([]),
    blocks: Object.freeze(["M6"]),
    method: "audit across providers",
  }),
  Q9: Object.freeze({
    id: "Q9",
    question: "Which cost term genuinely matters second, after cache?",
    measures: Object.freeze([]),
    blocks: Object.freeze(["v0.2+"]),
    method: "instrument candidates from real decisions before registering any of them",
  }),
});

export const QUESTION_IDS = Object.freeze(Object.keys(QUESTIONS));

/** The question a measure answers. Used to stamp an `experiments` row. */
export function questionForMeasure(measure) {
  for (const q of Object.values(QUESTIONS)) if (q.measures.includes(measure)) return q.id;
  return null;
}

/** What a `sufficient` verdict on this question would unblock, as a stored string. */
export function unblocksFor(questionId) {
  return (QUESTIONS[questionId]?.blocks ?? []).join(",") || null;
}

export default QUESTIONS;
