/**
 * Prefix-extension check — the deterministic core of strong inference.
 *
 * The question is never "did the message count grow". A count comparison accepts a
 * reordered history, an edited historical message and a completely different
 * conversation that happens to be longer, all of which would be a FALSE
 * CONTINUATION. The check here is instead: does the new sequence reproduce, byte for
 * byte, the hash of the first k messages of the sequence we last saw?
 *
 *   next.chain[prev.count] === prev.hash    <=>   next extends prev
 *
 * because chain[k] is the rolling digest of exactly the first k messages
 * (prefix/hasher.js). Any reorder, edit or replacement inside those k messages
 * changes chain[k] and is reported as a divergence, not a continuation.
 *
 * Five outcomes, all of them explicit:
 *   identical      same sequence, no new messages (a retry, or a client resend)
 *   extension      prev is a strict prefix of next, with new messages appended
 *   divergence     the first prev.count messages differ
 *   shortened      next has fewer messages than prev (compaction candidate)
 *   indeterminate  the recorded state cannot answer the question
 *
 * `indeterminate` exists so ambiguity has a name. It is what makes weak inference
 * legitimate in the one place section 4.2 allows it, instead of a heuristic.
 *
 * ---------------------------------------------------------------------------
 * The one bookkeeping exception, and why it is not a heuristic
 * ---------------------------------------------------------------------------
 *
 * `classifyStrict` below is the test above, unchanged and always run first. Its
 * verdict is always reported, in `strict_relation` / `strict_divergence_index`.
 *
 * A measured client behaviour makes that verdict, on its own, split conversations
 * that never ended: Claude Code moves its `cache_control` breakpoints onto its newest
 * messages and removes them from the messages that used to be newest. The bytes of
 * those messages are otherwise identical (see prefix/bookkeeping.js for the captured
 * evidence, including the six-request capture that measured TWO rolling breakpoints).
 * Strictly they are different messages, at index prev.count - 1 and/or prev.count - 2,
 * so the strict test reports a divergence at or just before the last recorded message
 * and the next request looks like a new conversation.
 *
 * So when — and only when — the strict test says DIVERGENCE at exactly `prev.count - 1`
 * or `prev.count - 2` (rule "r2"), every message from that index through the last
 * recorded one is compared again with the enumerated bookkeeping fields removed. Every
 * earlier index is untouched, because the strict test already proved 0..k-1
 * byte-identical to get k. If the whole window matches under that rule the whole
 * recorded prefix matches under that rule, which is an exact prefix extension, and the
 * turn is a continuation. `normalized_by` records the rule that softened it.
 *
 * What that is not: not similarity, not a token or time or name comparison, not a
 * tolerance, not fuzzy matching. It is digest equality over a byte-exact
 * transformation with a literal field list, applied at one or two named indices.
 * Divergence anywhere else — including one index earlier than the window — stays a
 * divergence, and so does any message in the window whose content actually changed.
 *
 * Pure: no clock, no environment, no store.
 */

import { PREFIX_RULE_VERSION } from "./bookkeeping.js";

export const MESSAGE_RELATION = Object.freeze({
  IDENTICAL: "identical",
  EXTENSION: "extension",
  DIVERGENCE: "divergence",
  SHORTENED: "shortened",
  INDETERMINATE: "indeterminate",
});

export const MESSAGE_RELATION_VALUES = Object.freeze(Object.values(MESSAGE_RELATION));

/** First index at which two digest lists differ, or null when neither differs. */
function firstDifference(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return null;
}

/**
 * The strict test, byte for byte. Kept as its own exported function so evidence and
 * measurement can always ask the unrelaxed question, and so the relaxed path below
 * provably cannot reach inside it.
 *
 * @param {{hash: string|null, count: number|null, digests?: string[]|null}} prev
 *        previously recorded messages state (from the store)
 * @param {{hash: string|null, count: number|null, chain?: string[]|null, digests?: string[]|null}} next
 *        freshly hashed messages state (from PrefixHasher)
 * @returns {{relation: string, divergence_index: number|null, prev_count: number|null,
 *            next_count: number|null, next_is_prefix_of_prev: boolean, reason: string|null}}
 */
export function classifyStrict(prev, next) {
  const out = {
    relation: MESSAGE_RELATION.INDETERMINATE,
    divergence_index: null,
    prev_count: prev?.count ?? null,
    next_count: next?.count ?? null,
    next_is_prefix_of_prev: false,
    reason: null,
  };

  if (!prev || typeof prev.hash !== "string" || !Number.isInteger(prev.count)) {
    out.reason = "no_recorded_prefix_state";
    return out;
  }
  if (!next || typeof next.hash !== "string" || !Number.isInteger(next.count)) {
    out.reason = "request_has_no_messages_layer";
    return out;
  }

  if (next.count === prev.count && next.hash === prev.hash) {
    out.relation = MESSAGE_RELATION.IDENTICAL;
    return out;
  }

  if (next.count < prev.count) {
    out.relation = MESSAGE_RELATION.SHORTENED;
    const diff = firstDifference(prev.digests, next.digests);
    out.divergence_index = diff === null ? next.count : diff;
    // A clean truncation (the survivors are still the original opening messages) is
    // recorded because it is the shape a client compaction usually leaves behind.
    out.next_is_prefix_of_prev = Array.isArray(prev.digests) && Array.isArray(next.digests) && diff === null;
    return out;
  }

  // next.count >= prev.count from here.
  const chain = Array.isArray(next.chain) ? next.chain : null;
  if (!chain || chain.length <= prev.count) {
    out.reason = chain ? "chain_shorter_than_recorded_count" : "no_chain_available";
    return out;
  }

  if (chain[prev.count] === prev.hash) {
    out.relation = next.count === prev.count ? MESSAGE_RELATION.IDENTICAL : MESSAGE_RELATION.EXTENSION;
    return out;
  }

  out.relation = MESSAGE_RELATION.DIVERGENCE;
  out.divergence_index = firstDifference(prev.digests, next.digests);
  return out;
}

