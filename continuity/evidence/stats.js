/**
 * Interval estimators the evidence measures actually need (I-6).
 *
 * `harness.describeError` states a normal-approximation interval on a mean. That is the
 * right tool for a genuine mean of roughly symmetric independent values — `arithmetic_
 * accuracy`'s per-turn error, say — and the wrong tool for all three of the quantities
 * §19.4's questions are really about:
 *
 *  - **A proportion** (Q1 cache-reporting coverage, Q3 P(return)). The normal
 *    approximation on 0/1 data produces intervals that cross 0% and 100%, and collapses
 *    to +/-0 at p = 0 or p = 1 — exactly where the answer matters and exactly where the
 *    approximation has no coverage. `wilsonInterval` is bounded by construction and
 *    behaves at the edges, which is why it is the standard choice for small n.
 *  - **A clustered mean** (Q2 per-layer churn). Turns from one session are not
 *    independent draws; treating 200 turns from 3 sessions as n = 200 understates the
 *    interval by roughly the square root of the cluster size. `bootstrapMeanCI` resamples
 *    *sessions*, so the interval reflects how many independent projects were observed
 *    rather than how much traffic they produced.
 *  - **A duration that is still running** (Q2 unbroken prefix runs, Q3 time-to-return).
 *    A prefix run that has not broken yet, and a session that has not returned yet, are
 *    right-censored observations. Dropping them biases the estimate downward; counting
 *    them as completed biases it the other way. `kaplanMeier` is the estimator that
 *    handles censoring without inventing an end date.
 *
 * Everything here is pure and deterministic — the bootstrap takes a seed, so a rerun over
 * the same rows produces the same interval and a report can be reproduced from its
 * inputs. No clock, no store, no randomness a caller cannot pin.
 *
 * Every return value carries `basis`, the same contract `describeError` uses: the method
 * travels with the number into the markdown report, so no reader has to guess which
 * estimator produced a band.
 */

const round = (v, dp = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const finite = (xs) => (Array.isArray(xs) ? xs.map(Number).filter(Number.isFinite) : []);

/** The 95% two-sided normal quantile, named so the arithmetic is checkable. */
export const Z95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion.
 *
 * Reported as percentages because every consumer displays percentages, and with `band`
 * pre-rendered in the `mean +/- half` shape the report already knows how to print. The
 * interval is asymmetric in general, so `half` is the wider of the two arms — an honest
 * overstatement rather than a symmetric fiction that hides one side. `low_pct`/`high_pct`
 * carry the actual asymmetric bounds for a reader who wants them.
 *
 * @param {number} successes
 * @param {number} total
 * @param {number} [z]
 */
export function wilsonInterval(successes, total, z = Z95) {
  const k = Number(successes);
  const n = Number(total);
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) {
    return { band: "unavailable", basis: "no observations" };
  }
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const low = Math.max(0, centre - spread);
  const high = Math.min(1, centre + spread);
  // The point estimate stays the observed proportion; only the interval is Wilson. A
  // reader comparing the number against a raw count must find the raw count.
  const half = Math.max(p - low, high - p);
  return {
    band: `${round(p * 100)}% +/- ${round(half * 100)}%`,
    basis: `Wilson score interval, 95%, n=${n}`,
    mean: round(p * 100),
    successes: k,
    n,
    low_pct: round(low * 100),
    high_pct: round(high * 100),
    // Not the reported estimate: the Wilson interval is not centred on `p`, and a reader
    // checking the arithmetic will look for the centre it *is* built around.
    wilson_centre_pct: round(centre * 100),
  };
}

