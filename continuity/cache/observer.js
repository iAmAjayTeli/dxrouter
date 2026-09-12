/**
 * observeCacheResult — the one entry point M2 exposes to the live request path.
 *
 * It runs *after* a provider has answered, and it does exactly two things: record what
 * the provider reported about its own cache (`turn_results`), and update what we believe
 * about that route's cache (`cache_entries`). It decides nothing. There is no candidate
 * list here, no cost, no STAY/MOVE/WAIT, and nothing it returns can be routed on — the
 * record is provider names, counts, confidences and layer names.
 *
 * The classification is §9's post-execution triad, plus the write case, and it is the
 * whole reason this file exists in one piece rather than spread across the adapter:
 *
 *   cache_read  > 0                        -> confirmed  (provider_reported_read)
 *   cache_write > 0                        -> confirmed  (provider_reported_write)
 *   the attempt failed, nothing reported    -> unknown    (attempt_failed)
 *   no verified cache model (mechanism none) -> unknown   (no_cache_model)
 *   otherwise: silent, or a reported zero   -> assumed    (assumed_write)
 *
 * The failure case is the one that has to be spelled out. An attempt that never got a
 * response is not a provider that stayed silent about its cache: nothing was cached and
 * nothing was read, so `assumed` would put a belief in the database that no request ever
 * earned. It is recorded as `unknown` / `attempt_failed`, which is the difference between
 * "we have no basis" and "plausibly warm" (I3, I4).
 *
 * A reported zero is a report, not silence, and it is recorded as such in
 * `turn_results.usage_cache_read` (NULL means the field was absent). What it tells us is
 * that no read happened, which is why it still produces an `assumed_write` belief: the
 * prefix we just sent is now plausibly cached, and plausibly is all `assumed` claims.
 *
 * **`cache_entries` are only written when a verified cache model supplies a TTL.** A
 * provider with `mechanism: none` has no window for us to believe in, and an entry with
 * `ttl_s = 0` would be born expired — a row that means nothing but looks like data. Its
 * evidence still lands in `turn_results`, so a provider that reports cache reads without
 * a verified model (several do) is measurable without being priced. That is I4: unknown
 * semantics contribute zero economics, not zero honesty.
 *
 * Effects are injected: the store, the clock, the pricing registry. Like the M1 observer
 * this function throws on a real failure so tests can see it; the adapter is what
 * swallows everything so an observation can never change a response.
 */

import { TOKEN_PROVENANCE, intOrNull } from "../prefix/tokens.js";
import { CACHE_CONFIDENCE, CACHE_EVIDENCE } from "./confidence.js";
import { applyEvidence } from "./entry.js";
import { planCacheWrites } from "./estimator.js";
import { DEFAULT_CACHE_POLICY } from "./policy.js";
import { PRICING_LABELS, PRICING_STATUS } from "./pricing/schema.js";

/** Statuses a result row may carry. `unknown` is what a killed process leaves behind. */
export const RESULT_STATUS = Object.freeze({ OK: "ok", ERROR: "error", UNKNOWN: "unknown" });

/** `null` means "no value", never `0` — see `intOrNull`. */
const int = intOrNull;
const positive = (v) => {
  const n = int(v);
  return n !== null && n > 0 ? n : null;
};

/**
 * Classify one provider result.
 *
 * Pure and exported so the classification can be tested without a database, and so the
 * replay path can reuse it rather than reimplementing the triad.
 */
export function classifyCacheResult({ usage = {}, mechanism = "none", failed = false } = {}) {
  const read = int(usage.cache_read);
  const write = int(usage.cache_write);
  const reported = read !== null || write !== null;

  if (positive(read)) {
    return { confidence: CACHE_CONFIDENCE.CONFIRMED, evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ, reported };
  }
  if (positive(write)) {
    return { confidence: CACHE_CONFIDENCE.CONFIRMED, evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE, reported };
  }
  // Checked after the positive counts on purpose: a stream that reported a cache read and
  // *then* died did have a cache read, and that reported number is a measurement whichever
  // way the attempt ended. Checked before `mechanism` because when both are true, what this
  // row is actually evidence of is the failure.
  if (failed) {
    return { confidence: CACHE_CONFIDENCE.UNKNOWN, evidence: CACHE_EVIDENCE.ATTEMPT_FAILED, reported };
  }
  if (mechanism === "none") {
    return { confidence: CACHE_CONFIDENCE.UNKNOWN, evidence: CACHE_EVIDENCE.NO_CACHE_MODEL, reported };
  }
  return {
    confidence: CACHE_CONFIDENCE.ASSUMED,
    evidence: reported ? CACHE_EVIDENCE.ASSUMED_WRITE : CACHE_EVIDENCE.PROVIDER_SILENT,
    reported,
  };
}

