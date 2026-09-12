/**
 * `cache_probe` (§19.4, Q1) — the only measure that sends real requests.
 *
 * The question it exists for: does this provider actually report cache reads, and does a
 * warm prefix actually survive the TTL it documents? Nothing in the repository can answer
 * that. Documentation says what a provider intends; a probe finds out.
 *
 * Because it spends the operator's money on the operator's own credentials, the refusals
 * come before any code that could send something:
 *
 *  - `optIn` must be literally true. There is no default-on path and no env read here:
 *    the host decides what "opted in" means and passes the boolean.
 *  - A `RouteExecutor` must be supplied. The engine has no HTTP client of its own (I1),
 *    which also keeps this honest — probes leave through the same adapter a real request
 *    would use.
 *  - A route must name a provider and a model, and a `Clock` port must be supplied.
 *  - `planProbe()` states the request count, the token volume *and the wall-clock time*
 *    before anything is sent, so a host can print the cost and stop.
 *
 * The probe body is a fixed filler string repeated to length — never a user prompt, never
 * a captured transcript. Each rung of the ladder is a write, a wait, and a read against a
 * byte-identical prefix: the read either reports a cache read or does not. Silence is a
 * finding, not a failure.
 *
 * **The ladder is what makes this a TTL measurement rather than a cache-existence check.**
 * One 5-second gap can only tell you the cache exists. A ladder of gaps brackets the
 * window: the largest gap that still reported a read and the smallest that did not are the
 * two ends of an interval, and that interval is the honest form of the answer. A single
 * measured TTL number would be false precision (§10.4) — the ladder never observed the
 * boundary, only that it lies between two rungs.
 *
 * `arms` exists because the expensive half of a ladder is often not the interesting half.
 * Relative to a registry TTL, `below` runs only the rungs that should hit and `above` only
 * the rungs that should miss; `both` runs everything. With no verified TTL there is nothing
 * to split on, and every rung runs.
 *
 * **Billed-vs-reported stays a human step.** The probe records what the provider reported;
 * whether the invoice agrees is a number only the operator's console can supply. This file
 * reports the reported side and says plainly that the comparison is unreconciled — a
 * fabricated billing figure would be exactly the measurement nobody made.
 */

import { classifyCacheResult } from "../../cache/observer.js";
import { BLOCKED_REASON, describeError, RUN_STATUS } from "../harness.js";

/** Filler with no semantic content: nothing here derives from user material. */
const FILLER_SENTENCE = "The quick brown fox jumps over the lazy dog. ";

/** ~4 bytes per token, matching the M1 estimator's own convention. */
export function probeFiller(tokens) {
  const targetChars = Math.max(1, Math.trunc(tokens) * 4);
  return FILLER_SENTENCE.repeat(Math.ceil(targetChars / FILLER_SENTENCE.length)).slice(0, targetChars);
}

/** The ladder §19.4's Q1 plan calls for: either side of the two verified 300 s records, and either side of an hour. */
export const DEFAULT_LADDER_MS = Object.freeze([30_000, 120_000, 240_000, 330_000, 600_000, 1_800_000, 3_900_000]);

/** Which side of a verified TTL to spend requests on. */
export const PROBE_ARMS = Object.freeze({ ABOVE: "above", BELOW: "below", BOTH: "both" });

/**
 * `"30s,2m,5.5m"` → `[30000, 120000, 330000]`. Bare numbers are milliseconds, so an
 * operator who passes `5000` gets 5 seconds rather than 5000 of something.
 */
