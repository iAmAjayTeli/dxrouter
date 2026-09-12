/**
 * `prefix_stability` (§19.4, Q2) — how long a session's cacheable prefix survives.
 *
 * Q2 asks whether the tools/system prefix of a real coding session holds still long
 * enough for a cache window to be worth anything. The measure counts, per session, how
 * many turns pass before each layer is first invalidated, what fraction of turns leave the
 * front of the prefix untouched, and — the quantity a cache window actually depends on —
 * the distribution of *unbroken runs*.
 *
 * §23 requires **at least three project kinds** before this answers anything: one
 * repository's habits are not a population. Fewer than three and the run is `blocked`
 * with `insufficient_project_kinds` rather than reported with a caveat, because a caveat
 * attached to a number tends to fall off the number. The aggregates are still computed and
 * returned in the blocked case: blocked means "not evidence", not "not computed", and a
 * reviewer deciding whether a fourth project kind is worth collecting needs to see what
 * the first three looked like.
 *
 * Two methodological corrections over the first version, both about the same mistake —
 * treating turns as independent draws:
 *
 *  1. **Runs, not just first breaks.** "The prefix first broke at turn 4" says nothing
 *     about turns 5-200. A cache window is re-earned after every break, so the quantity is
 *     the length of each unbroken run, and the run still open when the log ends is
 *     right-censored — dropping it biases the answer short, counting it as ended biases it
 *     long. `kaplanMeier` is the estimator that handles exactly that.
 *  2. **Sessions are the independent unit.** 200 turns from 3 sessions are not 200 draws.
 *     `bootstrapMeanCI` resamples sessions, so the band reflects how many projects were
 *     observed rather than how much traffic they produced.
 *
 * ## Where the sessions come from
 *
 * Two inputs, never both at once:
 *
 *  - `{ store }` reduces the **real observed** M1 record — one `turns` row per request the
 *    router actually served, with the per-layer hashes and `invalidated_layers` exactly as
 *    the live path computed them. This is the only input that can answer Q2 about this
 *    deployment. See `../observed.js`.
 *  - `{ replays }` reduces `replayFixture` output, which is either a **captured** session
 *    (real traffic recorded elsewhere) or a **synthetic** one somebody wrote.
 *
 * Supplying both is not a larger sample, it is two populations added together, so it
 * blocks with `mixed_population` instead of producing a number. `population` keeps the
 * vocabulary the other measures use (`real` covers observed and captured alike, because
 * both are traffic that happened); `population_source` is the finer distinction §19.4
 * needs, and observed traffic is never relabelled synthetic by either field.
 */

import { PREFIX_LAYERS } from "../../prefix/hasher.js";
import { BLOCKED_REASON, RUN_STATUS } from "../harness.js";
import { OBSERVED_SOURCE, observedSessions } from "../observed.js";
import { bootstrapMeanCI, kaplanMeier } from "../stats.js";

const MIN_PROJECT_KINDS = 3;

/** The layers whose survival a cache window depends on. `messages` changes every turn. */
export const FRONT_LAYERS = Object.freeze(["tools", "system"]);

const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** Turns until the first invalidation of `layer`, or null if it never broke. */
function firstBreak(turns, layer) {
  for (const turn of turns) {
    // Turn 0 invalidates everything by construction (there was no previous prefix);
    // counting that as instability would report every session as maximally unstable.
    if (turn.i === 0) continue;
    if ((turn.invalidated ?? []).includes(layer)) return turn.i;
  }
  return null;
}

/**
 * Lengths of the consecutive stretches in which the front of the prefix held.
 *
 * A run ends at the turn that breaks it (`event: true`); the run still open when the
 * session ends is returned with `event: false`, which is what tells Kaplan-Meier it is
 * censored rather than short. A break on the very first post-zero turn yields a zero-length
 * run, and that is the honest number: no turn was served from that window.
 */
export function frontRuns(turns) {
  const runs = [];
  let held = 0;
  let seen = 0;
  for (const turn of turns) {
    if (turn.i === 0) continue;
    seen += 1;
    const broke = FRONT_LAYERS.some((layer) => (turn.invalidated ?? []).includes(layer));
    if (broke) {
      runs.push({ duration: held, event: true });
      held = 0;
    } else {
      held += 1;
    }
  }
  // The trailing run is right-censored: the prefix had not broken when observation stopped.
  if (seen > 0) runs.push({ duration: held, event: false });
  return runs;
}

