/**
 * The one replay implementation (§19.4, and §19.3's gate later).
 *
 * Replay takes a fixture — a program describing how a session's message history evolved —
 * and reconstructs, turn by turn, what the engine would have believed about the
 * provider's cache. It makes no network calls, opens no database, and produces no
 * Decision: `decide` is an injection point that stays null in M2, so M3 can add the
 * decision stage here rather than writing a second replayer beside this one.
 *
 * Two properties make the output worth measuring:
 *
 * **It uses the live path's rules, not a copy of them.** Layers come from M1's
 * `computePrefixLayers`, invalidation from M1's `invalidatedLayers`, belief from the M2
 * ledger, and the belief update from `planEvidenceEntries` — the same function
 * `observeCacheResult` calls. A replay with its own arithmetic would measure itself.
 *
 * **Predicted and reported are kept apart.** For each turn the record carries what we
 * would have believed *before* the provider answered (`predicted_read_tokens`, from the
 * warm prefix) and what the fixture says the provider actually reported
 * (`reported_read_tokens`). `arithmetic_accuracy` is the comparison; nothing in here
 * blends the two, because blending them is how a model starts scoring itself.
 *
 * A fixture with no recorded usage is not an error. It yields turns whose reported
 * counts are `null`, which is exactly the input `coverage` needs.
 */

import { computePrefixLayers, prefixLayerSummary } from "../prefix/hasher.js";
import { intOrNull } from "../prefix/tokens.js";
import { classifyMessageSequences, isPrefixContinuation } from "../prefix/extension.js";
import { invalidatedLayers } from "../prefix/invalidation.js";
import { applyEvidence } from "../cache/entry.js";
import { createCacheLedger } from "../cache/ledger.js";
import { classifyCacheResult, planEvidenceEntries, RESULT_STATUS } from "../cache/observer.js";
import { DEFAULT_CACHE_POLICY } from "../cache/policy.js";
import { cacheEntryKey } from "../cache/entry.js";
import { applyTurn, expandMessage, fixtureExpectationBasis, fixtureProjectKind, fixtureSource, prepareFixture } from "./fixtures.js";

/** `null` means "no value", never `0` — see `intOrNull`. */
const int = intOrNull;

/** A fixture turn's recorded provider result, or null when it recorded none. */
export function turnUsage(turn) {
  const u = turn?.usage ?? turn?.result?.usage ?? null;
  if (!u || typeof u !== "object") return null;
  return {
    input: int(u.input ?? u.input_tokens ?? u.prompt_tokens),
    output: int(u.output ?? u.output_tokens ?? u.completion_tokens),
    cache_read: int(u.cache_read ?? u.cache_read_input_tokens),
    cache_write: int(u.cache_write ?? u.cache_creation_input_tokens),
  };
}

/**
 * Replay one fixture.
 *
 * @param {object} args
 * @param {object} args.fixture parsed fixture object
 * @param {object} args.registry pricing registry
 * @param {string} args.pricingKey vendor key the fixture's provider maps to
 * @param {string} [args.provider] the alias, recorded but not priced on
 * @param {string} [args.model] overrides the fixture's own model
 * @param {number} [args.startAt] epoch ms of the first turn
 * @param {number} [args.gapMs] default clock advance between turns
 * @param {Function|null} [args.decide] M3 extension point; never called in M2
 * @param {Function|null} [args.tokenizer] injected tokenizer, for `measured` counts
 */