/**
 * Split the layers a cache model would cache into the part a reported read covers and
 * the part it does not.
 *
 * The provider tells us *how many* tokens it read, never *which* ones. What we know is
 * that a cache read is a prefix: the provider matched from the start of the request. So
 * the walk goes in prefix order and a layer counts as read only when the cumulative
 * count through the end of that layer still fits inside the reported number.
 *
 * The bias is deliberate and one-directional: a layer that straddles the boundary is
 * left *out*. Our per-layer counts are estimates (M1 ships no tokenizer), so an
 * off-by-a-little estimate must lose the layer rather than claim a confirmed read over
 * material the provider may not have matched. Under-attribution costs us a `confirmed`
 * label we could have had; over-attribution would put an unearned one in the database,
 * which is what I3 exists to prevent.
 *
 * @param {Array<{layer: string, cumulative_tokens: number}>} candidates plan.eligible
 * @param {number|null} reportedRead
 */
export function attributeRead(candidates = [], reportedRead = null) {
  const read = int(reportedRead);
  if (read === null || read <= 0) return { read: [], unread: [...candidates], attributed_tokens: 0 };

  const covered = [];
  const rest = [];
  let attributed = 0;
  for (const candidate of candidates) {
    if (rest.length === 0 && candidate.cumulative_tokens <= read) {
      covered.push(candidate);
      attributed = candidate.cumulative_tokens;
    } else {
      rest.push(candidate);
    }
  }
  return { read: covered, unread: rest, attributed_tokens: attributed };
}

/** Why no `cache_entries` row was written. Recorded so "nothing happened" is explainable. */
export const NO_ENTRIES = Object.freeze({
  NO_CACHE_MODEL: "no_cache_model",
  NO_TTL: "no_ttl",
  ATTEMPT_FAILED: "attempt_failed",
  NOTHING_ELIGIBLE: "nothing_eligible",
});

function joinList(values) {
  return Array.isArray(values) && values.length ? values.join(",") : null;
}

/**
 * The provider's own counts are measurements; their absence is not a zero.
 *
 * The third case is the one worth naming: 9Router substitutes a byte-length estimate when
 * a provider returns no usage at all (`finalizeStream` → `estimateUsage`), and stamps the
 * object `estimated: true`. Those numbers are non-null, so without this branch they would
 * be filed as MEASURED — a measurement nobody made. `ESTIMATED` is exactly the label
 * `TOKEN_PROVENANCE` already has for "our arithmetic, not theirs" (I3).
 */
export function usageProvenance(usage) {
  const any = ["input", "output", "cache_read", "cache_write"].some((k) => int(usage?.[k]) !== null);
  if (!any) return TOKEN_PROVENANCE.UNAVAILABLE;
  return usage?.estimated === true ? TOKEN_PROVENANCE.ESTIMATED : TOKEN_PROVENANCE.MEASURED;
}

/**
 * Which layers this result is evidence about, and with what evidence — the whole
 * belief-update decision, with no database in it.
 *
 * Shared with `evidence/replay.js` deliberately: a replay that reconstructed cache state
 * by a slightly different rule than the live path would measure the replay, not the
 * engine, and the M2 acceptance band is exactly a comparison between the two.
 */
export function planEvidenceEntries({ pricing, layers, usage = {}, failed = false } = {}) {
  const plan = planCacheWrites({ model: pricing, layers });
  const split = attributeRead(plan.eligible, usage.cache_read);

  let skipped = null;
  if (pricing?.mechanism === "none") skipped = NO_ENTRIES.NO_CACHE_MODEL;
  else if (!plan.ttl_s) skipped = NO_ENTRIES.NO_TTL;
  else if (failed) skipped = NO_ENTRIES.ATTEMPT_FAILED;
  else if (plan.eligible.length === 0) skipped = NO_ENTRIES.NOTHING_ELIGIBLE;

  const writeEvidence = positive(usage.cache_write)
    ? CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE
    : // Silence about a write is precisely what `assumed_write` means: we sent the bytes
      // to a provider with a verified cache mechanism, so the window plausibly exists.
      CACHE_EVIDENCE.ASSUMED_WRITE;

  const planned = skipped
    ? []
    : [
        ...split.read.map((c) => ({ ...c, evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ })),
        ...split.unread.map((c) => ({ ...c, evidence: writeEvidence })),
      ];

  return { plan, split, planned, skipped };
}

/**
 * Record one provider result against one M1 turn.
 *
 * @param {object} args
 * @param {object} args.store output of `openContinuityStore`
 * @param {{now: () => number}} args.clock the injected Clock port
 * @param {object} args.registry a pricing registry (`get`, `statusOf`, `labelsFor`)
 * @param {object} args.observation the content-free record `observeTurn()` returned:
 *        `{session_id, turn_idx, layers, invalidated}`
 * @param {object} args.result adapter-normalized provider result:
 *        `{provider, pricing_key, model, reported_model, status, http_status,
 *          usage: {input, output, cache_read, cache_write}, at, attempt_id,
 *          error_class, retry_after_s, ttfb_ms, total_ms}` — the last four describe how
 *        the attempt ended and are optional; each is stored only when observed
 * @param {object} [args.policy]
 * @returns {object} a content-free record
 */