/** Deterministic 32-bit PRNG (mulberry32). A seeded bootstrap is a reproducible bootstrap. */
export function seededRandom(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap CI for a mean over *clusters*.
 *
 * `clusters` is an array of arrays: one inner array per independent unit (a session, a
 * project). Each replicate resamples clusters with replacement and takes the mean of all
 * values in the resampled clusters — the cluster bootstrap, which is what makes the
 * interval reflect the number of sessions rather than the number of turns.
 *
 * Refuses below two clusters rather than returning a zero-width interval: one project
 * cannot support a statement about projects, and §10.4's rule against false precision is
 * exactly this case.
 *
 * @param {Array<Array<number>>} clusters
 * @param {{iterations?: number, seed?: number, unit?: string}} [opts]
 */
export function bootstrapMeanCI(clusters = [], { iterations = 2000, seed = 12345, unit = "" } = {}) {
  const groups = (Array.isArray(clusters) ? clusters : []).map(finite).filter((g) => g.length > 0);
  const all = groups.flat();
  if (groups.length < 2 || all.length < 2) {
    return { band: "unavailable", basis: `sample too small (clusters=${groups.length}, values=${all.length})` };
  }
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const point = mean(all);

  const rnd = seededRandom(seed);
  const replicates = [];
  for (let i = 0; i < iterations; i += 1) {
    const pooled = [];
    for (let g = 0; g < groups.length; g += 1) pooled.push(...groups[Math.floor(rnd() * groups.length)]);
    if (pooled.length) replicates.push(mean(pooled));
  }
  replicates.sort((a, b) => a - b);
  const at = (q) => replicates[Math.min(replicates.length - 1, Math.max(0, Math.round(q * (replicates.length - 1))))];
  const low = at(0.025);
  const high = at(0.975);
  return {
    band: `${round(point)} +/- ${round(Math.max(point - low, high - point))}${unit}`,
    basis: `cluster bootstrap (percentile, 95%), clusters=${groups.length}, values=${all.length}, iterations=${iterations}, seed=${seed}`,
    mean: round(point),
    low: round(low),
    high: round(high),
    clusters: groups.length,
    n: all.length,
  };
}

/**
 * Kaplan-Meier survival estimate with right-censoring.
 *
 * `observations` is `[{duration, event}]`, where `event: true` means the thing ended (the
 * prefix broke, the session returned) and `event: false` means the observation merely
 * stopped (the log ended while the prefix still held). The estimator keeps censored rows
 * in the risk set without pretending they ended.
 *
 * `median` is the first duration at which survival drops to 0.5 or below, and is `null`
 * when survival never gets there — which is a real answer ("more than half were still
 * unbroken when observation stopped"), not a missing one. `median_reached` says which case
 * a reader is looking at.
 *
 * @param {Array<{duration: number, event: boolean}>} observations
 * @param {{unit?: string}} [opts]
 */
export function kaplanMeier(observations = [], { unit = "" } = {}) {
  const rows = (Array.isArray(observations) ? observations : [])
    .map((o) => ({ duration: Number(o?.duration), event: o?.event === true }))
    .filter((o) => Number.isFinite(o.duration) && o.duration >= 0)
    .sort((a, b) => a.duration - b.duration);
  if (rows.length === 0) return { band: "unavailable", basis: "no observations" };
  const events = rows.filter((r) => r.event).length;

  let atRisk = rows.length;
  let survival = 1;
  // Greenwood's formula, accumulated as the walk goes, so the variance uses the same risk
  // set the survival step did.
  let greenwood = 0;
  const curve = [];
  let median = null;
  let i = 0;
  while (i < rows.length) {
    const t = rows[i].duration;
    let died = 0;
    let censored = 0;
    while (i < rows.length && rows[i].duration === t) {
      if (rows[i].event) died += 1;
      else censored += 1;
      i += 1;
    }
    if (died > 0) {
      survival *= 1 - died / atRisk;
      if (atRisk > died) greenwood += died / (atRisk * (atRisk - died));
      curve.push({ t: round(t), at_risk: atRisk, events: died, survival: round(survival, 4) });
      if (median === null && survival <= 0.5) median = t;
    }
    atRisk -= died + censored;
    if (atRisk <= 0) break;
  }

  // Mean restricted to the observed window: the area under the curve out to the last
  // observation. Unrestricted mean survival is not estimable under censoring, and
  // reporting one anyway would be the false precision §10.4 forbids.
  let rmst = 0;
  let previousT = 0;
  let previousS = 1;
  for (const step of curve) {
    rmst += previousS * (step.t - previousT);
    previousT = step.t;
    previousS = step.survival;
  }
  const horizon = rows[rows.length - 1].duration;
  rmst += previousS * (horizon - previousT);

  const se = survival > 0 ? survival * Math.sqrt(greenwood) : 0;
  return {
    band:
      median === null
        ? `median not reached (> ${round(horizon)}${unit})`
        : `median ${round(median)}${unit} (KM, n=${rows.length}, events=${events})`,
    basis: `Kaplan-Meier with right-censoring, n=${rows.length}, events=${events}, censored=${rows.length - events}`,
    median: median === null ? null : round(median),
    median_reached: median !== null,
    n: rows.length,
    events,
    censored: rows.length - events,
    horizon: round(horizon),
    restricted_mean: round(rmst),
    survival_at_horizon: round(survival, 4),
    survival_at_horizon_se: round(se, 4),
    curve,
  };
}

export default { wilsonInterval, bootstrapMeanCI, kaplanMeier, seededRandom, Z95 };