export function replayFixture({
  fixture,
  registry,
  pricingKey,
  provider = null,
  model = null,
  startAt = 0,
  gapMs = 1000,
  policy = DEFAULT_CACHE_POLICY,
  tokenizer = null,
  decide = null,
} = {}) {
  if (!fixture) throw new Error("[continuity][replay] a fixture is required");
  if (!registry || typeof registry.get !== "function") {
    throw new Error("[continuity][replay] a pricing registry is required (I4)");
  }
  const prepared = prepareFixture(fixture);
  const layerSets = prepared.layer_sets || {};
  const usedModel = model ?? prepared.model ?? "model-under-test";
  const key = pricingKey ?? provider ?? "default";
  const pricing = registry.get(key);

  // The belief store for this replay: the same `(provider, model, prefix_hash, layer)`
  // keying the table uses, in a Map. No database, because a measurement must not depend
  // on the state of the operator's machine.
  const entries = new Map();
  const histories = new Map();
  const turns = [];
  let layerKey = null;
  let previousSummary = null;
  let previousMessages = null;
  let now = startAt;

  for (const turn of prepared.turns) {
    if (turn.layers) layerKey = turn.layers;
    const set = layerSets[layerKey] || {};
    const name = turn.history ?? "main";
    const history = applyTurn(histories.get(name) ?? [], turn);
    histories.set(name, history);

    const messages = history.map(expandMessage);
    const layers = computePrefixLayers(
      { tools: set.tools ?? null, system: set.system ?? null, messages },
      { tokenizer },
    );
    const summary = prefixLayerSummary(layers);
    const { changed, invalidated } = invalidatedLayers(previousSummary, summary);
    const relation = previousMessages ? classifyMessageSequences(previousMessages, layers.messages) : null;

    // The earlier prefix a layer still carries. M1 decides this, not the ledger: a
    // `messages` layer the client extended is a different hash but the same opening
    // bytes, and the provider will read those bytes back. Only the hash travels — the
    // ledger takes the token count from the entry it stored, not from here.
    const carried =
      previousSummary && relation && isPrefixContinuation(relation.relation)
        ? { messages: previousSummary.messages_hash ?? null }
        : null;

    // What we believed *before* the provider answered. This is the prediction the
    // accuracy measure scores, so it is computed from the entry map as it stands now.
    const ledger = createCacheLedger({ entries, registry, now, policy });
    const belief = ledger.describeBelief({ provider: key, model: usedModel, layers: summary, invalidated, carried });

    // M3's seam. Left unwired on purpose: M2 produces no Decision, and a default
    // implementation here would be the decision engine arriving early.
    const decision = typeof decide === "function" ? decide({ belief, layers: summary, turn, now }) : null;

    const usage = turnUsage(turn) ?? {};
    const reported = turnUsage(turn) !== null;
    const failed = (turn.status ?? RESULT_STATUS.OK) !== RESULT_STATUS.OK;
    // `failed` reaches the classifier here for the same reason the live observer passes it:
    // a replayed failure must land `unknown` / `attempt_failed`, not `assumed`. Replaying a
    // fixture under a laxer rule than the live path would measure the replay (§19.4).
    const classification = classifyCacheResult({ usage, mechanism: pricing.mechanism, failed });
    const { planned, skipped, split, plan } = planEvidenceEntries({ pricing, layers: summary, usage, failed });

    for (const candidate of planned) {
      const entryKey = cacheEntryKey({
        provider: key,
        model: usedModel,
        prefix_hash: candidate.hash,
        layer: candidate.layer,
      });
      entries.set(
        entryKey,
        applyEvidence(entries.get(entryKey) ?? null, {
          provider: key,
          model: usedModel,
          prefix_hash: candidate.hash,
          layer: candidate.layer,
          tokens: candidate.tokens,
          at: now,
          ttl_s: candidate.ttl_s,
          mechanism: pricing.mechanism,
          evidence: candidate.evidence,
          tokens_provenance: candidate.tokens_provenance,
          pricing_version: pricing.version ?? null,
        }),
      );
    }

    turns.push(
      Object.freeze({
        i: turn.i,
        at: now,
        // How the attempt ended, carried through so a measure reducing these turns can
        // exclude a failure from a population of responses rather than counting it as one
        // (see `coverage`'s reporting denominator).
        status: turn.status ?? RESULT_STATUS.OK,
        layers: summary,
        changed: Object.freeze(changed),
        invalidated: Object.freeze(invalidated),
        relation: relation?.relation ?? null,
        divergence_index: relation?.divergence_index ?? null,
        belief,
        decision,
        /** The warm prefix we would have expected the provider to read. */
        predicted_read_tokens: belief.warm_tokens,
        predicted_provenance: belief.warm_tokens_provenance,
        /**
         * The *incremental* write: a provider that already holds the warm region charges
         * for what it had to add, not for the whole prefix it now holds. Reporting the
         * full cacheable region here would double-count every turn of a growing session
         * against a `cache_write` number the provider deliberately reports as a delta.
         */
        predicted_write_tokens: Math.max(0, plan.cacheable_tokens - belief.warm_tokens),
        cacheable_tokens: plan.cacheable_tokens,
        partial_layers: Object.freeze(belief.partial_layers ?? []),
        /** What the fixture says the provider reported. `null` means it reported nothing. */
        reported_read_tokens: usage.cache_read ?? null,
        reported_write_tokens: usage.cache_write ?? null,
        provider_reported: reported,
        cache_confidence: classification.confidence,
        cache_evidence: classification.evidence,
        attributed_read_tokens: split.attributed_tokens,
        entries_written: planned.length,
        skipped,
      }),
    );

    previousSummary = summary;
    previousMessages = layers.messages;
    now += Number.isFinite(turn.gap_ms) ? turn.gap_ms : gapMs;
  }

  return Object.freeze({
    fixture_id: prepared.fixture_id ?? null,
    fixture_source: fixtureSource(prepared),
    /** Where the fixture's own `usage` numbers came from; see `fixtureExpectationBasis`. */
    expectation_basis: fixtureExpectationBasis(prepared),
    project_kind: fixtureProjectKind(prepared),
    provider,
    pricing_key: key,
    model: usedModel,
    mechanism: pricing.mechanism,
    pricing_status: registry.statusOf(key).status,
    pricing_version: pricing.version ?? null,
    started_at: startAt,
    ended_at: now,
    turns: Object.freeze(turns),
    entries: entries,
    n: turns.length,
  });
}

export default replayFixture;