/** True only for the relations that prove continuity of the messages layer. */
export function isPrefixContinuation(relation) {
  return relation === MESSAGE_RELATION.EXTENSION || relation === MESSAGE_RELATION.IDENTICAL;
}

/**
 * The recorded normalized digest for one index, or null when the store cannot answer.
 *
 * Only two indices are answerable, and each has its own persisted column, because the
 * row holds digests and never messages: there is nothing to re-derive from. A null here
 * always means "this row was written by a build that did not record that value", never
 * "the rule said no" — which is exactly why an r1-era row cannot be softened by the
 * two-position path: it has no `penultimate_digest_norm` to compare against.
 */
function recordedNormalizedAt(prev, i) {
  if (i === prev.count - 1) return typeof prev.final_digest_norm === "string" ? prev.final_digest_norm : null;
  if (i === prev.count - 2) {
    return typeof prev.penultimate_digest_norm === "string" ? prev.penultimate_digest_norm : null;
  }
  return null;
}

/**
 * Re-test the boundary message(s) with cache bookkeeping removed.
 *
 * Runs only on a strict DIVERGENCE, only when the divergence index is `prev.count - 1`
 * or `prev.count - 2` (rule `r2`; see `prefix/bookkeeping.js` for the capture that
 * measured the two-wide window), and only when both sides can supply a normalized
 * digest for EVERY index from the divergence through `prev.count - 1`. Every guard
 * below fails closed: the strict divergence stands and the `reason` says which piece of
 * evidence was missing.
 *
 * Requiring the whole window, not just the divergence index, is what keeps the rule
 * exact. The strict test already proved 0..k-1 byte-identical to arrive at k; verifying
 * k..count-1 under the rule then proves the entire recorded prefix matches under the
 * rule, which is an exact prefix extension. Checking only k would leave the indices
 * after it unexamined.
 */
function retestMovedCacheBreakpoint(out, prev, next) {
  const k = out.divergence_index;
  const last = prev.count - 1;
  const penultimate = prev.count - 2;
  if (!Number.isInteger(k) || (k !== last && k !== penultimate)) {
    // Includes a null index (the recorded digests were absent or truncated) and any
    // divergence at prev.count - 3 or deeper, which is a real discontinuity.
    out.reason = "divergence_not_at_recorded_boundary";
    return out;
  }
  const at = typeof next.normalized_digest_at === "function" ? next.normalized_digest_at : null;
  if (!at) {
    out.reason = "normalized_boundary_digest_unavailable";
    return out;
  }

  for (let i = k; i <= last; i += 1) {
    const recorded = recordedNormalizedAt(prev, i);
    if (!recorded) {
      // A row written before this position was recorded, so the question cannot be
      // asked of it. Named per position so an operator can tell which value is missing.
      out.reason =
        i === last ? "no_normalized_boundary_digest_recorded" : "no_normalized_penultimate_digest_recorded";
      return out;
    }
    const incoming = at(i);
    if (typeof incoming !== "string") {
      out.reason = "normalized_boundary_digest_unavailable";
      return out;
    }
    if (incoming !== recorded) {
      // This message really did change. Removing the bookkeeping fields did not make it
      // the same message, so this is a genuine discontinuity.
      out.reason = "boundary_differs_beyond_cache_bookkeeping";
      return out;
    }
  }

  // 0..k-1 are byte-identical (that is how k was found) and k..count-1 are identical
  // under the rule, so the whole recorded prefix of prev.count messages matches under
  // the rule.
  out.relation = next.count === prev.count ? MESSAGE_RELATION.IDENTICAL : MESSAGE_RELATION.EXTENSION;
  out.divergence_index = null;
  out.normalized_by = PREFIX_RULE_VERSION;
  out.reason = k === last ? "cache_breakpoint_moved" : "cache_breakpoint_moved_window";
  return out;
}

/**
 * Classify the new message sequence against the previously observed one: the strict
 * test, plus the one bounded bookkeeping re-test documented at the top of this file.
 *
 * @param {object} prev previously recorded messages state. `final_digest_norm` and
 *        `penultimate_digest_norm` are the recorded normalized digests of its last and
 *        second-to-last messages; either absent on rows written before that position was
 *        recorded, which simply leaves the strict verdict standing.
 * @param {object} next freshly hashed messages state. `normalized_digest_at(i)` is the
 *        lazy accessor from `hashMessagesLayer`.
 * @returns {object} the strict shape plus `strict_relation`, `strict_divergence_index`
 *          and `normalized_by` (the rule that softened the verdict, else null).
 */
export function classifyMessageSequences(prev, next) {
  const out = classifyStrict(prev, next);
  out.strict_relation = out.relation;
  out.strict_divergence_index = out.divergence_index;
  out.normalized_by = null;
  if (out.relation !== MESSAGE_RELATION.DIVERGENCE) return out;
  return retestMovedCacheBreakpoint(out, prev, next);
}

export default classifyMessageSequences;
