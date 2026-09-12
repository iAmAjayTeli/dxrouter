/**
 * `arithmetic_accuracy` (§19.4) — how far our reconstructed cache token counts sit from
 * what the provider actually reported, per replayed turn.
 *
 * This is the measure §20 states the M2 acceptance band against: "replay reconstructs
 * cache read/write token counts within 5% of what providers actually reported in that
 * fixture's rows". So the comparison is deliberately narrow — predicted against
 * **reported**, on the turns where a report exists — and turns with no report are counted
 * separately rather than scored as perfect.
 *
 * It is filed under Q6, not Q1, even though §23 lists it under both. A run of this measure
 * cannot establish that providers report cache fields at all: it can only be computed on
 * turns where they already did. Letting it write the latest Q1 row would let an arithmetic
 * check stand in for the coverage evidence that gates M3, which is the one substitution
 * this harness exists to prevent.
 *
 * One further honesty rule is structural here. A fixture may declare
 * `expectation_basis: "engine_estimator"`, meaning its `usage` numbers were computed with
 * this engine's own estimator rather than observed from a provider. Those turns still get
 * scored — they are a real regression check on the attribution and carry arithmetic — but
 * they are counted apart and named in the notes, because a 0% band that came from
 * comparing an estimator against itself must not read as a measurement of any vendor.
 */

import { BLOCKED_REASON, describeError, RUN_STATUS } from "../harness.js";

/** Signed relative error in percent; null when there is nothing to divide by. */
function relErr(predicted, reported) {
  if (!Number.isFinite(reported) || reported === 0) return null;
  return ((predicted - reported) / reported) * 100;
}

function scoreTurn(replay, turn) {
  const readErr = relErr(turn.predicted_read_tokens ?? 0, turn.reported_read_tokens);
  const writeErr = relErr(turn.predicted_write_tokens ?? 0, turn.reported_write_tokens);
  return {
    fixture_id: replay.fixture_id,
    fixture_source: replay.fixture_source,
    expectation_basis: replay.expectation_basis ?? null,
    turn: turn.i,
    predicted_read_tokens: turn.predicted_read_tokens ?? 0,
    reported_read_tokens: turn.reported_read_tokens,
    predicted_write_tokens: turn.predicted_write_tokens ?? 0,
    reported_write_tokens: turn.reported_write_tokens,
    predicted_provenance: turn.predicted_provenance ?? null,
    read_error_pct: readErr === null ? null : Math.round(readErr * 100) / 100,
    write_error_pct: writeErr === null ? null : Math.round(writeErr * 100) / 100,
    scored: readErr !== null || writeErr !== null,
  };
}

/**
 * @param {object} args
 * @param {Array<object>} args.replays `replayFixture` outputs
 * @param {number} [args.bandPct] the §20 acceptance band
 */
export function measureArithmeticAccuracy({ replays = [], bandPct = 5 } = {}) {
  const rows = [];
  for (const replay of replays || []) for (const turn of replay.turns ?? []) rows.push(scoreTurn(replay, turn));

  if (!rows.length) {
    return Object.freeze({
      measure: "arithmetic_accuracy",
      question: "Q6",
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NO_FIXTURES,
      n: 0,
      turns: Object.freeze([]),
      error: { band: "unavailable", basis: "no replayed turns" },
      notes: Object.freeze(["no fixtures to replay"]),
    });
  }

  const scored = rows.filter((r) => r.scored);
  const captured = scored.filter((r) => r.fixture_source === "captured");
  // A turn whose "reported" counts this engine computed itself cannot measure accuracy:
  // predicted and reported share an estimator, so agreement is guaranteed and means only
  // that the attribution arithmetic did not change. Counted and named, because a 0% band
  // in a report with no caveat is exactly how a self-check gets re-read as a validation.
  const selfConsistent = scored.filter((r) => r.expectation_basis === "engine_estimator");
  const notes = [];
  if (scored.length !== rows.length) {
    notes.push(
      `${rows.length - scored.length}/${rows.length} turns carry no provider-reported cache count; they are excluded, not scored as exact`,
    );
  }
  if (selfConsistent.length) {
    notes.push(
      `${selfConsistent.length}/${scored.length} scored turns come from a fixture whose expected counts were derived from this engine's own token estimator: those comparisons are self-consistency checks on the attribution arithmetic, not accuracy against a provider`,
    );
  }
  if (!captured.length) {
    // The §20 band is stated against what providers actually reported. A synthetic
    // fixture reports what its author wrote, so a pass here measures internal
    // consistency and nothing about any provider.
    notes.push("no captured fixture in this population: the §20 5% band cannot be established from synthetic reports alone");
  }

  if (!scored.length) {
    return Object.freeze({
      measure: "arithmetic_accuracy",
      question: "Q6",
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NO_ROWS,
      n: 0,
      turns: Object.freeze(rows.map(Object.freeze)),
      error: { band: "unavailable", basis: "no provider-reported counts to compare against" },
      notes: Object.freeze(notes),
    });
  }

  // §20 names read *and* write counts, so the band covers both comparisons. They are
  // also reported apart, because the two lean opposite ways: a read prediction can only
  // under-count (it believes no more than it has evidence for) while a write prediction
  // absorbs whatever the read missed, and one merged mean would cancel that out.
  const readErrs = scored.map((r) => r.read_error_pct).filter((v) => v !== null);
  const writeErrs = scored.map((r) => r.write_error_pct).filter((v) => v !== null);
  const absAll = [...readErrs, ...writeErrs].map(Math.abs);
  const withinBand = absAll.filter((v) => v <= bandPct).length;
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 100) / 100 : null);

  return Object.freeze({
    measure: "arithmetic_accuracy",
    question: "Q6",
    status: RUN_STATUS.OK,
    n: scored.length,
    band_pct: bandPct,
    scored_turns: scored.length,
    unscored_turns: rows.length - scored.length,
    captured_turns: captured.length,
    self_consistent_turns: selfConsistent.length,
    synthetic_turns: scored.length - captured.length,
    comparisons: absAll.length,
    read_comparisons: readErrs.length,
    write_comparisons: writeErrs.length,
    within_band: withinBand,
    within_band_pct: absAll.length ? Math.round((withinBand / absAll.length) * 1000) / 10 : null,
    // Signed, on purpose: the direction of the bias is the finding. A mean absolute
    // error would hide which way each side leans, and the lean is what tells an operator
    // whether the attribution is conservative or optimistic.
    mean_signed_read_error_pct: mean(readErrs),
    mean_signed_write_error_pct: mean(writeErrs),
    turns: Object.freeze(rows.map(Object.freeze)),
    error: describeError({ n: absAll.length, values: absAll, unit: "%" }),
    notes: Object.freeze(notes),
  });
}

export default measureArithmeticAccuracy;
