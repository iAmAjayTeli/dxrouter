/**
 * SessionResolver — who is this turn, and how sure are we?
 *
 * Pure by construction: it takes already-hashed layers plus already-fetched store
 * rows and returns a decision object. It never reads a clock, never generates an id,
 * never touches the store. That is what makes every branch below directly testable
 * and what keeps the safety argument checkable by reading one file.
 *
 * Resolution priority (section 2 of the M1 brief, section 4.2 of the architecture):
 *
 *   1. explicit    the client sent a validated X-DXR-Session key
 *   2. strong      exactly one open session has continuous tools and system hashes
 *                  AND the messages layer is a proven prefix extension of it
 *   3. weak        exactly one open session has continuous tools and system hashes
 *                  and the messages layer is genuinely undecidable (section 4.2:
 *                  "tools+system continuous, messages ambiguous")
 *   4. new         anything else, with identity_confidence = unknown
 *
 * The safety rule is FALSE SPLIT beats FALSE CONTINUATION, and it decides every
 * ambiguous case here:
 *
 *  - Two or more open sessions could match? New session, `unknown`. Guessing which
 *    one would be a coin flip whose downside is asserting a warm prefix that another
 *    conversation owns.
 *  - The messages diverge from a candidate? That candidate is not this turn. It could
 *    equally be an independent conversation that happens to share a system prompt and
 *    a tool set, which is the normal case for two agents in one repository, so the
 *    candidate is left alone and a new session opens.
 *  - The messages are materially shorter with tools and system preserved? That is the
 *    section 5 compaction signature, and it is recorded as such. With an explicit key
 *    the predecessor is closed and a successor opens; without one, no lineage is
 *    claimed at all, because a short new conversation in the same project produces the
 *    identical signature and picking between them would be a guess.
 *
 * What is deliberately absent, because section 4 of the brief forbids it: semantic
 * similarity, project-name matching, user-agent similarity, IP similarity, timestamps
 * as identity proof, approximate message similarity, probabilistic scoring. The only
 * evidence used is hash equality and the prefix-extension proof.
 *
 * One exact exception, and it is still hash equality: a client that moves its
 * `cache_control` breakpoint onto its newest message makes the previously-final
 * message a different message under strict canonical hashing, which splits a
 * conversation that never ended. `prefix/extension.js` re-tests that ONE boundary
 * index with the enumerated bookkeeping fields removed and reports the strict verdict
 * alongside the effective one; a softened verdict arrives here carrying
 * `normalized_by`, and this file adds a label and a note rather than hiding it. Every
 * other divergence is a discontinuity exactly as before.
 */

import { IDENTITY_CONFIDENCE, IDENTITY_SOURCE, M1_LABELS } from "./confidence.js";
import { MESSAGE_RELATION, classifyMessageSequences, isPrefixContinuation } from "../prefix/extension.js";
import { PREFIX_RULE_VERSION } from "../prefix/bookkeeping.js";
import { invalidatedLayers } from "../prefix/invalidation.js";
import { CLOSE_REASON, detectCompaction } from "../session/lifecycle.js";
import { DEFAULT_SESSION_POLICY } from "../session/policy.js";

export const RESOLUTION_ACTION = Object.freeze({
  CONTINUE: "continue",
  OPEN: "open",
});

/** The turn-level boundary vocabulary. Same words as the close reasons it feeds. */
export const TURN_BOUNDARY = Object.freeze({
  PREFIX_DISCONTINUITY: CLOSE_REASON.PREFIX_DISCONTINUITY,
  CLIENT_COMPACTION_SUSPECTED: CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED,
});

/** Flatten computed layers into the comparable shape the store keeps. */
export function layersToPrefixState(layers) {
  return {
    tools_hash: layers?.tools?.hash ?? null,
    system_hash: layers?.system?.hash ?? null,
    messages_hash: layers?.messages?.hash ?? null,
    message_count: layers?.messages?.count ?? null,
    messages_tokens: layers?.messages?.tokens ?? null,
    digests: layers?.messages?.digests ?? null,
    chain: layers?.messages?.chain ?? null,
    // The two values the NEXT turn needs to re-test this turn's final and second-to-last
    // messages with cache bookkeeping removed, plus the rule that produced them.
    // Persisted; a null on an existing row means "written before that value was
    // recorded", never "the rule said no".
    final_digest_norm: layers?.messages?.final_digest_norm ?? null,
    penultimate_digest_norm: layers?.messages?.penultimate_digest_norm ?? null,
    prefix_rule_version: PREFIX_RULE_VERSION,
  };
}

/**
 * The messages-layer view the extension check wants, taken from a flat prefix state.
 * Two shapes exist on purpose: the flat one is what the store persists per session,
 * and the nested one is what `classifyMessageSequences` compares. Converting in one
 * named place keeps the key names from drifting apart silently.
 */
