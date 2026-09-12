/**
 * `return_rate` (§19.4, Q3) — does a session come back to a route, and inside what window?
 *
 * §19.4's question is about a *forced move*: after traffic leaves a route, does the session
 * return to it before the cache window closes? That is the quantity any future "hold the
 * warm route" reasoning rests on. The first version of this file measured something else —
 * inter-turn gaps against the registry TTL — and called it `return_rate_pct`, which
 * overstated it: a short gap says the window *could* still have been warm, not that anyone
 * came back to it.
 *
 * So there are now two quantities here, named for what each one is:
 *
 *  - **`gap_within_ttl_pct`** — the opportunity measure. Of the consecutive turn pairs on a
 *    route with a verified TTL, what fraction arrived inside that TTL? Cheap, available
 *    from fixtures, and an upper bound on anything a cache window could earn. This is the
 *    old `return_rate_pct` under an honest name.
 *  - **`p_return_after_move_pct`** — the real Q3 quantity. Harvested from `turn_results`:
 *    where consecutive rows of one session show a different `(provider, model)`, that is an
 *    observed move, and the question is whether a later row in the same session goes back
 *    to the route the move left.
 *
 * Moves are read out of what `accountFallback` already did — 9Router's multi-account and
 * combo fallback produce them, and `seq > 0` inside one `turn_idx` is one happening
 * mid-turn. Nothing here causes a move, nothing writes `attempts`, and no Decision is
 * invented to explain one (M2 has no Decision by design).
 *
 * Two estimator choices, both because turns are not independent draws:
 *
 *  - P(return) is a proportion over moves, so `wilsonInterval`, not a normal approximation
 *    that would run past 100% or collapse to +/-0 at the edges.
 *  - Time-to-return is right-censored: a session that ends still away from the route has
 *    not "not returned", it has not returned *yet*. `kaplanMeier` keeps it in the risk set.
 *
 * The I4 rule survives intact: a route with no verified cache model contributes gaps to the
 * denominator and none to the numerator, and a population that is entirely
 * `mechanism: none` reports `windows: 0` with the percentage `null` — "we cannot say" and
 * "they never come back" are different findings.
 *
 * Nothing here reads a body. A gap is two timestamps; a move is two route names.
 */

import { BLOCKED_REASON, describeError, RUN_STATUS } from "../harness.js";
import { bootstrapMeanCI, kaplanMeier, wilsonInterval } from "../stats.js";

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * The believed window for a route, or null. `mechanism: none` yields null rather than a
 * default TTL: a made-up window would turn an unmeasurable gap into a judged one (I4).
 */
function ttlFor(registry, key) {
  const model = registry?.get?.(key);
  if (!model || model.mechanism === "none") return null;
  const ttl = Number(model.ttl_default_s);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : null;
}

/** Gaps from an ordered list of turn timestamps. */
function gapsOf(times) {
  const out = [];
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (Number.isFinite(gap) && gap >= 0) out.push(gap);
  }
  return out;
}

/** `provider/model`, the identity a "move" is a change of. */
const routeOf = (row) => `${row.provider ?? "(none)"}/${row.model ?? "(none)"}`;

/**
 * Observed moves and returns, from an ordered route sequence.
 *
 * A move is a change of `(provider, model)` between consecutive rows of one session. The
 * cause is read off the row numbering rather than guessed: two rows sharing a `turn_idx`
 * mean the first attempt did not serve the turn, so `seq > 0` is an in-turn fallback — a
 * genuinely *forced* move, the population §19.4 asks about. A change across `turn_idx`
 * boundaries is `between_turns`, which includes an operator switching models by hand and is
 * therefore reported separately rather than pooled in.
 *
 * A return is the first later row in the same session whose route equals the one the move
 * left. When there is none, the observation is right-censored at the session's last row:
 * `duration` is how long we watched, and `event: false` says we stopped watching, not that
 * the session refused to come back.
 *
 * @param {Array<object>} rows `turnResultsRepo.routeSequence` output, already ordered
 * @param {(key: string) => (number|null)} ttlOf seconds of believed window per pricing key
 */