/** Per-session summary, plus the per-turn flags the aggregates need. */
function analyse(replay) {
  const turns = replay.turns ?? [];
  const after0 = turns.filter((t) => t.i > 0);
  const invalidatedIn = (turn) => turn.invalidated ?? [];
  const frontFlags = after0.map((t) => (FRONT_LAYERS.some((l) => invalidatedIn(t).includes(l)) ? 0 : 100));
  const layerFlags = {};
  for (const layer of PREFIX_LAYERS) layerFlags[layer] = after0.map((t) => (invalidatedIn(t).includes(layer) ? 100 : 0));

  const breaks = {};
  for (const layer of PREFIX_LAYERS) breaks[`first_${layer}_break`] = firstBreak(turns, layer);

  // A window can start a record in the middle of a session. The stretch running at that
  // edge is *left*-censored — we cannot see how long the front had already held — and
  // Kaplan-Meier has no way to express that, so it is dropped rather than counted as a
  // short run. Everything after the first break inside the window is fully observed and
  // stays. `truncated` is reported so a reader knows a session contributed one run fewer.
  const truncated = Boolean(replay.truncated) || (turns.length > 0 && !turns.some((t) => t.i === 0));
  const allRuns = frontRuns(turns);
  const runs = truncated ? allRuns.slice(1) : allRuns;
  const completed = runs.filter((r) => r.event);

  // M1 observes requests; it keeps no cache ledger, so an observed session has no `belief`
  // on any turn. Counting that as zero warm turns would be a fabricated measurement of
  // exactly the quantity Q1 exists to establish (I4), so it is null unless some turn
  // actually carried a belief.
  const withBelief = turns.filter((t) => t.belief !== null && t.belief !== undefined);

  const summary = Object.freeze({
    fixture_id: replay.fixture_id,
    fixture_source: replay.fixture_source,
    project_kind: replay.project_kind ?? null,
    project_kind_source: replay.project_kind_source ?? (replay.project_kind ? "fixture_declared" : "unknown"),
    turns: turns.length,
    truncated,
    first_turn_idx: turns.length ? turns[0].i : null,
    ...breaks,
    // "Front held" = tools and system both survived the turn. That is the population a
    // cache window actually depends on; a changed `messages` layer is normal per turn.
    front_held_turns: frontFlags.filter((v) => v === 100).length,
    front_held_pct: after0.length ? pct1(frontFlags.filter((v) => v === 100).length, after0.length) : null,
    front_breaks: completed.length,
    longest_front_run: runs.reduce((m, r) => Math.max(m, r.duration), 0),
    warm_turns: withBelief.length ? withBelief.filter((t) => (t.belief?.warm_prefix ?? []).length > 0).length : null,
  });
  return { summary, frontFlags, layerFlags, runs };
}

/**
 * The aggregates, computed the same way whether the run is reported or blocked.
 *
 * Per-layer churn is a *mean of per-turn indicators*, bootstrapped over sessions. The
 * pooled percentage is also reported, because a reader checking the arithmetic needs the
 * raw ratio the band was built from.
 */
function aggregate(analysed) {
  const byLayer = PREFIX_LAYERS.map((layer) => {
    const clusters = analysed.map((a) => a.layerFlags[layer]).filter((xs) => xs.length);
    const flat = clusters.flat();
    return Object.freeze({
      layer,
      turns: flat.length,
      churned_turns: flat.filter((v) => v === 100).length,
      churn_pct: pct1(flat.filter((v) => v === 100).length, flat.length),
      // Sessions, not turns, are the independent unit: see the module header.
      churn_error: bootstrapMeanCI(clusters, { unit: "%", seed: 20260901 }),
    });
  });

  const frontClusters = analysed.map((a) => a.frontFlags).filter((xs) => xs.length);
  const frontFlat = frontClusters.flat();
  const runs = analysed.flatMap((a) => a.runs);

  return {
    by_layer: Object.freeze(byLayer),
    front_held_turns: frontFlat.filter((v) => v === 100).length,
    front_turns: frontFlat.length,
    front_held_pct_mean: pct1(frontFlat.filter((v) => v === 100).length, frontFlat.length),
    front_held_error: bootstrapMeanCI(frontClusters, { unit: "%", seed: 20260901 }),
    // The distribution a cache window lives in: how many turns an unbroken front lasted,
    // with the still-open run at the end of each session censored rather than dropped.
    front_run_turns: kaplanMeier(runs, { unit: " turns" }),
    front_runs_observed: runs.length,
    front_runs_censored: runs.filter((r) => !r.event).length,
  };
}