export function messagesViewOf(prefixState) {
  return {
    hash: prefixState?.messages_hash ?? null,
    count: prefixState?.message_count ?? null,
    digests: prefixState?.digests ?? null,
    chain: prefixState?.chain ?? null,
    final_digest_norm: prefixState?.final_digest_norm ?? null,
    penultimate_digest_norm: prefixState?.penultimate_digest_norm ?? null,
  };
}

/** Compare one candidate against the current turn. Pure, no side effects. */
export function compareCandidate(candidatePrefix, layers, policy = DEFAULT_SESSION_POLICY) {
  const next = layersToPrefixState(layers);
  // The lazy normalized-digest accessor stays on the layers and never enters the flat
  // state: a function has no place in a row that gets persisted.
  const nextView = {
    ...messagesViewOf(next),
    normalized_digest_at: layers?.messages?.normalized_digest_at ?? null,
  };
  const relation = classifyMessageSequences(messagesViewOf(candidatePrefix), nextView);
  const compaction = detectCompaction({
    prev: candidatePrefix,
    next,
    // The effective relation: a proven continuation, however it was proven, is not a
    // compaction, and a softened verdict only ever grew or held the message count.
    relation: relation.relation,
    policy,
  });
  const invalidation = invalidatedLayers(candidatePrefix, next);
  return { relation, compaction, invalidation };
}

function baseResult(layers) {
  const next = layersToPrefixState(layers);
  return {
    action: RESOLUTION_ACTION.OPEN,
    session_id: null,
    client_key: null,
    confidence: IDENTITY_CONFIDENCE.UNKNOWN,
    source: IDENTITY_SOURCE.NEW,
    relation: MESSAGE_RELATION.INDETERMINATE,
    divergence_index: null,
    // The unrelaxed verdict, always recorded next to the effective one, and the rule
    // version in force when it was recorded (§ evidence: a stored observation must
    // never be ambiguous about which normalization produced it).
    strict_relation: MESSAGE_RELATION.INDETERMINATE,
    strict_divergence_index: null,
    prefix_rule_version: PREFIX_RULE_VERSION,
    normalized_by: null,
    compaction: null,
    boundary: null,
    close_predecessor: null,
    predecessor_id: null,
    changed: [],
    invalidated: [],
    labels: [],
    notes: [],
    prefix_state: next,
  };
}