export function harvestMoves(rows = [], ttlOf = () => null) {
  const bySession = new Map();
  for (const row of rows || []) {
    if (!row?.session_id) continue;
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }

  const moves = [];
  for (const [sessionId, seq] of bySession) {
    const last = seq[seq.length - 1];
    for (let i = 1; i < seq.length; i += 1) {
      const from = seq[i - 1];
      const to = seq[i];
      if (routeOf(from) === routeOf(to)) continue;

      const fromRoute = routeOf(from);
      // The window that would have to still be open for a return to be worth anything is
      // the *left* route's window, so the TTL is the one for the route being abandoned.
      const ttlS = ttlOf(from.pricing_key ?? from.provider);
      const back = seq.slice(i + 1).find((r) => routeOf(r) === fromRoute) ?? null;
      const at = Number(to.at);
      const duration = Number.isFinite(at) ? Number(back ? back.at : last.at) - at : null;

      moves.push({
        session_id: sessionId,
        at,
        from: fromRoute,
        to: routeOf(to),
        // `seq > 0` on the same turn is an in-turn retry: `accountFallback` moved because
        // the first attempt did not serve the turn.
        move_cause: from.turn_idx === to.turn_idx && Number(to.seq) > 0 ? "in_turn_fallback" : "between_turns",
        // The status of the attempt the move *left*, so a reader can see whether the move
        // followed a failure. Not a cause claim: M2 records no reason for a move.
        from_status: from.status ?? null,
        ttl_s: ttlS,
        returned: back !== null,
        // Kaplan-Meier reads these two: censored when the session ended still away.
        duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
        event: back !== null,
        returned_within_ttl:
          back !== null && Number.isFinite(ttlS) && ttlS > 0 && Number.isFinite(duration) ? duration <= ttlS * 1000 : null,
      });
    }
  }
  return moves;
}

/** The move-derived half of the result. Empty when no real rows were supplied. */
function summarizeMoves(moves) {
  if (!moves.length) return { moves: 0, moves_observed: Object.freeze([]) };
  const returned = moves.filter((m) => m.returned).length;
  const judgeable = moves.filter((m) => m.returned_within_ttl !== null);
  const observations = moves
    .filter((m) => m.duration_ms !== null)
    .map((m) => ({ duration: m.duration_ms, event: m.event === true }));

  return {
    moves: moves.length,
    moves_in_turn_fallback: moves.filter((m) => m.move_cause === "in_turn_fallback").length,
    moves_between_turns: moves.filter((m) => m.move_cause === "between_turns").length,
    returns_observed: returned,
    // The real Q3 number. Wilson, because this is a proportion and n will be small.
    p_return_after_move_pct: pct(returned, moves.length),
    p_return_error: wilsonInterval(returned, moves.length),
    // Of the returns we could judge against a verified window, how many were still inside
    // it. A route with no verified TTL contributes to neither side (I4).
    returns_within_ttl: judgeable.filter((m) => m.returned_within_ttl === true).length,
    judgeable_moves: judgeable.length,
    return_within_ttl_pct: pct(judgeable.filter((m) => m.returned_within_ttl === true).length, judgeable.length),
    // Sessions that ended still away from the route are censored, not counted as refusals.
    time_to_return_ms: kaplanMeier(observations, { unit: " ms" }),
    moves_censored: observations.filter((o) => !o.event).length,
    moves_observed: Object.freeze(moves.map(Object.freeze)),
  };
}

/**
 * Assemble the result from the gap population plus whatever moves were harvested.
 *
 * `n` is the count of *real* observations, as in `coverage`: `buildExperimentRow` takes the
 * experiments row's sample size from here, so a run over synthetic fixtures must not hand
 * the §23 gate a number no provider contributed to.
 */
function summarize({ population, notes, ttlSource, moveSummary = { moves: 0 }, realGaps = 0, syntheticGaps = 0 }) {
  const gaps = population.flatMap((s) => s.gaps);
  const nReal = realGaps + (moveSummary.moves || 0);
  const nSynthetic = syntheticGaps;
  const populationLabel = nReal && nSynthetic ? "mixed" : nReal ? "real" : nSynthetic ? "synthetic" : "none";

  if (!gaps.length && !moveSummary.moves) {
    return Object.freeze({
      measure: "return_rate",
      question: "Q3",
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NO_ROWS,
      n: 0,
      n_synthetic: 0,
      n_total: 0,
      population: populationLabel,
      sessions: Object.freeze(population),
      error: { band: "unavailable", basis: "no inter-turn gaps" },
      notes: Object.freeze([...notes, "a session of one turn has no gap to measure"]),
    });
  }

  const withWindow = population.filter((s) => Number.isFinite(s.ttl_s) && s.ttl_s > 0);
  const windowGaps = withWindow.flatMap((s) => s.gaps.map((g) => ({ gap: g, ttl_ms: s.ttl_s * 1000 })));
  const inside = windowGaps.filter((g) => g.gap <= g.ttl_ms).length;
  // Gaps cluster by session — one long pause is one behaviour, not one draw per turn — so
  // the band on the opportunity measure resamples sessions.
  const gapClusters = withWindow.map((s) => s.gaps.map((g) => (g <= s.ttl_s * 1000 ? 100 : 0))).filter((xs) => xs.length);

  const extra = { ...moveSummary };
  delete extra.moves_observed;

  return Object.freeze({
    measure: "return_rate",
    question: "Q3",
    status: RUN_STATUS.OK,
    // Real observations only; synthetic gaps are reported beside it and never inside it.
    n: nReal,
    n_synthetic: nSynthetic,
    n_total: nReal + nSynthetic,
    population: populationLabel,
    sessions: Object.freeze(population),
    ttl_source: ttlSource,
    gaps: gaps.length,
    // Gaps we could judge at all: the rest belong to routes with no verified TTL.
    windows: windowGaps.length,
    unjudgeable_gaps: gaps.length - windowGaps.length,
    returned_within_window: inside,
    // The opportunity measure, named for what it is: the next turn arrived while the
    // window could still have been warm. It is not evidence that anyone returned to a
    // route they had left — `p_return_after_move_pct` is that.
    gap_within_ttl_pct: pct(inside, windowGaps.length),
    gap_within_ttl_error: gapClusters.length ? bootstrapMeanCI(gapClusters, { unit: "%", seed: 20260901 }) : { band: "unavailable", basis: "no route with a verified TTL" },
    median_gap_ms: [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)],
    ...extra,
    moves_observed: moveSummary.moves_observed ?? Object.freeze([]),
    // The headline band is P(return) once moves exist, because that is Q3's own question.
    // Until then it is the gap distribution's spread, which is a genuine mean.
    error: moveSummary.moves ? moveSummary.p_return_error : describeError({ n: gaps.length, values: gaps, unit: "ms" }),
    notes: Object.freeze(
      windowGaps.length === 0
        ? [...notes, "no route in this population has a verified TTL, so P(return) is unavailable, not zero (I4)"]
        : notes,
    ),
  });
}

