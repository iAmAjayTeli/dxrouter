/**
 * The cache entry — one belief about one prefix layer on one route.
 *
 * A row answers: "at `written_at`, this (provider, model) was sent `tokens` tokens of
 * this `layer` whose content hashes to `prefix_hash`; we believe that material is
 * cached for `ttl_s` seconds, and here is how strongly, and why."
 *
 * Three properties this module exists to keep true:
 *
 *  1. The key is the route plus the content, never the session. Section 12 keys
 *     `cache_entries` on `(provider, model, prefix_hash, layer)`. Two sessions sending
 *     the same tools block to the same model are looking at the same upstream cache,
 *     and pretending otherwise would double-count a single write.
 *  2. Expiry is computed, not stored. There is no `expired` column; `expired` is what
 *     `written_at + ttl_s` says at the moment somebody asks. A stored boolean would
 *     need a writer to keep it honest, and the only writer is a request path that may
 *     not run for hours.
 *  3. Evidence travels with the number. Every transition goes through `applyEvidence`,
 *     which is what makes `confirmed` unreachable without a provider having reported
 *     something (I3).
 *
 * Pure and frozen: no clock, no store. Callers pass `now`.
 */

import { PREFIX_LAYERS } from "../prefix/hasher.js";
import { TOKEN_PROVENANCE, intOrNull, isTokenProvenance } from "../prefix/tokens.js";
import {
  CACHE_CONFIDENCE,
  CACHE_EVIDENCE,
  PROVIDER_EVIDENCE,
  assertConfidenceEvidence,
  degradeCacheConfidence,
  isCacheConfidence,
  raiseWithEvidence,
} from "./confidence.js";
import { DEFAULT_CACHE_POLICY } from "./policy.js";

export class CacheEntryError extends Error {
  constructor(field, message) {
    super(`[continuity][cache_entry] ${field}: ${message}`);
    this.name = "CacheEntryError";
    this.code = "CACHE_ENTRY_INVALID";
    this.field = field;
  }
}

/** The layers a cache entry may describe: the M1 prefix layers, not a second list. */
export const CACHE_LAYERS = PREFIX_LAYERS;

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** `null` means "no value", never `0` — see `intOrNull`. */
const int = intOrNull;

/**
 * Stable string key. Used by the ledger to index a batch in memory; the database uses
 * the same four columns as its primary key, so the two cannot drift.
 */
export function cacheEntryKey({ provider, model, prefix_hash, layer } = {}) {
  return [provider ?? "", model ?? "", prefix_hash ?? "", layer ?? ""].join(" ");
}

/**
 * Validate and freeze one entry.
 *
 * `tokens` is required and must be a non-negative integer: an entry that cannot say
 * how much material it covers is not evidence of anything.
 */
export function createCacheEntry(input = {}) {
  const provider = str(input.provider);
  const model = str(input.model);
  const prefix_hash = str(input.prefix_hash);
  const layer = str(input.layer);
  if (!provider) throw new CacheEntryError("provider", "must be a non-empty string");
  if (!model) throw new CacheEntryError("model", "must be a non-empty string");
  if (!prefix_hash) throw new CacheEntryError("prefix_hash", "must be a non-empty string");
  if (!layer || !CACHE_LAYERS.includes(layer)) {
    throw new CacheEntryError("layer", `must be one of ${CACHE_LAYERS.join(", ")}`);
  }

  const tokens = int(input.tokens);
  if (tokens === null || tokens < 0) throw new CacheEntryError("tokens", "must be a non-negative integer");

  const written_at = int(input.written_at);
  if (written_at === null) throw new CacheEntryError("written_at", "must be epoch milliseconds");

  const ttl_s = int(input.ttl_s);
  if (ttl_s === null || ttl_s < 0) throw new CacheEntryError("ttl_s", "must be a non-negative integer");

  const confidence = input.confidence ?? CACHE_CONFIDENCE.UNKNOWN;
  if (!isCacheConfidence(confidence)) throw new CacheEntryError("confidence", `unknown value ${confidence}`);

  const evidence = str(input.evidence) ?? CACHE_EVIDENCE.NO_CACHE_MODEL;
  // The I3 gate, at construction: a `confirmed` row without provider evidence cannot
  // be built at all, so it cannot be persisted either.
  assertConfidenceEvidence(confidence, evidence);

  const tokens_provenance = isTokenProvenance(input.tokens_provenance)
    ? input.tokens_provenance
    : TOKEN_PROVENANCE.ESTIMATED;

  const confirmed_at =
    confidence === CACHE_CONFIDENCE.CONFIRMED ? (int(input.confirmed_at) ?? written_at) : int(input.confirmed_at);

  return Object.freeze({
    provider,
    model,
    prefix_hash,
    layer,
    tokens,
    written_at,
    ttl_s,
    confidence,
    mechanism: str(input.mechanism),
    evidence,
    tokens_provenance,
    pricing_version: str(input.pricing_version),
    updated_at: int(input.updated_at) ?? written_at,
    confirmed_at,
    reads_observed: Math.max(0, int(input.reads_observed) ?? 0),
    writes_observed: Math.max(0, int(input.writes_observed) ?? 0),
  });
}