/**
 * The same reduction, per project kind.
 *
 * §23's three-kinds rule exists because prefix churn is a property of how a project is
 * worked on, not of the router. A pooled number can hide that entirely — one very chatty
 * repository can supply most of the turns — so the per-kind rows are reported beside it.
 * Sessions with no resolvable root are grouped under `project_kind: null` and are visible
 * as such; they are not folded into a neighbouring kind and do not count toward the three.
 *
 * Each kind's band is clustered over its own sessions, so a kind observed once gets
 * "unavailable" rather than a zero-width interval.
 */
function aggregateByProjectKind(analysed) {
  const groups = new Map();
  for (const a of analysed) {
    const key = a.summary.project_kind ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const rows = [];
  for (const [kind, group] of groups) {
    const agg = aggregate(group);
    rows.push(
      Object.freeze({
        project_kind: kind,
        project_kind_source: group[0].summary.project_kind_source,
        sessions: group.length,
        turns: group.reduce((n, a) => n + a.summary.turns, 0),
        front_turns: agg.front_turns,
        front_held_pct: agg.front_held_pct_mean,
        front_held_error: agg.front_held_error,
        front_run_turns: agg.front_run_turns,
        front_runs_observed: agg.front_runs_observed,
        front_runs_censored: agg.front_runs_censored,
        churn_pct: Object.freeze(Object.fromEntries(agg.by_layer.map((l) => [l.layer, l.churn_pct]))),
      }),
    );
  }
  // Named kinds first, in a stable order; the unknown group last, where it reads as the
  // remainder it is.
  return Object.freeze(
    rows.sort((a, b) => {
      if (a.project_kind === null) return 1;
      if (b.project_kind === null) return -1;
      return String(a.project_kind).localeCompare(String(b.project_kind));
    }),
  );
}

/** Population labels, from the provenance each session declared. */
function classifyPopulation(sessions) {
  const observed = sessions.filter((s) => s.fixture_source === OBSERVED_SOURCE).length;
  const captured = sessions.filter((s) => s.fixture_source === "captured").length;
  const synthetic = sessions.length - observed - captured;
  const present = [
    observed ? OBSERVED_SOURCE : null,
    captured ? "captured" : null,
    synthetic ? "synthetic" : null,
  ].filter(Boolean);
  return {
    observed,
    captured,
    synthetic,
    present,
    // Shared with `coverage` and `return_rate`: real is traffic that happened, whether we
    // watched it here or recorded it elsewhere.
    population:
      sessions.length === 0 ? "none" : synthetic === 0 ? "real" : observed + captured === 0 ? "synthetic" : "mixed",
    // The finer answer §19.4 asks for, so observed traffic and a captured fixture stay
    // distinguishable even though both are "real".
    population_source: present.length === 1 ? present[0] : present.length === 0 ? "none" : "mixed",
  };
}

/**
 * @param {object} args
 * @param {object} [args.store] an open continuity store — reduces observed M1 sessions
 * @param {number} [args.since] epoch ms window applied to `turns.at`
 * @param {number} [args.limit] max observed sessions
 * @param {Array<object>} [args.replays] `replayFixture` outputs, one per session
 * @param {number} [args.minProjectKinds]
 */
export function measurePrefixStability({
  store = null,
  since = 0,
  limit = 200,
  replays = [],
  minProjectKinds = MIN_PROJECT_KINDS,
} = {}) {
  const observed = store ? observedSessions({ store, since, limit }) : [];
  const records = [...observed, ...(replays || [])];
  const analysed = records.map(analyse);
  const sessions = analysed.map((a) => a.summary);
  const notes = [];

  if (!sessions.length) {
    return Object.freeze({
      measure: "prefix_stability",
      question: "Q2",
      status: RUN_STATUS.BLOCKED,
      // Which emptiness this is matters to whoever has to fix it: an empty store needs
      // traffic, an empty fixture directory needs files.
      blocked_reason: store ? BLOCKED_REASON.NO_ROWS : BLOCKED_REASON.NO_FIXTURES,
      n: 0,
      n_observed: 0,
      n_captured: 0,
      n_synthetic: 0,
      n_total: 0,
      population: "none",
      population_source: "none",
      sessions: Object.freeze([]),
      error: { band: "unavailable", basis: "no sessions" },
      notes: Object.freeze([store ? "no observed turns in this window" : "no fixtures to replay"]),
    });
  }

  const kinds = [...new Set(sessions.map((s) => s.project_kind).filter(Boolean))];
  const unknownKind = sessions.filter((s) => s.project_kind === null).length;
  const { observed: nObserved, captured, synthetic, present, population, population_source } = classifyPopulation(sessions);

  const aggregates = aggregate(analysed);
  const byProjectKind = aggregateByProjectKind(analysed);
  const truncated = sessions.filter((s) => s.truncated).length;

  const base = {
    measure: "prefix_stability",
    question: "Q2",
    // `n` is the number of independent units the bands were built from, which for this
    // measure is sessions.
    n: sessions.length,
    n_observed: nObserved,
    n_captured: captured,
    n_synthetic: synthetic,
    n_total: sessions.length,
    population,
    population_source,
    population_sources: Object.freeze({ observed: nObserved, captured, synthetic }),
    project_kinds: Object.freeze(kinds),
    project_kinds_unknown: unknownKind,
    required_project_kinds: minProjectKinds,
    sessions: Object.freeze(sessions),
    by_project_kind: byProjectKind,
    truncated_sessions: truncated,
    ...aggregates,
  };

  if (synthetic) {
    notes.push(
      `${synthetic}/${sessions.length} sessions are synthetic: they exhibit the stability their author wrote, not a measured population`,
    );
  }
  if (nObserved) {
    notes.push(`${nObserved} session(s) are observed M1 traffic from this deployment; no fixture is counted among them`);
  }
  if (truncated) {
    notes.push(
      `${truncated} session(s) start mid-history because of the window; their leading run is left-censored and was dropped, not counted short`,
    );
  }
  if (unknownKind) {
    notes.push(`${unknownKind} session(s) have no resolvable project root and are grouped as project_kind=null, not assigned a kind`);
  }
  if (sessions.every((s) => s.warm_turns === null)) {
    notes.push("warm_turns is unavailable: M1 records requests, not cache beliefs, so no turn here claims a warm prefix (I4)");
  }

  // Two populations added together is not a bigger sample. A note would not be enough:
  // the bands would already have been computed across the join by the time anyone read it.
  if (population_source === "mixed") {
    return Object.freeze({
      ...base,
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.MIXED_POPULATION,
      error: { band: "unavailable", basis: `population mixes ${present.join(" + ")}` },
      notes: Object.freeze([
        ...notes,
        `population mixes ${present.join(" + ")}: measure one population at a time (--fixture selects fixtures; with no --fixture the observed store is the population)`,
      ]),
    });
  }

  // The bands are computed over whatever population was supplied, so a synthetic run says
  // so in one place a reader cannot miss: `population`, and this note.
  if (population !== "real") {
    notes.push(`population is ${population}: churn and run-length bands describe the fixtures, not observed projects`);
  }

  if (kinds.length < minProjectKinds) {
    return Object.freeze({
      ...base,
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.INSUFFICIENT_PROJECT_KINDS,
      error: { band: "unavailable", basis: `${kinds.length} project kind(s), ${minProjectKinds} required` },
      notes: Object.freeze([...notes, `Q2 needs >= ${minProjectKinds} project kinds (§23)`]),
    });
  }

  return Object.freeze({
    ...base,
    status: RUN_STATUS.OK,
    // The headline band is the session-clustered one, not a normal approximation over
    // turns: the unit of independence is the project.
    error: aggregates.front_held_error,
    notes: Object.freeze(notes),
  });
}

export default measurePrefixStability;