function applyComparison(result, comparison) {
  result.relation = comparison.relation.relation;
  result.divergence_index = comparison.relation.divergence_index;
  result.strict_relation = comparison.relation.strict_relation ?? comparison.relation.relation;
  result.strict_divergence_index =
    comparison.relation.strict_divergence_index ?? comparison.relation.divergence_index;
  result.normalized_by = comparison.relation.normalized_by ?? null;
  result.compaction = comparison.compaction;
  result.changed = comparison.invalidation.changed;
  result.invalidated = comparison.invalidation.invalidated;
  // Rule 5 of the fix: a softened verdict is never silent. The label says a moved cache
  // breakpoint is why the strict test failed, and the note carries the index it failed
  // at, so the strict outcome is still readable off the turn row.
  if (result.normalized_by) {
    result.labels.push(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    result.notes.push(`strict_prefix_divergence_at:${result.strict_divergence_index}`);
    result.notes.push(`prefix_normalized_by:${result.normalized_by}`);
  }
  return result;
}

/**
 * @param {object} args
 * @param {object} args.layers output of computePrefixLayers
 * @param {string|null} [args.explicitKey] validated client session key
 * @param {{session: object, prefix: object}|null} [args.explicitCandidate] the OPEN
 *        session carrying that key, if any
 * @param {{id: string}|null} [args.explicitPredecessor] most recently CLOSED session
 *        carrying that key, used only to record lineage
 * @param {Array<{session: object, prefix: object}>} [args.candidates] open sessions
 *        whose tools and system hashes already match this turn, most recent first
 * @param {object} [args.policy]
 * @returns {object} resolution (see baseResult for the shape)
 */
export function resolveSessionIdentity({
  layers,
  explicitKey = null,
  explicitCandidate = null,
  explicitPredecessor = null,
  candidates = [],
  policy = DEFAULT_SESSION_POLICY,
} = {}) {
  const result = baseResult(layers);

  // ---- 1. Explicit identity. Takes precedence; inference is not consulted at all.
  if (explicitKey) {
    result.client_key = explicitKey;
    result.confidence = IDENTITY_CONFIDENCE.EXPLICIT;
    result.source = IDENTITY_SOURCE.HEADER;

    if (!explicitCandidate) {
      result.action = RESOLUTION_ACTION.OPEN;
      result.predecessor_id = explicitPredecessor?.id ?? null;
      result.notes.push(explicitPredecessor ? "explicit_key_reopened_after_close" : "explicit_key_first_seen");
      return result;
    }

    const comparison = compareCandidate(explicitCandidate.prefix, layers, policy);
    applyComparison(result, comparison);

    const rel = comparison.relation.relation;
    if (isPrefixContinuation(rel) || rel === MESSAGE_RELATION.INDETERMINATE) {
      result.action = RESOLUTION_ACTION.CONTINUE;
      result.session_id = explicitCandidate.session.id;
      if (rel === MESSAGE_RELATION.INDETERMINATE) result.notes.push("explicit_key_prefix_unverifiable");
      return result;
    }

    // The client insists this is the same conversation, and the prefix says the
    // conversation restarted. Identity stays explicit (the key is honoured and
    // carried forward), but the session is closed with the reason the evidence
    // supports and a successor opens: keeping one open session across a proven
    // discontinuity would make its recorded prefix state a lie.
    const reason = comparison.compaction.compaction
      ? CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED
      : CLOSE_REASON.PREFIX_DISCONTINUITY;
    result.action = RESOLUTION_ACTION.OPEN;
    result.boundary = reason;
    result.close_predecessor = { session_id: explicitCandidate.session.id, reason };
    result.predecessor_id = explicitCandidate.session.id;
    return result;
  }

  // ---- 2/3. Inference. Candidates are expected to arrive pre-filtered on tools+system
  // continuity, which is the section 4.2 precondition for any inferred identity. The
  // precondition is re-checked here rather than trusted: it is the whole difference
  // between "same conversation" and "different agent in the same repository", and an
  // invariant that lives in a SQL WHERE clause is not an invariant that can be tested.
  const compared = candidates.map((c) => ({ candidate: c, comparison: compareCandidate(c.prefix, layers, policy) }));
  const continuous = compared.filter(
    (c) => !c.comparison.invalidation.changed.includes("tools") && !c.comparison.invalidation.changed.includes("system"),
  );
  if (continuous.length < compared.length) result.notes.push("candidates_dropped_on_tools_or_system_change");

  const strong = continuous.filter((c) => isPrefixContinuation(c.comparison.relation.relation));
  if (strong.length === 1) {
    applyComparison(result, strong[0].comparison);
    result.action = RESOLUTION_ACTION.CONTINUE;
    result.session_id = strong[0].candidate.session.id;
    result.client_key = strong[0].candidate.session.client_key ?? null;
    result.confidence = IDENTITY_CONFIDENCE.STRONGLY_INFERRED;
    result.source = IDENTITY_SOURCE.PREFIX_EXTENSION;
    return result;
  }
  if (strong.length > 1) {
    result.notes.push("multiple_prefix_extension_candidates");
    return result;
  }

  const compacted = continuous.filter((c) => c.comparison.compaction.compaction);
  if (compacted.length === 1) {
    applyComparison(result, compacted[0].comparison);
    // The compaction signature is recorded as evidence (§9, and the ratio Open
    // Question Q5 needs) but NO lineage is claimed: without an explicit key, "the
    // messages got much shorter with the same tools and system prompt" describes a
    // client compaction and a brand-new short conversation in the same project
    // equally well. Choosing the first reading would be the approximate-similarity
    // guess section 4 forbids, and its failure mode is a false continuation. So the
    // turn opens a new session at `unknown`, carries the boundary for the record, and
    // leaves the candidate alone — the sweeper closes it when it goes idle.
    result.action = RESOLUTION_ACTION.OPEN;
    result.confidence = IDENTITY_CONFIDENCE.UNKNOWN;
    result.source = IDENTITY_SOURCE.NEW;
    result.boundary = CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED;
    result.notes.push("compaction_shaped_candidate_not_claimed");
    return result;
  }
  if (compacted.length > 1) {
    result.notes.push("multiple_compaction_candidates");
    return result;
  }

  const ambiguous = continuous.filter((c) => c.comparison.relation.relation === MESSAGE_RELATION.INDETERMINATE);
  if (ambiguous.length === 1) {
    applyComparison(result, ambiguous[0].comparison);
    // Section 4.2, weak row: tools and system continuous, messages ambiguous. The
    // messages layer could not be compared at all (no recorded prefix state, or this
    // request carries no messages layer), so the identity is asserted at the weakest
    // grade that still names a session, and the grade is what later milestones read
    // before claiming anything about a cache.
    result.action = RESOLUTION_ACTION.CONTINUE;
    result.session_id = ambiguous[0].candidate.session.id;
    result.client_key = ambiguous[0].candidate.session.client_key ?? null;
    result.confidence = IDENTITY_CONFIDENCE.WEAKLY_INFERRED;
    result.source = IDENTITY_SOURCE.AMBIGUOUS_PREFIX;
    return result;
  }
  if (ambiguous.length > 1) {
    result.notes.push("multiple_ambiguous_candidates");
    return result;
  }

  // ---- 4. No usable evidence. A new session with unknown identity is the correct,
  // conservative answer, not a failure.
  if (compared.length > 0) result.notes.push("candidates_all_divergent");
  return result;
}

export default resolveSessionIdentity;