/** Absolute end of the believed window. `ttl_s === 0` means no window at all. */
export function expiresAt(entry) {
  return entry.written_at + entry.ttl_s * 1000;
}

/** Section 12.3: when the row itself may be deleted, one grace hour after it expires. */
export function deleteAfter(entry, policy = DEFAULT_CACHE_POLICY) {
  return expiresAt(entry) + policy.expiryGraceMs;
}

/**
 * What this entry means now.
 *
 * Returns the effective confidence rather than the stored one, which is the whole
 * point: the stored value is a record of evidence, and the effective value is what a
 * caller may act on. The section 4.2 half-life step is applied here, once, so no
 * caller has to remember it.
 */
export function entryState(entry, now, policy = DEFAULT_CACHE_POLICY) {
  const ends = expiresAt(entry);
  const remaining_ms = ends - now;
  const expired = entry.ttl_s === 0 || remaining_ms <= 0;
  const half_life_passed = !expired && remaining_ms < (entry.ttl_s * 1000) / 2;

  let effective = entry.confidence;
  if (expired) effective = CACHE_CONFIDENCE.EXPIRED;
  else if (half_life_passed && policy.halfLifeDegrade) effective = degradeCacheConfidence(effective);

  return Object.freeze({
    key: cacheEntryKey(entry),
    stored_confidence: entry.confidence,
    confidence: effective,
    expired,
    half_life_passed,
    remaining_ms: Math.max(0, remaining_ms),
    expires_at: ends,
    delete_after: deleteAfter(entry, policy),
    tokens: entry.tokens,
    tokens_provenance: entry.tokens_provenance,
    evidence: entry.evidence,
    mechanism: entry.mechanism,
    pricing_version: entry.pricing_version,
  });
}

/**
 * Fold one observation into an entry, returning a new frozen entry.
 *
 * `previous` may be null (first sighting). Token counts are replaced, not summed: a
 * later observation of the same prefix layer describes the same material, and summing
 * would invent tokens nobody sent. The counters (`reads_observed`, `writes_observed`)
 * are what accumulate, because those are counts of events.
 *
 * A provider-reported read refreshes `written_at`: the provider just told us the
 * material is live, so the window starts again from the report, which is exactly why a
 * silent response must not do the same.
 */
export function applyEvidence(previous, observation = {}) {
  const {
    provider,
    model,
    prefix_hash,
    layer,
    tokens,
    at,
    ttl_s,
    mechanism = null,
    evidence = CACHE_EVIDENCE.ASSUMED_WRITE,
    tokens_provenance,
    pricing_version = null,
  } = observation;

  const base = previous ?? null;
  const isRead = evidence === CACHE_EVIDENCE.PROVIDER_REPORTED_READ;
  const isWrite = evidence === CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE || evidence === CACHE_EVIDENCE.ASSUMED_WRITE;
  const confidence = raiseWithEvidence(base?.confidence ?? CACHE_CONFIDENCE.UNKNOWN, evidence);

  // A read confirms the existing window and restarts it. A write (reported or assumed)
  // starts a window at the moment of the write. Anything else leaves `written_at`
  // alone, so a `no_cache_model` observation cannot extend a belief it does not
  // support.
  const written_at = isRead || isWrite ? (int(at) ?? base?.written_at ?? 0) : (base?.written_at ?? int(at) ?? 0);
  // `confirmed_at` is when a provider *last* reported this prefix, so a second report
  // moves it. Left alone otherwise, which keeps "never confirmed" a null rather than a
  // number that would make silence look like evidence.
  const providerReported = PROVIDER_EVIDENCE.includes(evidence);
  const confirmed_at = providerReported ? (int(at) ?? written_at) : (base?.confirmed_at ?? null);
  // `raiseWithEvidence` deliberately does not demote a row a provider once confirmed. The
  // evidence column has to keep naming the report that earned that, or the row would say
  // `confirmed` next to `assumed_write` — which is both an I3 violation on its face and,
  // because `assertConfidenceEvidence` rejects it, a throw on the most ordinary sequence
  // there is: a reported write followed by a silent turn on the same prefix.
  const trail = confidence === CACHE_CONFIDENCE.CONFIRMED && !providerReported ? (base?.evidence ?? evidence) : evidence;

  return createCacheEntry({
    provider: provider ?? base?.provider,
    model: model ?? base?.model,
    prefix_hash: prefix_hash ?? base?.prefix_hash,
    layer: layer ?? base?.layer,
    tokens: int(tokens) ?? base?.tokens ?? 0,
    written_at,
    ttl_s: int(ttl_s) ?? base?.ttl_s ?? 0,
    confidence,
    mechanism: mechanism ?? base?.mechanism,
    evidence: trail,
    tokens_provenance: tokens_provenance ?? base?.tokens_provenance,
    pricing_version: pricing_version ?? base?.pricing_version,
    updated_at: int(at) ?? base?.updated_at ?? written_at,
    confirmed_at,
    reads_observed: (base?.reads_observed ?? 0) + (isRead ? 1 : 0),
    writes_observed: (base?.writes_observed ?? 0) + (evidence === CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE ? 1 : 0),
  });
}

export default createCacheEntry;
