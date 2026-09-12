/**
 * M2 group A — the CacheLedger, cache entries, and the estimator that feeds them.
 *
 * The question M2 exists to answer is "what do we currently believe about this route's
 * cache, and how strong is the evidence?", so these tests are written against the two
 * ways that answer can be wrong: claiming warmth that was never earned (I3/I4), and
 * reporting cold material that a provider would in fact read back. Both failure modes
 * are asserted directly rather than through a mocked ledger.
 *
 * Everything here is pure — entries in, belief out — so no store is opened.
 */

import { describe, it, expect } from "vitest";

import {
  CACHE_CONFIDENCE,
  CACHE_EVIDENCE,
  assertConfidenceEvidence,
  cacheStrength,
  degradeCacheConfidence,
  isColdOrUnusable,
  raiseWithEvidence,
} from "../../continuity/cache/confidence.js";
import {
  CacheEntryError,
  applyEvidence,
  cacheEntryKey,
  createCacheEntry,
  deleteAfter,
  entryState,
  expiresAt,
} from "../../continuity/cache/entry.js";
import { INELIGIBLE, planCacheWrites } from "../../continuity/cache/estimator.js";
import { COLD_REASON, createCacheLedger, describeCacheBelief, indexEntries } from "../../continuity/cache/ledger.js";
import { attributeRead, classifyCacheResult, planEvidenceEntries, NO_ENTRIES } from "../../continuity/cache/observer.js";
import { createCachePolicy, DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";
import { loadCacheModels, createMemorySource } from "../../continuity/cache/pricing/index.js";
import { TOKEN_PROVENANCE } from "../../continuity/prefix/tokens.js";

const NOW = 1_700_000_000_000;

/** A verified explicit-breakpoint record, fresh as of NOW. */
const EXPLICIT_YAML = [
  "provider: vendor",
  "mechanism: explicit",
  "breakpoints: 4",
  "min_cacheable_tokens: 1024",
  "ttl_default_s: 300",
  "write_multiplier_default: 1.25",
  "read_multiplier: 0.1",
  "reports_cache_read: true",
  "reports_cache_write: true",
  "verification_method: documentation",
  "verified_at: 2023-11-10",
  "verified_by: test fixture",
  "source: https://example.invalid/docs",
  "version: 1",
].join("\n");

/** The invariant `default` entry, so these tests never exercise the synthesis path. */
const DEFAULT_YAML = ["provider: default", "mechanism: none", "version: 1"].join("\n");

function registryWith(yaml = {}) {
  const source = createMemorySource({ default: DEFAULT_YAML, vendor: EXPLICIT_YAML, ...yaml });
  return loadCacheModels({ source, now: NOW, policy: DEFAULT_CACHE_POLICY });
}

/** An M1-shaped layer summary. Field names are M1's, not a second representation. */
function layerSummary({ tools = 200, system = 900, messages = 4000, salt = "a" } = {}) {
  const out = {};
  const set = (layer, tokens) => {
    if (tokens === null) {
      out[`${layer}_hash`] = null;
      out[`${layer}_tokens`] = 0;
      out[`${layer}_tokens_provenance`] = TOKEN_PROVENANCE.UNAVAILABLE;
      return;
    }
    out[`${layer}_hash`] = `h-${layer}-${salt}-${tokens}`;
    out[`${layer}_tokens`] = tokens;
    out[`${layer}_tokens_provenance`] = TOKEN_PROVENANCE.ESTIMATED;
  };
  set("tools", tools);
  set("system", system);
  set("messages", messages);
  return out;
}

function entry(overrides = {}) {
  return createCacheEntry({
    provider: "vendor",
    model: "m1",
    prefix_hash: "h-tools-a-200",
    layer: "tools",
    tokens: 200,
    written_at: NOW,
    ttl_s: 300,
    confidence: CACHE_CONFIDENCE.ASSUMED,
    evidence: CACHE_EVIDENCE.ASSUMED_WRITE,
    tokens_provenance: TOKEN_PROVENANCE.ESTIMATED,
    mechanism: "explicit",
    ...overrides,
  });
}

/** Entries covering the whole prefix of `layerSummary()`, all assumed. */
function warmSet(summary, { confidence = CACHE_CONFIDENCE.ASSUMED, evidence = CACHE_EVIDENCE.ASSUMED_WRITE, at = NOW } = {}) {
  return ["tools", "system", "messages"].map((layer) =>
    entry({
      layer,
      prefix_hash: summary[`${layer}_hash`],
      tokens: summary[`${layer}_tokens`],
      confidence,
      evidence,
      written_at: at,
    }),
  );
}

describe("A — cache confidence is a vocabulary, not a scale", () => {
  it("reaches confirmed only through provider evidence", () => {
    expect(raiseWithEvidence(CACHE_CONFIDENCE.UNKNOWN, CACHE_EVIDENCE.PROVIDER_REPORTED_READ)).toBe(
      CACHE_CONFIDENCE.CONFIRMED,
    );
    expect(raiseWithEvidence(CACHE_CONFIDENCE.UNKNOWN, CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE)).toBe(
      CACHE_CONFIDENCE.CONFIRMED,
    );
    // Everything a provider did not say tops out at assumed, however many times it happens.
    for (const ev of [CACHE_EVIDENCE.ASSUMED_WRITE, CACHE_EVIDENCE.PROVIDER_SILENT]) {
      expect(raiseWithEvidence(CACHE_CONFIDENCE.UNKNOWN, ev)).toBe(CACHE_CONFIDENCE.ASSUMED);
      expect(raiseWithEvidence(CACHE_CONFIDENCE.ASSUMED, ev)).toBe(CACHE_CONFIDENCE.ASSUMED);
    }
    expect(raiseWithEvidence(CACHE_CONFIDENCE.ASSUMED, CACHE_EVIDENCE.NO_CACHE_MODEL)).toBe(CACHE_CONFIDENCE.UNKNOWN);
    expect(raiseWithEvidence(CACHE_CONFIDENCE.CONFIRMED, CACHE_EVIDENCE.TTL_ELAPSED)).toBe(CACHE_CONFIDENCE.EXPIRED);
  });

  it("does not demote a confirmed belief because a later response was silent", () => {
    // The provider did report a read once. That happened, and a later silence is not a
    // retraction — it is the absence of a new report.
    expect(raiseWithEvidence(CACHE_CONFIDENCE.CONFIRMED, CACHE_EVIDENCE.PROVIDER_SILENT)).toBe(
      CACHE_CONFIDENCE.CONFIRMED,
    );
  });

  it("refuses to construct a confirmed row without provider evidence (I3)", () => {
    expect(() => assertConfidenceEvidence(CACHE_CONFIDENCE.CONFIRMED, CACHE_EVIDENCE.ASSUMED_WRITE)).toThrow(/I3/);
    expect(() => entry({ confidence: CACHE_CONFIDENCE.CONFIRMED, evidence: CACHE_EVIDENCE.ASSUMED_WRITE })).toThrow(/I3/);
    expect(() => entry({ confidence: CACHE_CONFIDENCE.CONFIRMED, evidence: CACHE_EVIDENCE.PROVIDER_SILENT })).toThrow(/I3/);
    // And the legal case still builds.
    expect(
      entry({ confidence: CACHE_CONFIDENCE.CONFIRMED, evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ }).confidence,
    ).toBe(CACHE_CONFIDENCE.CONFIRMED);
  });

  it("treats unknown as no basis rather than as cold", () => {
    // Both are unusable, but they are unusable for different reasons and the ledger
    // reports them differently; `cacheStrength` is what keeps `unknown` off the bottom
    // of an ordering that could otherwise be read as "slightly worse than expired".
    expect(isColdOrUnusable(CACHE_CONFIDENCE.UNKNOWN)).toBe(true);
    expect(isColdOrUnusable(CACHE_CONFIDENCE.EXPIRED)).toBe(true);
    expect(isColdOrUnusable(CACHE_CONFIDENCE.ASSUMED)).toBe(false);
    expect(cacheStrength(CACHE_CONFIDENCE.UNKNOWN)).toBeLessThan(cacheStrength(CACHE_CONFIDENCE.EXPIRED));
    expect(degradeCacheConfidence(CACHE_CONFIDENCE.CONFIRMED)).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(degradeCacheConfidence(CACHE_CONFIDENCE.ASSUMED)).toBe(CACHE_CONFIDENCE.UNKNOWN);
    expect(degradeCacheConfidence(CACHE_CONFIDENCE.EXPIRED)).toBe(CACHE_CONFIDENCE.EXPIRED);
  });
});

describe("A — cache entry lifecycle", () => {
  it("rejects an entry that cannot say what it covers", () => {
    expect(() => createCacheEntry({})).toThrow(CacheEntryError);
    expect(() => entry({ tokens: "many" })).toThrow(/tokens/);
    expect(() => entry({ tokens: -1 })).toThrow(/tokens/);
    expect(() => entry({ layer: "prompt" })).toThrow(/layer/);
    expect(() => entry({ prefix_hash: "  " })).toThrow(/prefix_hash/);
    expect(() => entry({ ttl_s: "forever" })).toThrow(/ttl_s/);
    expect(() => entry({ written_at: "yesterday" })).toThrow(/written_at/);
  });

  it("keys on route plus content, never on session", () => {
    const k = cacheEntryKey({ provider: "vendor", model: "m1", prefix_hash: "h", layer: "tools" });
    expect(k).toBe(cacheEntryKey({ provider: "vendor", model: "m1", prefix_hash: "h", layer: "tools" }));
    expect(k).not.toBe(cacheEntryKey({ provider: "vendor", model: "m2", prefix_hash: "h", layer: "tools" }));
    // Nothing session-shaped is in the key, which is what stops two sessions sending the
    // same tools block to the same model from being counted as two upstream writes.
    expect(Object.keys(entry())).not.toContain("session_id");
  });

  it("computes expiry rather than storing it", () => {
    const e = entry({ written_at: NOW, ttl_s: 300 });
    expect(Object.keys(e)).not.toContain("expired");
    expect(expiresAt(e)).toBe(NOW + 300_000);
    expect(deleteAfter(e)).toBe(NOW + 300_000 + DEFAULT_CACHE_POLICY.expiryGraceMs);
    expect(entryState(e, NOW).expired).toBe(false);
    expect(entryState(e, NOW + 299_999).expired).toBe(false);
    expect(entryState(e, NOW + 300_000).expired).toBe(true);
    expect(entryState(e, NOW + 300_000).confidence).toBe(CACHE_CONFIDENCE.EXPIRED);
    // The stored value is a record of evidence; only the effective value moves.
    expect(entryState(e, NOW + 300_000).stored_confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
  });

  it("degrades one step past half the TTL, and only when the policy says so", () => {
    const e = entry({ confidence: CACHE_CONFIDENCE.CONFIRMED, evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ });
    const mid = NOW + 200_000; // past half of 300 s
    expect(entryState(e, mid).half_life_passed).toBe(true);
    expect(entryState(e, mid).confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(entryState(e, mid, createCachePolicy({ halfLifeDegrade: false })).confidence).toBe(
      CACHE_CONFIDENCE.CONFIRMED,
    );
  });

  it("treats ttl_s = 0 as born expired", () => {
    // Which is why the observer refuses to write such a row at all: it would look like
    // data and mean nothing.
    expect(entryState(entry({ ttl_s: 0 }), NOW).expired).toBe(true);
  });

  it("replaces token counts and accumulates event counters", () => {
    const first = applyEvidence(null, {
      provider: "vendor",
      model: "m1",
      prefix_hash: "h",
      layer: "system",
      tokens: 900,
      at: NOW,
      ttl_s: 300,
      evidence: CACHE_EVIDENCE.ASSUMED_WRITE,
      tokens_provenance: TOKEN_PROVENANCE.ESTIMATED,
    });
    expect(first.confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(first.reads_observed).toBe(0);

    const second = applyEvidence(first, {
      tokens: 950,
      at: NOW + 60_000,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
    });
    // 950, not 1850: the same layer described twice is the same material.
    expect(second.tokens).toBe(950);
    expect(second.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
    expect(second.reads_observed).toBe(1);
    expect(second.confirmed_at).toBe(NOW + 60_000);
    // A reported read means the provider just told us the material is live, so the
    // window restarts from the report.
    expect(second.written_at).toBe(NOW + 60_000);

    const third = applyEvidence(second, { at: NOW + 120_000, evidence: CACHE_EVIDENCE.NO_CACHE_MODEL });
    expect(third.confidence).toBe(CACHE_CONFIDENCE.UNKNOWN);
    // A no-cache-model observation may not extend a window it does not support.
    expect(third.written_at).toBe(NOW + 60_000);
  });

  it("counts only provider-reported writes in writes_observed", () => {
    const assumed = applyEvidence(null, {
      provider: "vendor", model: "m1", prefix_hash: "h", layer: "tools",
      tokens: 200, at: NOW, ttl_s: 300, evidence: CACHE_EVIDENCE.ASSUMED_WRITE,
    });
    expect(assumed.writes_observed).toBe(0);
    const reported = applyEvidence(assumed, { at: NOW + 1000, evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE });
    expect(reported.writes_observed).toBe(1);
    expect(reported.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
  });
});

describe("A — the estimator plans a prefix, not a set of blocks", () => {
  const vendor = registryWith().get("vendor");

  it("keeps a small leading layer inside a prefix that clears the minimum", () => {
    // tools is 200 tokens, far below min_cacheable_tokens 1024. It is still cached,
    // because the provider caches the prefix *through* it. The opposite reading makes the
    // two leading layers permanently invisible, which is a wrong answer to M2's question
    // rather than a conservative one.
    const plan = planCacheWrites({ model: vendor, layers: layerSummary({ tools: 200, system: 900, messages: 4000 }) });
    expect(plan.eligible.map((e) => e.layer)).toEqual(["tools", "system", "messages"]);
    expect(plan.eligible.map((e) => e.cumulative_tokens)).toEqual([200, 1100, 5100]);
    expect(plan.cacheable_tokens).toBe(5100);
    expect(plan.ttl_s).toBe(300);
  });

  it("excludes the layers behind the last boundary that clears the minimum", () => {
    // Whole prefix is 300 tokens: nothing is cacheable anywhere.
    const plan = planCacheWrites({ model: vendor, layers: layerSummary({ tools: 100, system: 100, messages: 100 }) });
    expect(plan.eligible).toEqual([]);
    expect(plan.ineligible.every((r) => r.reason === INELIGIBLE.BELOW_MIN_CACHEABLE)).toBe(true);
    expect(plan.cacheable_tokens).toBe(0);
  });

  it("carries token provenance into the plan", () => {
    const plan = planCacheWrites({ model: vendor, layers: layerSummary() });
    // Every count M2 can produce is estimated; a plan that dropped this would let a
    // bytes/4 figure be read later as a measurement.
    expect(new Set(plan.eligible.map((e) => e.tokens_provenance))).toEqual(new Set([TOKEN_PROVENANCE.ESTIMATED]));
  });

  it("produces an empty plan for a provider with no cache model (I4)", () => {
    const none = registryWith().get("unmapped-alias");
    expect(none.mechanism).toBe("none");
    const plan = planCacheWrites({ model: none, layers: layerSummary() });
    // Empty, not zeroed: there is nothing to write and nothing to credit.
    expect(plan.eligible).toEqual([]);
    expect(plan.ttl_s).toBe(null);
    expect(plan.cacheable_tokens).toBe(0);
    expect(new Set(plan.ineligible.map((r) => r.reason))).toEqual(new Set([INELIGIBLE.NO_CACHE_MODEL]));
  });

  it("spends the breakpoints it has on the earliest boundaries", () => {
    const oneBreak = { ...vendor, breakpoints: 1 };
    const plan = planCacheWrites({ model: oneBreak, layers: layerSummary() });
    expect(plan.eligible.map((e) => e.layer)).toEqual(["tools"]);
    expect(plan.ineligible.filter((r) => r.reason === INELIGIBLE.NO_BREAKPOINTS_LEFT).map((r) => r.layer)).toEqual([
      "system",
      "messages",
    ]);
  });

  it("skips a layer that has no hash or no tokens", () => {
    const plan = planCacheWrites({ model: vendor, layers: layerSummary({ tools: null, system: 2000, messages: 3000 }) });
    expect(plan.ineligible.find((r) => r.layer === "tools").reason).toBe(INELIGIBLE.NO_HASH);
    expect(plan.eligible.map((e) => e.layer)).toEqual(["system", "messages"]);
  });
});

describe("A — the warm region is a prefix, and it stops at the first break", () => {
  const registry = registryWith();
  const summary = layerSummary();

  const ledger = (entries, now = NOW) => createCacheLedger({ entries, registry, now });

  it("reports a fully warm route with its confidence and token split", () => {
    const belief = ledger(warmSet(summary)).describeBelief({ provider: "vendor", model: "m1", layers: summary });
    expect(belief.warm_prefix).toEqual(["tools", "system", "messages"]);
    expect(belief.confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(belief.assumed_tokens).toBe(5100);
    expect(belief.confirmed_tokens).toBe(0);
    expect(belief.warm_tokens).toBe(5100);
    // The merged total is an estimate the moment any layer is assumed, and saying so is
    // what stops a later caller summing the two into something it calls a measurement.
    expect(belief.warm_tokens_provenance).toBe("estimated");
    expect(belief.economics_available).toBe(true);
  });

  it("reports confirmed provenance only when every warm layer was provider-reported", () => {
    const all = warmSet(summary, {
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
    });
    const belief = ledger(all).describeBelief({ provider: "vendor", model: "m1", layers: summary });
    expect(belief.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
    expect(belief.confirmed_tokens).toBe(5100);
    expect(belief.warm_tokens_provenance).toBe("confirmed");

    // One assumed layer anywhere in the prefix downgrades the aggregate: a prefix is only
    // as trustworthy as its least-evidenced layer.
    const mixed = [...all.slice(0, 2), warmSet(summary)[2]];
    const mixedBelief = ledger(mixed).describeBelief({ provider: "vendor", model: "m1", layers: summary });
    expect(mixedBelief.confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(mixedBelief.warm_tokens_provenance).toBe("estimated");
    expect(mixedBelief.confirmed_tokens).toBe(1100);
    expect(mixedBelief.assumed_tokens).toBe(4000);
  });

  it("stops at the first cold layer and says why each later one is cold", () => {
    // system has no entry, so messages cannot be in the provider's window either, even
    // though its own row is present and fresh.
    const partial = warmSet(summary).filter((e) => e.layer !== "system");
    const belief = ledger(partial).describeBelief({ provider: "vendor", model: "m1", layers: summary });
    expect(belief.warm_prefix).toEqual(["tools"]);
    expect(belief.warm_tokens).toBe(200);
    const byLayer = Object.fromEntries(belief.layers.map((l) => [l.layer, l]));
    expect(byLayer.system.reason).toBe(COLD_REASON.NO_ENTRY);
    expect(byLayer.messages.reason).toBe(COLD_REASON.BEHIND_COLD_LAYER);
    expect(byLayer.messages.tokens).toBe(0);
  });

  it("reports an expired window as expired, not as absent", () => {
    const belief = ledger(warmSet(summary), NOW + 400_000).describeBelief({
      provider: "vendor",
      model: "m1",
      layers: summary,
    });
    expect(belief.warm_prefix).toEqual([]);
    expect(belief.confidence).toBe(CACHE_CONFIDENCE.EXPIRED);
    expect(belief.layers.map((l) => l.reason)).toEqual([
      COLD_REASON.EXPIRED,
      COLD_REASON.EXPIRED,
      COLD_REASON.EXPIRED,
    ]);
  });

  it("claims nothing at all for a provider with no cache model (I4)", () => {
    // Entries exist for this hash under the vendor key; the route still yields zero,
    // because the pricing key it resolves has no mechanism.
    const belief = ledger(warmSet(summary)).describeBelief({ provider: "not-a-vendor", model: "m1", layers: summary });
    expect(belief.mechanism).toBe("none");
    expect(belief.warm_prefix).toEqual([]);
    expect(belief.warm_tokens).toBe(0);
    expect(belief.confidence).toBe(CACHE_CONFIDENCE.UNKNOWN);
    expect(belief.warm_tokens_provenance).toBe("unavailable");
    expect(belief.economics_available).toBe(false);
    expect(new Set(belief.layers.map((l) => l.reason))).toEqual(new Set([COLD_REASON.NO_CACHE_MODEL]));
  });

  it("requires a pricing registry rather than defaulting to one", () => {
    // A ledger that invented its own cache model is exactly the I4 hole.
    expect(() => createCacheLedger({ entries: [], registry: null })).toThrow(/I4/);
  });

  it("validates rows as it indexes them, so a bad row fails at read time", () => {
    expect(() => indexEntries([{ provider: "vendor", model: "m1", prefix_hash: "h", layer: "tools" }])).toThrow(
      /tokens/,
    );
    expect(indexEntries([null, undefined]).size).toBe(0);
  });

  it("answers for one route without holding a ledger", () => {
    const belief = describeCacheBelief({
      entries: warmSet(summary),
      registry,
      now: NOW,
      provider: "vendor",
      model: "m1",
      layers: summary,
    });
    expect(belief.warm_prefix).toEqual(["tools", "system", "messages"]);
  });
});

describe("A — invalidation is read-side (§9.1)", () => {
  const registry = registryWith();
  const summary = layerSummary();

  it("masks the invalidated layer and everything behind it", () => {
    const l = createCacheLedger({ entries: warmSet(summary), registry, now: NOW });
    const belief = l.describeBelief({ provider: "vendor", model: "m1", layers: summary, invalidated: ["system"] });
    expect(belief.warm_prefix).toEqual(["tools"]);
    const byLayer = Object.fromEntries(belief.layers.map((x) => [x.layer, x]));
    expect(byLayer.system.reason).toBe(COLD_REASON.INVALIDATED);
    expect(byLayer.messages.reason).toBe(COLD_REASON.BEHIND_COLD_LAYER);
  });

  it("leaves the stored rows alone, so a later turn can return to the old prefix", () => {
    const entries = warmSet(summary);
    const l = createCacheLedger({ entries, registry, now: NOW });
    const unmasked = l.describeBelief({ provider: "vendor", model: "m1", layers: summary });
    const masked = l.applyInvalidation(unmasked, ["tools"]);
    expect(masked.warm_prefix).toEqual([]);
    // Same ledger, same rows: the mask was this turn's, not a deletion.
    expect(l.size).toBe(3);
    expect(l.describeBelief({ provider: "vendor", model: "m1", layers: summary }).warm_prefix).toEqual([
      "tools",
      "system",
      "messages",
    ]);
  });

  it("keeps the unmasked belief inspectable alongside the masked one", () => {
    // "Why did nothing hit?" needs both halves: the row that exists and the invalidation
    // that masked it.
    const l = createCacheLedger({ entries: warmSet(summary), registry, now: NOW });
    const unmasked = l.describeBelief({ provider: "vendor", model: "m1", layers: summary });
    expect(unmasked.warm_tokens).toBe(5100);
    expect(l.applyInvalidation(unmasked, ["tools"]).warm_tokens).toBe(0);
    expect(unmasked.warm_tokens).toBe(5100);
  });
});

describe("A — a partly warm layer (ledger rule 4)", () => {
  const registry = registryWith();
  // Turn N: messages was 2000 tokens. Turn N+1: the client appended, so the hash changed
  // but the opening bytes are unchanged and still live upstream.
  const before = layerSummary({ messages: 2000, salt: "a" });
  const after = { ...before, messages_hash: "h-messages-a-3200", messages_tokens: 3200 };

  const carried = { messages: before.messages_hash };

  it("believes the stored earlier prefix and marks the layer partial", () => {
    const l = createCacheLedger({ entries: warmSet(before), registry, now: NOW });
    const belief = l.describeBelief({ provider: "vendor", model: "m1", layers: after, carried });
    expect(belief.warm_prefix).toEqual(["tools", "system", "messages"]);
    expect(belief.partial_layers).toEqual(["messages"]);
    // 2000, the count the *stored entry* recorded — never the 3200 the caller now sends.
    // That is what keeps a partial hit an observation rather than an arithmetic guess.
    expect(belief.warm_tokens).toBe(200 + 900 + 2000);
    const messages = belief.layers.find((x) => x.layer === "messages");
    expect(messages.carried_hash).toBe(before.messages_hash);
    expect(messages.hash).toBe(after.messages_hash);
  });

  it("survives the invalidation that a grown layer always carries", () => {
    // A grown `messages` layer is invalidated by definition. If invalidation masked
    // partial hits, rule 4 would be unreachable and every growing conversation would be
    // reported cold from its second turn onward.
    const l = createCacheLedger({ entries: warmSet(before), registry, now: NOW });
    const belief = l.describeBelief({
      provider: "vendor",
      model: "m1",
      layers: after,
      invalidated: ["messages"],
      carried,
    });
    expect(belief.warm_prefix).toEqual(["tools", "system", "messages"]);
    expect(belief.partial_layers).toEqual(["messages"]);
  });

  it("still masks an exact hit that this turn invalidated", () => {
    const l = createCacheLedger({ entries: warmSet(before), registry, now: NOW });
    const belief = l.describeBelief({
      provider: "vendor",
      model: "m1",
      layers: before,
      invalidated: ["messages"],
      carried,
    });
    expect(belief.partial_layers).toEqual([]);
    expect(belief.layers.find((x) => x.layer === "messages").reason).toBe(COLD_REASON.INVALIDATED);
  });

  it("breaks the prefix behind itself", () => {
    // The provider's window ends inside a partial layer, so nothing behind it can be in
    // that window either. `system` carried, `messages` exact: messages must go cold.
    const shifted = { ...before, system_hash: "h-system-a-1500", system_tokens: 1500 };
    const l = createCacheLedger({ entries: warmSet(before), registry, now: NOW });
    const belief = l.describeBelief({
      provider: "vendor",
      model: "m1",
      layers: shifted,
      carried: { system: before.system_hash },
    });
    expect(belief.warm_prefix).toEqual(["tools", "system"]);
    expect(belief.partial_layers).toEqual(["system"]);
    expect(belief.layers.find((x) => x.layer === "messages").reason).toBe(COLD_REASON.BEHIND_COLD_LAYER);
  });

  it("reports carried_gone when the earlier prefix has been swept away", () => {
    const l = createCacheLedger({ entries: warmSet(before).filter((e) => e.layer !== "messages"), registry, now: NOW });
    const belief = l.describeBelief({ provider: "vendor", model: "m1", layers: after, carried });
    const messages = belief.layers.find((x) => x.layer === "messages");
    expect(messages.warm).toBe(false);
    // Distinct from NO_ENTRY: a caller that asked about a carried prefix and got nothing
    // learns that the fallback was tried and failed, not that it was never attempted.
    expect(messages.reason).toBe(COLD_REASON.CARRIED_GONE);
    expect(messages.carried_hash).toBe(before.messages_hash);
  });

  it("never invents a token count from what the caller passed", () => {
    // The caller supplies a hash, never a number. An entry recording 2000 tokens is
    // worth 2000 even if the caller believes the carried region is larger.
    const l = createCacheLedger({
      entries: [...warmSet(before).slice(0, 2), entry({ layer: "messages", prefix_hash: before.messages_hash, tokens: 2000 })],
      registry,
      now: NOW,
    });
    const belief = l.describeBelief({ provider: "vendor", model: "m1", layers: { ...after, messages_tokens: 99999 }, carried });
    expect(belief.warm_tokens).toBe(3100);
  });

  it("carries the fallback through applyInvalidation", () => {
    const l = createCacheLedger({ entries: warmSet(before), registry, now: NOW });
    const belief = l.describeBelief({ provider: "vendor", model: "m1", layers: after, carried });
    const masked = l.applyInvalidation(belief, ["tools"]);
    expect(masked.warm_prefix).toEqual([]);
    const messages = masked.layers.find((x) => x.layer === "messages");
    expect(messages.reason).toBe(COLD_REASON.BEHIND_COLD_LAYER);
    // The re-run still knew about the carried hash rather than losing it in the round trip.
    const reMasked = l.applyInvalidation(belief, []);
    expect(reMasked.partial_layers).toEqual(["messages"]);
  });
});

describe("A — classifying one provider result (§9's triad plus the write case)", () => {
  it("calls a positive reported read or write confirmed", () => {
    expect(classifyCacheResult({ usage: { cache_read: 900 }, mechanism: "explicit" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
      reported: true,
    });
    expect(classifyCacheResult({ usage: { cache_write: 900 }, mechanism: "implicit" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE,
    });
  });

  it("distinguishes a reported zero from silence", () => {
    // Both are assumed, and they are assumed for different reasons: one provider said
    // "no read happened", the other said nothing at all. The evidence value is what keeps
    // the two separable in the database afterwards.
    expect(classifyCacheResult({ usage: { cache_read: 0, cache_write: 0 }, mechanism: "explicit" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.ASSUMED,
      evidence: CACHE_EVIDENCE.ASSUMED_WRITE,
      reported: true,
    });
    expect(classifyCacheResult({ usage: { input: 10 }, mechanism: "explicit" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.ASSUMED,
      evidence: CACHE_EVIDENCE.PROVIDER_SILENT,
      reported: false,
    });
  });

  it("returns unknown for a provider with no cache model, however loud its usage", () => {
    // Note the read is reported: `reported` stays true, so the coverage measure can still
    // see that this provider talks about its cache. It just may not be priced (I4).
    expect(classifyCacheResult({ usage: { cache_read: 5000 }, mechanism: "none" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.CONFIRMED,
    });
    expect(classifyCacheResult({ usage: { input: 10 }, mechanism: "none" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.UNKNOWN,
      evidence: CACHE_EVIDENCE.NO_CACHE_MODEL,
    });
  });
});

describe("A — attributing a reported read across layers", () => {
  const candidates = [
    { layer: "tools", cumulative_tokens: 200 },
    { layer: "system", cumulative_tokens: 1100 },
    { layer: "messages", cumulative_tokens: 5100 },
  ];

  it("credits only whole layers that fit inside the reported number", () => {
    expect(attributeRead(candidates, 1100).read.map((c) => c.layer)).toEqual(["tools", "system"]);
    expect(attributeRead(candidates, 1100).attributed_tokens).toBe(1100);
    expect(attributeRead(candidates, 5100).read.map((c) => c.layer)).toEqual(["tools", "system", "messages"]);
  });

  it("drops a layer that straddles the boundary rather than claiming it", () => {
    // 1099 reported: system's cumulative 1100 does not fit. Our per-layer counts are
    // estimates, so an off-by-a-little estimate must lose the layer. Under-attribution
    // costs a `confirmed` label; over-attribution would put an unearned one in the
    // database, which is what I3 exists to prevent.
    const split = attributeRead(candidates, 1099);
    expect(split.read.map((c) => c.layer)).toEqual(["tools"]);
    expect(split.unread.map((c) => c.layer)).toEqual(["system", "messages"]);
    expect(split.attributed_tokens).toBe(200);
  });

  it("treats no read and a zero read as nothing attributed", () => {
    for (const v of [null, undefined, 0]) {
      const split = attributeRead(candidates, v);
      expect(split.read).toEqual([]);
      expect(split.unread).toHaveLength(3);
      expect(split.attributed_tokens).toBe(0);
    }
  });

  it("never re-orders: a gap stops the run", () => {
    // Once a layer misses, no later layer may be credited, because a cache read is a
    // prefix and a later match would imply the provider skipped material.
    const split = attributeRead(candidates, 300);
    expect(split.read.map((c) => c.layer)).toEqual(["tools"]);
    expect(split.unread.map((c) => c.layer)).toEqual(["system", "messages"]);
  });
});

describe("A — planEvidenceEntries is the one rule the live path and replay share", () => {
  const registry = registryWith();
  const summary = layerSummary();

  it("splits the plan into read-confirmed and write layers", () => {
    const { planned, split, skipped } = planEvidenceEntries({
      pricing: registry.get("vendor"),
      layers: summary,
      usage: { cache_read: 1100, cache_write: 4000 },
    });
    expect(skipped).toBe(null);
    expect(split.read.map((c) => c.layer)).toEqual(["tools", "system"]);
    expect(planned.map((p) => [p.layer, p.evidence])).toEqual([
      ["tools", CACHE_EVIDENCE.PROVIDER_REPORTED_READ],
      ["system", CACHE_EVIDENCE.PROVIDER_REPORTED_READ],
      ["messages", CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE],
    ]);
  });

  it("marks the unread remainder assumed when the provider said nothing about writes", () => {
    const { planned } = planEvidenceEntries({ pricing: registry.get("vendor"), layers: summary, usage: {} });
    expect(new Set(planned.map((p) => p.evidence))).toEqual(new Set([CACHE_EVIDENCE.ASSUMED_WRITE]));
  });

  it("plans nothing, with a reason, for every case where a row would be meaningless", () => {
    const cases = [
      [{ pricing: registry.get("nope"), layers: summary, usage: {} }, NO_ENTRIES.NO_CACHE_MODEL],
      [{ pricing: { ...registry.get("vendor"), ttl_default_s: 0 }, layers: summary, usage: {} }, NO_ENTRIES.NO_TTL],
      [{ pricing: registry.get("vendor"), layers: summary, usage: {}, failed: true }, NO_ENTRIES.ATTEMPT_FAILED],
      [
        { pricing: registry.get("vendor"), layers: layerSummary({ tools: 10, system: 10, messages: 10 }), usage: {} },
        NO_ENTRIES.NOTHING_ELIGIBLE,
      ],
    ];
    for (const [args, reason] of cases) {
      const out = planEvidenceEntries(args);
      expect(out.planned).toEqual([]);
      expect(out.skipped).toBe(reason);
    }
  });

  it("plans nothing for a failed attempt even when the provider reported a read", () => {
    // A failed attempt may still carry usage, but we do not know what reached the
    // provider's cache, so nothing is believed. The row in `turn_results` still records
    // what was reported.
    const out = planEvidenceEntries({
      pricing: registry.get("vendor"),
      layers: summary,
      usage: { cache_read: 1100 },
      failed: true,
    });
    expect(out.planned).toEqual([]);
    expect(out.skipped).toBe(NO_ENTRIES.ATTEMPT_FAILED);
  });
});