export function parseLadder(spec) {
  if (spec === null || spec === undefined || spec === "") return null;
  const parts = Array.isArray(spec) ? spec : String(spec).split(",");
  const out = [];
  for (const raw of parts) {
    if (typeof raw === "number") {
      if (Number.isFinite(raw) && raw > 0) out.push(Math.trunc(raw));
      continue;
    }
    const text = String(raw).trim().toLowerCase();
    const match = /^([0-9]*\.?[0-9]+)\s*(ms|s|m|h)?$/.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = match[2] || "ms";
    const scale = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
    out.push(Math.trunc(value * scale));
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/** Human-readable rung label, so a report table reads in the units an operator typed. */
export function ladderLabel(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * The rungs this run will actually send, after `arms` has been applied.
 *
 * `ttlS` is the *believed* window, and it decides only which rungs are worth paying for.
 * It never enters a verdict: a rung's result is what the provider reported, not what the
 * registry expected.
 */
export function selectRungs(ladderMs, { arms = PROBE_ARMS.BOTH, ttlS = null } = {}) {
  const rungs = Array.isArray(ladderMs) && ladderMs.length ? [...ladderMs].sort((a, b) => a - b) : [];
  const ttlMs = Number.isFinite(ttlS) && ttlS > 0 ? ttlS * 1000 : null;
  if (arms === PROBE_ARMS.BOTH || ttlMs === null) return rungs;
  return arms === PROBE_ARMS.BELOW ? rungs.filter((ms) => ms <= ttlMs) : rungs.filter((ms) => ms > ttlMs);
}

/**
 * What a probe run would cost, in requests, tokens and wall-clock time, without sending
 * anything. Two calls per rung per repetition: the write, and the read that tests it.
 *
 * The wall-clock figure matters as much as the money: a ladder reaching 65 minutes takes
 * over an hour of waiting, and an operator who was not told that will kill the process
 * halfway and be left with a partial ladder.
 */
export function planProbe({ pricingKey, model, minTokens = 2048, repetitions = 1, gapMs = 5000, ladderMs = null, arms = PROBE_ARMS.BOTH, ttlS = null } = {}) {
  const prefixTokens = Math.max(1, Math.trunc(minTokens));
  const rungs = ladderMs === null ? [Math.max(0, Math.trunc(gapMs))] : selectRungs(ladderMs, { arms, ttlS });
  const requests = repetitions * rungs.length * 2;
  return Object.freeze({
    pricing_key: pricingKey ?? null,
    model: model ?? null,
    requests,
    prefix_tokens: prefixTokens,
    approx_input_tokens: requests * prefixTokens,
    gap_ms: gapMs,
    ladder_ms: Object.freeze(rungs),
    ladder: Object.freeze(rungs.map(ladderLabel)),
    rungs: rungs.length,
    arms,
    repetitions,
    // Waiting, not requesting, is what makes a long ladder expensive in time.
    approx_wall_clock_ms: repetitions * rungs.reduce((sum, ms) => sum + ms, 0),
    real_money: true,
    note: "sends real requests on your credentials and bills your account; nothing is sent unless optIn is true",
  });
}

/**
 * Fold an executor's usage object into the engine's `{input, output, cache_read,
 * cache_write}` shape.
 *
 * Two shapes legitimately arrive here: the engine's own (what a host that already
 * normalized hands over) and the adapter's `*_tokens` spelling (`normalizeUsage`). Reading
 * only one of them made a real executor look like a silent provider — the probe would have
 * reported "this route cannot produce confirmed cache evidence" about a response that
 * reported a cache read. `??` throughout, so an absent field stays null and never becomes a
 * zero (I4).
 */
export function probeUsage(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const v = u[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  };
  return {
    input: pick("input", "input_tokens", "prompt_tokens"),
    output: pick("output", "output_tokens", "completion_tokens"),
    cache_read: pick("cache_read", "cache_read_tokens", "cache_read_input_tokens"),
    cache_write: pick("cache_write", "cache_write_tokens", "cache_creation_input_tokens"),
    estimated: u.estimated === true,
  };
}

function blocked(reason, notes, plan) {
  return Object.freeze({
    measure: "cache_probe",
    question: "Q1",
    status: RUN_STATUS.BLOCKED,
    blocked_reason: reason,
    n: 0,
    plan,
    probes: Object.freeze([]),
    error: { band: "unavailable", basis: "no probe sent" },
    notes: Object.freeze(notes),
  });
}

/**
 * Per-rung verdicts, and the interval the boundary lies in.
 *
 * A rung "hit" if any read-phase response at that gap reported a positive cache read. It
 * "missed" if every read at that gap was a reported zero — that is a report, not silence.
 * A rung whose reads were all silent is neither: it is `unknown`, and folding it into
 * `missed` would turn provider silence into a measured expiry (I4).
 */
export function summarizeLadder(probes) {
  const byRung = new Map();
  for (const probe of probes) {
    if (probe.phase !== "read") continue;
    const key = probe.gap_ms;
    if (!byRung.has(key)) byRung.set(key, []);
    byRung.get(key).push(probe);
  }

  const rungs = [...byRung.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gapMs, reads]) => {
      const reported = reads.filter((r) => r.provider_reported);
      const hits = reads.filter((r) => Number(r.cache_read) > 0);
      const zeros = reported.filter((r) => Number(r.cache_read) === 0);
      const verdict = hits.length ? "hit" : zeros.length ? "miss" : "unknown";
      return Object.freeze({
        gap_ms: gapMs,
        gap: ladderLabel(gapMs),
        reads: reads.length,
        reported: reported.length,
        silent: reads.length - reported.length,
        hits: hits.length,
        reported_zero: zeros.length,
        verdict,
        // The reported side of billed-vs-reported. The billed side is not knowable here.
        reported_read_tokens: reads.reduce((sum, r) => sum + (Number(r.cache_read) || 0), 0),
        reported_input_tokens: reads.reduce((sum, r) => sum + (Number(r.usage_in) || 0), 0),
      });
    });

  const hitRungs = rungs.filter((r) => r.verdict === "hit");
  const missRungs = rungs.filter((r) => r.verdict === "miss");
  const lastHit = hitRungs.length ? hitRungs[hitRungs.length - 1].gap_ms : null;
  const firstMiss = missRungs.length ? missRungs[0].gap_ms : null;

  return {
    rungs: Object.freeze(rungs),
    // Never a point estimate: the probe observed two rungs, not the boundary between them.
    ttl_interval_s: Object.freeze({
      last_hit_s: lastHit === null ? null : lastHit / 1000,
      first_miss_s: firstMiss === null ? null : firstMiss / 1000,
      band:
        lastHit === null && firstMiss === null
          ? "unavailable: no rung produced a reported read or a reported zero"
          : lastHit === null
            ? `< ${firstMiss / 1000}s`
            : firstMiss === null
              ? `>= ${lastHit / 1000}s (no rung missed; the ladder did not reach expiry)`
              : `${lastHit / 1000}s..${firstMiss / 1000}s`,
      basis: "interval between the last rung that reported a read and the first that reported a zero",
    }),
  };
}

/**
 * @param {object} args
 * @param {boolean} args.optIn must be literally true
 * @param {object} args.executor a `RouteExecutor` (`defineRouteExecutor`) — required
 * @param {object} args.clock a `Clock` port
 * @param {object} args.registry pricing registry, for the mechanism under test
 * @param {string} args.pricingKey vendor pricing key
 * @param {object} args.route `{provider, model, connection_id}`
 * @param {number} [args.minTokens] prefix size; the default sits above every shipped minimum
 * @param {number} [args.repetitions]
 * @param {number} [args.gapMs] delay between write and read when no ladder is given
 * @param {Array<number>|string|null} [args.ladder] TTL ladder, e.g. `"30s,2m,5.5m,65m"`
 * @param {string} [args.arms] `above` | `below` | `both`, relative to the registry TTL
 * @param {(ms: number) => Promise<void>} [args.sleep] injected; the engine owns no timer
 */
export async function measureCacheProbe({
  optIn = false,
  executor = null,
  clock = null,
  registry = null,
  pricingKey = null,
  route = null,
  minTokens = 2048,
  repetitions = 1,
  gapMs = 5000,
  ladder = null,
  arms = PROBE_ARMS.BOTH,
  sleep = null,
} = {}) {
  const pricing = registry?.get?.(pricingKey) ?? null;
  const ttlS = pricing && pricing.mechanism !== "none" && Number(pricing.ttl_default_s) > 0 ? Number(pricing.ttl_default_s) : null;
  const ladderMs = parseLadder(ladder);
  const plan = planProbe({ pricingKey, model: route?.model, minTokens, repetitions, gapMs, ladderMs, arms, ttlS });

  if (optIn !== true) return blocked(BLOCKED_REASON.NOT_OPTED_IN, ["cache_probe spends real money; pass optIn: true"], plan);
  if (!executor || typeof executor.execute !== "function") {
    const why = "no RouteExecutor supplied; the engine cannot reach a provider itself (I1)";
    return blocked(BLOCKED_REASON.NO_EXECUTOR, [why], plan);
  }
  if (!route?.provider || !route?.model) {
    return blocked(BLOCKED_REASON.NO_EXECUTOR, ["route must name a provider and a model"], plan);
  }
  if (!clock || typeof clock.now !== "function") {
    return blocked(BLOCKED_REASON.NO_EXECUTOR, ["a Clock port is required; the engine reads no wall clock"], plan);
  }
  if (!plan.rungs) {
    return blocked(BLOCKED_REASON.NO_EXECUTOR, [`the ${arms} arm of this ladder is empty; nothing would be sent`], plan);
  }

  const mechanism = pricing?.mechanism ?? "none";
  const wait = typeof sleep === "function" ? sleep : async () => {};
  const system = probeFiller(plan.prefix_tokens);
  const probes = [];
  const notes = [];
  if (mechanism === "none") {
    notes.push(`${pricingKey} has no verified cache model; a reported read here would be the evidence to add one`);
  }
  if (arms !== PROBE_ARMS.BOTH && ttlS === null) {
    notes.push(`arms=${arms} needs a verified TTL to split on; no record supplies one, so every rung ran`);
  }

  for (let rep = 0; rep < repetitions; rep += 1) {
    for (const rungMs of plan.ladder_ms) {
      for (const phase of ["write", "read"]) {
        const at = clock.now();
        let result = null;
        let failure = null;
        try {
          result = await executor.execute(route, {
            protocol: "openai",
            requested_model: route.model,
            tools: null,
            system,
            // One fixed instruction, identical in both phases, so the prefix is
            // byte-identical and the second call is a genuine cache test.
            messages: [{ role: "user", content: "Reply with the single word: ok" }],
            params: { max_tokens: 16, stream: false },
            client_hint: { source: "dxrouter-cache-probe" },
            arrived_at: at,
          });
        } catch (err) {
          failure = err?.message ? String(err.message).slice(0, 200) : "execute threw";
        }

        const usage = probeUsage(result?.usage);
        const classified = classifyCacheResult({ usage, mechanism });
        probes.push(
          Object.freeze({
            rep,
            phase,
            at,
            // The gap this rung tested. On a write row it is the wait that follows.
            gap_ms: rungMs,
            gap: ladderLabel(rungMs),
            http_status: Number.isFinite(result?.status) ? result.status : null,
            error_class: result?.error_class ?? (failure ? "unknown" : null),
            failure,
            reported_model: result?.reported_model ?? null,
            // The counts as the provider reported them; absent stays null.
            usage_in: usage.input,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
            // 9Router substitutes a byte-length estimate when a provider sends no usage at
            // all. A probe run on estimated numbers is not cache evidence, so it is
            // recorded rather than quietly counted.
            usage_estimated: usage.estimated,
            provider_reported: classified.reported,
            confidence: classified.confidence,
            evidence: classified.evidence,
          }),
        );
        if (phase === "write") await wait(rungMs);
      }
    }
  }

  const reads = probes.filter((p) => p.phase === "read");
  const reportedReads = reads.filter((p) => Number(p.cache_read) > 0);
  const silent = reads.filter((p) => !p.provider_reported);
  if (reads.length && silent.length === reads.length) {
    notes.push("every read-phase response was silent about cache: this route cannot produce confirmed cache evidence today");
  }
  const ladderSummary = summarizeLadder(probes);
  const estimatedReads = reads.filter((p) => p.usage_estimated);
  if (estimatedReads.length) {
    notes.push(
      `${estimatedReads.length}/${reads.length} read-phase response(s) carried 9Router's own byte-length estimate rather than provider-reported usage; an estimate is not cache evidence (I3)`,
    );
  }
  if (ladderSummary.rungs.length > 1) {
    notes.push(`measured TTL is an interval, not a point: ${ladderSummary.ttl_interval_s.band}`);
  }

  return Object.freeze({
    measure: "cache_probe",
    question: "Q1",
    status: RUN_STATUS.OK,
    n: probes.length,
    plan,
    pricing_key: pricingKey,
    mechanism,
    documented_ttl_s: ttlS,
    provider: route.provider,
    model: route.model,
    // Stated as what was observed, not as a conclusion about the provider.
    reads_reported: reportedReads.length,
    reads_attempted: reads.length,
    silent_reads: silent.length,
    failures: probes.filter((p) => p.failure || p.error_class).length,
    ladder: ladderSummary.rungs,
    ttl_interval_s: ladderSummary.ttl_interval_s,
    // What the provider said it read, against a billed figure this process cannot see.
    // Left explicitly unreconciled rather than filled in with the reported number, which
    // would make the comparison agree with itself by construction.
    billed_vs_reported: Object.freeze({
      status: "unreconciled",
      reported_read_tokens: reads.reduce((sum, r) => sum + (Number(r.cache_read) || 0), 0),
      reported_input_tokens: reads.reduce((sum, r) => sum + (Number(r.usage_in) || 0), 0),
      billed_read_tokens: null,
      note: "compare these against the provider console for the same window; only a human with the invoice can close this, and no number here stands in for it",
    }),
    probes: Object.freeze(probes),
    error: describeError({ n: reads.length, values: reads.map((p) => Number(p.cache_read) || 0), unit: " tokens" }),
    notes: Object.freeze(notes),
  });
}

export default measureCacheProbe;
