/**
 * Session lifecycle (section 5) — states, close reasons, and the two boundary
 * predicates. No routing, no decisions: M1 records what happened to a session.
 *
 *   NEW --first turn--> ACTIVE --turn N+1 extends prefix--> ACTIVE (loop)
 *                         |
 *                         +-- boundary signal --> REEVALUATING --> ACTIVE
 *                         |      (typed, never produced in M1: nothing
 *                         |       re-evaluates because nothing decides)
 *                         |
 *                         +-- idle > timeout / discontinuity / explicit --> CLOSED
 *
 * Close reasons are always recorded and never null (section 5):
 * explicit, idle_timeout, prefix_discontinuity, client_compaction_suspected, swept.
 *
 * The compaction predicate is section 5 restated: a messages-layer hash change that
 * shortens the total token count while preserving the tools and system hashes. It is
 * kept separate from prefix_discontinuity because the ratio between the two is the
 * evidence Open Question Q5 needs, and mislabelling one as the other destroys that
 * evidence. That is why the test is token shortening and not a message count. When
 * token counts are unavailable on either side the predicate falls back to the message
 * count and says so through `basis`; it never guesses.
 *
 * Pure.
 */

import { MESSAGE_RELATION } from "../prefix/extension.js";
import { DEFAULT_SESSION_POLICY } from "./policy.js";

export const SESSION_STATE = Object.freeze({
  NEW: "new",
  ACTIVE: "active",
  REEVALUATING: "reevaluating",
  CLOSED: "closed",
});

export const CLOSE_REASON = Object.freeze({
  EXPLICIT: "explicit",
  IDLE_TIMEOUT: "idle_timeout",
  PREFIX_DISCONTINUITY: "prefix_discontinuity",
  CLIENT_COMPACTION_SUSPECTED: "client_compaction_suspected",
  SWEPT: "swept",
});

export const CLOSE_REASON_VALUES = Object.freeze(Object.values(CLOSE_REASON));

/** Legal transitions. Anything absent from this map is a bug, not a state. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [SESSION_STATE.NEW]: Object.freeze([SESSION_STATE.ACTIVE, SESSION_STATE.CLOSED]),
  [SESSION_STATE.ACTIVE]: Object.freeze([
    SESSION_STATE.ACTIVE,
    SESSION_STATE.REEVALUATING,
    SESSION_STATE.CLOSED,
  ]),
  [SESSION_STATE.REEVALUATING]: Object.freeze([SESSION_STATE.ACTIVE, SESSION_STATE.CLOSED]),
  // Only the sweeper may touch a closed session, and it does not reopen one.
  [SESSION_STATE.CLOSED]: Object.freeze([]),
});

export class SessionLifecycleError extends Error {
  constructor(message, { code = "SESSION_ILLEGAL_TRANSITION" } = {}) {
    super(message);
    this.name = "SessionLifecycleError";
    this.code = code;
  }
}

export function isSessionState(value) {
  return Object.values(SESSION_STATE).includes(value);
}

export function isCloseReason(value) {
  return CLOSE_REASON_VALUES.includes(value);
}

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new SessionLifecycleError(`illegal session transition ${from} -> ${to}`);
  }
  return to;
}

/**
 * Has this session been silent longer than the idle timeout?
 * @param {{last_seen_at?: number|null, opened_at?: number}} session
 * @param {number} now integer ms from the injected Clock
 * @param {object} [policy]
 */
export function isIdle(session, now, policy = DEFAULT_SESSION_POLICY) {
  const last = Number.isInteger(session?.last_seen_at) ? session.last_seen_at : session?.opened_at;
  if (!Number.isInteger(last) || !Number.isInteger(now)) return false;
  return now - last >= policy.idleTimeoutMs;
}

/**
 * Section 5 compaction signature.
 *
 * @param {object} args
 * @param {object} args.prev recorded prefix state: tools_hash, system_hash,
 *        messages_tokens, message_count
 * @param {object} args.next freshly hashed prefix state, same shape
 * @param {string} args.relation from classifyMessageSequences
 * @param {object} [args.policy]
 * @returns {{compaction: boolean, basis: string|null, shrink_bp: number|null, reason: string|null}}
 */
export function detectCompaction({ prev, next, relation, policy = DEFAULT_SESSION_POLICY }) {
  const out = { compaction: false, basis: null, shrink_bp: null, reason: null };

  if (relation !== MESSAGE_RELATION.SHORTENED && relation !== MESSAGE_RELATION.DIVERGENCE) {
    out.reason = "messages_layer_not_shortened";
    return out;
  }
  // Preserved tools and system are half the signature. Without them this is an
  // ordinary discontinuity, whatever the token counts say.
  if ((prev?.tools_hash ?? null) !== (next?.tools_hash ?? null)) {
    out.reason = "tools_layer_changed";
    return out;
  }
  if ((prev?.system_hash ?? null) !== (next?.system_hash ?? null)) {
    out.reason = "system_layer_changed";
    return out;
  }

  const prevTokens = prev?.messages_tokens;
  const nextTokens = next?.messages_tokens;
  if (Number.isInteger(prevTokens) && prevTokens > 0 && Number.isInteger(nextTokens)) {
    // Integer basis-point comparison: next <= prev * threshold / 10000.
    const shrinkBp = Math.floor((nextTokens * 10000) / prevTokens);
    out.shrink_bp = shrinkBp;
    out.basis = "tokens";
    out.compaction = shrinkBp <= policy.compactionShrinkMaxBp;
    if (!out.compaction) out.reason = "token_count_not_materially_shorter";
    return out;
  }

  // Token counts unavailable: fall back to the message count and label the basis, so
  // a reader can tell which evidence produced the close reason.
  const prevCount = prev?.message_count;
  const nextCount = next?.message_count;
  if (Number.isInteger(prevCount) && prevCount > 0 && Number.isInteger(nextCount)) {
    out.basis = "message_count";
    out.shrink_bp = Math.floor((nextCount * 10000) / prevCount);
    out.compaction = out.shrink_bp <= policy.compactionShrinkMaxBp;
    if (!out.compaction) out.reason = "message_count_not_materially_shorter";
    return out;
  }

  out.reason = "no_comparable_size_evidence";
  return out;
}

export default SESSION_STATE;