export function observeCacheResult({ store, clock, registry, observation, result, policy = DEFAULT_CACHE_POLICY } = {}) {
  if (!store?.db) throw new Error("[continuity][cache] observeCacheResult requires an open store");
  if (!registry || typeof registry.get !== "function") {
    throw new Error("[continuity][cache] observeCacheResult requires a pricing registry (I4)");
  }
  const sessionId = typeof observation?.session_id === "string" ? observation.session_id : null;
  const turnIdx = int(observation?.turn_idx);
  if (!sessionId || turnIdx === null) {
    // Not an error: a turn the M1 observer declined to record (sessions off, fail-open)
    // has nothing for a result to attach to, and inventing a session here would create
    // continuity state out of a response.
    return Object.freeze({ observed: false, reason: "no_observed_turn" });
  }

  const { db, cache, turnResults } = store;
  const at = int(result?.at) ?? clock.now();
  const usage = result?.usage ?? {};
  const provider = typeof result?.provider === "string" ? result.provider : null;
  // The pricing key is the *vendor* the adapter mapped this alias to. When the adapter
  // could not map it, `registry.get` resolves the `default` record — `mechanism: none` —
  // which is the §9.3 "no file" path, never a neighbouring vendor's ratios.
  const pricingKey = typeof result?.pricing_key === "string" && result.pricing_key ? result.pricing_key : provider;
  const model = typeof result?.model === "string" ? result.model : null;
  const pricing = registry.get(pricingKey);
  const { status } = registry.statusOf(pricingKey);
  const labels = [...registry.labelsFor(pricingKey)];

  const failed = (result?.status ?? RESULT_STATUS.OK) !== RESULT_STATUS.OK;
  const { confidence, evidence, reported } = classifyCacheResult({ usage, mechanism: pricing.mechanism, failed });

  const { plan, split, planned, skipped } = planEvidenceEntries({ pricing, layers: observation.layers, usage, failed });
  if (status === PRICING_STATUS.STALE && !labels.includes(PRICING_LABELS.STALE)) labels.push(PRICING_LABELS.STALE);

  return db.transaction(() => {
    const seq = turnResults.insertTurnResultAtNextSeq(db, {
      session_id: sessionId,
      turn_idx: turnIdx,
      at,
      provider,
      model,
      reported_model: typeof result?.reported_model === "string" ? result.reported_model : null,
      status: result?.status ?? RESULT_STATUS.OK,
      http_status: int(result?.http_status),
      usage_in: int(usage.input),
      usage_out: int(usage.output),
      usage_cache_read: int(usage.cache_read),
      usage_cache_write: int(usage.cache_write),
      usage_provenance: usageProvenance(usage),
      cache_confidence: confidence,
      mechanism: pricing.mechanism,
      pricing_key: pricingKey,
      pricing_version: pricing.version ?? null,
      labels: joinList(labels),
      attempt_id: typeof result?.attempt_id === "string" ? result.attempt_id : null,
      // How the attempt ended, as the adapter observed it. All four are null unless they
      // were actually available: a refused connection has no HTTP status, a timeout with no
      // first byte has no TTFB, and a 500 that named no retry window asked for none. Null
      // is "not known" and never 0 (I4). No provider message is stored, here or anywhere
      // (§14) — `error_class` is the taxonomy, not the prose.
      error_class: typeof result?.error_class === "string" && result.error_class ? result.error_class : null,
      retry_after_s: int(result?.retry_after_s),
      ttfb_ms: int(result?.ttfb_ms),
      total_ms: int(result?.total_ms),
    });

    const written = [];
    for (const candidate of planned) {
      const previous = cache.getCacheEntry(db, {
        provider: pricingKey,
        model,
        prefix_hash: candidate.hash,
        layer: candidate.layer,
      });
      const entry = applyEvidence(previous, {
        provider: pricingKey,
        model,
        prefix_hash: candidate.hash,
        layer: candidate.layer,
        tokens: candidate.tokens,
        at,
        ttl_s: candidate.ttl_s,
        mechanism: pricing.mechanism,
        evidence: candidate.evidence,
        tokens_provenance: candidate.tokens_provenance,
        pricing_version: pricing.version ?? null,
      });
      cache.upsertCacheEntry(db, entry);
      written.push(
        Object.freeze({
          layer: entry.layer,
          confidence: entry.confidence,
          evidence: entry.evidence,
          tokens: entry.tokens,
          tokens_provenance: entry.tokens_provenance,
          ttl_s: entry.ttl_s,
        }),
      );
    }

    return Object.freeze({
      observed: true,
      session_id: sessionId,
      turn_idx: turnIdx,
      seq,
      at,
      provider,
      pricing_key: pricingKey,
      model,
      mechanism: pricing.mechanism,
      pricing_status: status,
      pricing_version: pricing.version ?? null,
      confidence,
      evidence,
      failed,
      error_class: typeof result?.error_class === "string" && result.error_class ? result.error_class : null,
      provider_reported: reported,
      attributed_read_tokens: split.attributed_tokens,
      entries: Object.freeze(written),
      skipped,
      labels: Object.freeze(labels),
    });
  });
}

export default observeCacheResult;
