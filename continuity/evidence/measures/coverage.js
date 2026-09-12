/**
 * `coverage` (§19.4, Q1) — what fraction of responses carry usable cache usage fields.
 *
 * The measurement that decides whether `confirmed` evidence is obtainable at all from a
 * given provider. A provider that never reports cannot produce a confirmed belief no
 * matter how warm its cache actually is, and until this is measured, "the provider
 * reports cache reads" is a documentation claim.
 *
 * Two input sources, both local, per §19.4: persisted `turn_results` rows (the live
 * observation path), and replayed fixtures. Fixture-derived coverage is labelled as such
 * in the result, because a synthetic fixture reports whatever its author wrote into it —
 * it can validate the reducer, and it cannot answer Q1.
 *
 * Three things this file is careful about, each of them a way a coverage number could lie:
 *
 *  1. **`n` counts real observations only.** A run over synthetic fixtures reports `n: 0`
 *     with `n_synthetic` beside it and `population: "synthetic"`. `buildExperimentRow`
 *     takes `n` from here, so the `experiments` row — the thing §23's gate reads — cannot
 *     inherit a sample size that no provider contributed to.
 *  2. **The band is a proportion, and only over the real subset.** The earlier version
 *     averaged per-provider percentages while reporting `n` as the row count, which
 *     produced intervals like `22.75% +/- 44.59%`: a band on four providers wearing the
 *     sample size of 89 rows. `wilsonInterval` over (reported reads / rows) is the actual
 *     quantity Q1 asks about, is bounded, and behaves at 0% and 100%.
 *  3. **The alias is not the vendor.** `by_pricing_key` groups by what the adapter mapped
 *     the alias to, because "does Anthropic report cache reads?" is a question about
 *     Anthropic, not about `claude` versus `kiro`. Both groupings are reported; neither
 *     replaces the other.
 */

import { BLOCKED_REASON, RUN_STATUS } from "../harness.js";
import { wilsonInterval } from "../stats.js";

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** Shape one group's row into the measure's own vocabulary. */
function shapeRow(row, population) {
  const total = row.total || 0;
  return {
    provider: row.provider ?? row.group_key ?? "(unknown)",
    group_by: row.group_by ?? "provider",
    population,
    // `n` is responses, not attempts: an attempt that failed reported nothing because it
    // got nothing, and counting it as provider silence would read as evidence about the
    // provider's usage fields. Both counts are reported so the denominator is checkable.
    n: total,
    attempts: row.attempts ?? total,
    failed: row.failed ?? 0,
    reported_read: row.reported_read || 0,
    reported_write: row.reported_write || 0,
    silent: row.silent || 0,
    silent_but_assumed: row.silent_but_assumed || 0,
    confirmed: row.confirmed || 0,
    assumed: row.assumed || 0,
    unknown: row.unknown || 0,
    read_coverage_pct: pct(row.reported_read || 0, total),
    write_coverage_pct: pct(row.reported_write || 0, total),
    confirmed_pct: pct(row.confirmed || 0, total),
    cache_read_tokens: row.cache_read_tokens || 0,
    cache_write_tokens: row.cache_write_tokens || 0,
    // Provenance of the counts, so a reader can see how much of a coverage percentage
    // rests on numbers 9Router estimated rather than numbers a provider sent (I3).
    measured: row.measured ?? null,
    estimated: row.estimated ?? null,
    unavailable: row.unavailable ?? null,
  };
}

/** An empty accumulator for the fixture path, which has no SQL to do the counting. */
function emptyGroup(key) {
  return {
    provider: key,
    total: 0,
    attempts: 0,
    failed: 0,
    reported_read: 0,
    reported_write: 0,
    silent: 0,
    silent_but_assumed: 0,
    confirmed: 0,
    assumed: 0,
    unknown: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    measured: 0,
    estimated: 0,
    unavailable: 0,
  };
}

/**
 * Aggregate replayed turns by a chosen key.
 *
 * A replay's `fixture_source` decides which population its turns belong to: `captured`
 * traffic carries what a provider really reported and is real evidence; anything else is
 * the fixture author's arithmetic. The two are aggregated separately and never summed.
 */
function aggregateReplays(replays, keyOf) {
  const acc = new Map();
  for (const replay of replays) {
    const population = replay.fixture_source === "captured" ? "real" : "synthetic";
    const key = keyOf(replay) ?? "(unknown)";
    const id = `${population} ${key}`;
    const row = acc.get(id) ?? { ...emptyGroup(key), population, group_by: "provider" };
    for (const turn of replay.turns ?? []) {
      row.attempts += 1;
      // A replayed turn that did not end cleanly is an attempt with no response, the same
      // as a failed live attempt, and stays out of the coverage denominator. The rule is the
      // engine's one definition of failure — anything that is not `ok` — so a fixture
      // declaring `unknown` is not quietly counted as provider silence.
      if (turn.status && turn.status !== "ok") {
        row.failed += 1;
        continue;
      }
      row.total += 1;
      if (turn.reported_read_tokens !== null) row.reported_read += 1;
      if (turn.reported_write_tokens !== null) row.reported_write += 1;
      if (!turn.provider_reported) row.silent += 1;
      if (turn.reported_read_tokens === null && turn.cache_confidence === "assumed") row.silent_but_assumed += 1;
      if (turn.cache_confidence === "confirmed") row.confirmed += 1;
      if (turn.cache_confidence === "assumed") row.assumed += 1;
      if (turn.cache_confidence === "unknown") row.unknown += 1;
      row.cache_read_tokens += turn.reported_read_tokens ?? 0;
      row.cache_write_tokens += turn.reported_write_tokens ?? 0;
      // A replay reconstructs counts from the fixture; there is no provider provenance
      // to report, so these stay at zero rather than claiming `measured`.
    }
    acc.set(id, row);
  }
  return [...acc.values()];
}