/**
 * @param {object} args
 * @param {object} [args.store] open continuity store — gaps and moves from persisted rows
 * @param {Array<object>} [args.replays] `replayFixture` outputs
 * @param {object} [args.registry] pricing registry, for the TTL of a route
 * @param {string} [args.pricingKey] pricing key to use for store-derived sessions
 * @param {number} [args.limit] max sessions to consider
 * @param {number} [args.since] epoch ms window start for the move harvest
 */
export function measureReturnRate({
  store = null,
  replays = [],
  registry = null,
  pricingKey = null,
  limit = 200,
  since = 0,
} = {}) {
  const notes = [];
  // Moves come only from persisted results: a fixture's route sequence is its author's.
  const moves =
    store?.db && store.turnResults?.routeSequence
      ? harvestMoves(store.turnResults.routeSequence(store.db, { since }), (key) => ttlFor(registry, key))
      : [];
  const moveSummary = summarizeMoves(moves);
  if (moves.length) {
    notes.push(
      `${moves.length} observed route change(s) harvested from turn_results; a move is what accountFallback already did, not a decision M2 made`,
    );
  }

  if (store?.db) {
    const sessions = store.sessions.listSessions(store.db, { limit });
    const ttl = pricingKey && registry ? ttlFor(registry, pricingKey) : null;
    if (!ttl) notes.push(pricingKey ? `no verified TTL for ${pricingKey}` : "no pricing key supplied for store-derived gaps");
    const population = sessions
      .map((s) => {
        const turns = store.turns.listTurns(store.db, s.id, { limit: 1000 });
        return {
          session_id: s.id,
          source: "turns",
          population: "real",
          turns: turns.length,
          ttl_s: ttl,
          gaps: gapsOf(turns.map((t) => t.at)),
        };
      })
      .filter((s) => s.gaps.length);
    if (population.length || moves.length) {
      return summarize({
        population,
        notes,
        ttlSource: "registry",
        moveSummary,
        realGaps: population.reduce((n, s) => n + s.gaps.length, 0),
      });
    }
    notes.push("no persisted session has more than one turn");
  }

  if (Array.isArray(replays) && replays.length) {
    notes.push("derived from fixtures: gap timings are the replay's own, so this validates the reducer and cannot answer Q3");
    const population = replays.map((r) => {
      const times = (r.turns ?? []).map((t) => t.at);
      const ttl = registry ? ttlFor(registry, r.pricing_key) : null;
      const real = r.fixture_source === "captured";
      return {
        session_id: r.fixture_id,
        source: r.fixture_source,
        population: real ? "real" : "synthetic",
        turns: times.length,
        ttl_s: ttl,
        gaps: gapsOf(times),
      };
    });
    const count = (label) =>
      population.filter((s) => s.population === label).reduce((n, s) => n + s.gaps.length, 0);
    return summarize({
      population,
      notes,
      ttlSource: "replay belief",
      moveSummary,
      realGaps: count("real"),
      syntheticGaps: count("synthetic"),
    });
  }

  if (moves.length) return summarize({ population: [], notes, ttlSource: "registry", moveSummary });

  return Object.freeze({
    measure: "return_rate",
    question: "Q3",
    status: RUN_STATUS.BLOCKED,
    blocked_reason: store?.db ? BLOCKED_REASON.NO_ROWS : BLOCKED_REASON.NO_FIXTURES,
    n: 0,
    n_synthetic: 0,
    n_total: 0,
    population: "none",
    sessions: Object.freeze([]),
    error: { band: "unavailable", basis: "no sessions" },
    notes: Object.freeze(notes),
  });
}

export default measureReturnRate;