/** Sum one field across rows of one population. */
const sumOf = (rows, field, population = null) =>
  rows.filter((r) => population === null || r.population === population).reduce((s, r) => s + (r[field] || 0), 0);

/**
 * @param {object} args
 * @param {object} [args.store] an open continuity store; rows come from `turn_results`
 * @param {Array<object>} [args.replays] `replayFixture` outputs, used when there are no rows
 * @param {number} [args.since] epoch ms window start
 * @param {string|null} [args.provider] restrict to one provider
 */
export function measureCoverage({ store = null, replays = [], since = 0, provider = null } = {}) {
  const notes = [];
  let byProvider = [];
  let byPricingKey = [];
  let source = null;

  if (store?.db) {
    // Persisted rows are, by construction, what providers did on this machine: real.
    byProvider = store.turnResults.cacheReportingCoverage(store.db, { since, provider }).map((r) => shapeRow(r, "real"));
    byPricingKey = store.turnResults
      .cacheReportingCoverage(store.db, { since, provider, groupBy: "pricing_key" })
      .map((r) => shapeRow(r, "real"));
    if (byProvider.length) source = "turn_results";
  }

  if (!byProvider.length && Array.isArray(replays) && replays.length) {
    source = "fixtures";
    notes.push("derived from fixtures: a synthetic fixture reports what its author wrote, so this cannot answer Q1");
    byProvider = aggregateReplays(replays, (r) => r.provider ?? r.pricing_key).map((r) => shapeRow(r, r.population));
    byPricingKey = aggregateReplays(replays, (r) => r.pricing_key ?? r.provider).map((r) => ({
      ...shapeRow(r, r.population),
      group_by: "pricing_key",
    }));
  }

  const nReal = sumOf(byProvider, "n", "real");
  const nSynthetic = sumOf(byProvider, "n", "synthetic");
  const nTotal = nReal + nSynthetic;
  const population = nTotal === 0 ? "none" : nReal && nSynthetic ? "mixed" : nReal ? "real" : "synthetic";

  if (nTotal === 0) {
    return Object.freeze({
      measure: "coverage",
      question: "Q1",
      status: RUN_STATUS.BLOCKED,
      blocked_reason: store?.db ? BLOCKED_REASON.NO_ROWS : BLOCKED_REASON.NO_FIXTURES,
      n: 0,
      n_synthetic: 0,
      n_total: 0,
      population,
      by_provider: Object.freeze([]),
      by_pricing_key: Object.freeze([]),
      error: { band: "unavailable", basis: "no observations" },
      notes: Object.freeze([...notes, "no results recorded in the window; coverage is unavailable, not zero"]),
    });
  }

  const readsReal = sumOf(byProvider, "reported_read", "real");
  const writesReal = sumOf(byProvider, "reported_write", "real");
  const estimatedReal = sumOf(byProvider, "estimated", "real");

  // The headline band is a proportion over real observations. A synthetic population gets
  // no band at all: an interval computed over fixture rows would be a precise statement
  // about the fixture's author.
  const error =
    nReal > 0
      ? wilsonInterval(readsReal, nReal)
      : { band: "unavailable", basis: "population is synthetic: a fixture cannot report on a provider's cache fields" };

  if (nSynthetic > 0) {
    notes.push(
      `n counts real observations only (${nReal}); ${nSynthetic} synthetic turn(s) are reported as n_synthetic and excluded from the band`,
    );
  }
  const failedReal = sumOf(byProvider, "failed", "real");
  if (failedReal > 0) {
    notes.push(
      `${failedReal} failed attempt(s) in the window are counted as attempts and excluded from n: an attempt with no response is not provider silence`,
    );
  }
  if (estimatedReal > 0) {
    notes.push(
      `${estimatedReal}/${nReal} real rows carry 9Router's own byte-length estimate rather than provider-reported usage; those cannot evidence cache reporting`,
    );
  }

  return Object.freeze({
    measure: "coverage",
    question: "Q1",
    status: RUN_STATUS.OK,
    source,
    since,
    // Real observations only — see the module header.
    n: nReal,
    n_synthetic: nSynthetic,
    n_total: nTotal,
    // Attempts, and the failures among them. Neither is in `n`; both are what makes the
    // denominator auditable rather than merely stated.
    attempts: sumOf(byProvider, "attempts"),
    attempts_failed: sumOf(byProvider, "failed"),
    population,
    read_coverage_pct: pct(readsReal, nReal),
    write_coverage_pct: pct(writesReal, nReal),
    silent_pct: pct(sumOf(byProvider, "silent", "real"), nReal),
    confirmed_pct: pct(sumOf(byProvider, "confirmed", "real"), nReal),
    silent_but_assumed: sumOf(byProvider, "silent_but_assumed", "real"),
    provenance: Object.freeze({
      measured: sumOf(byProvider, "measured", "real"),
      estimated: estimatedReal,
      unavailable: sumOf(byProvider, "unavailable", "real"),
    }),
    by_provider: Object.freeze(byProvider.map(Object.freeze)),
    // The vendor-level view of the same rows: an alias-level table splits one vendor's
    // evidence into thin samples and makes a rarely-used alias look like a finding.
    by_pricing_key: Object.freeze(byPricingKey.map(Object.freeze)),
    error,
    notes: Object.freeze(notes),
  });
}

export default measureCoverage;
