/**
 * observeTurn — the one entry point M1 exposes to the live request path.
 *
 * It observes and persists. It does not decide anything about routing: no `decide()`,
 * no candidate list, no provider, no model, no retry, no fallback. §12 of the brief is
 * a hard boundary and this file is where it would be broken first, so the rule is
 * written here as well as in the docs: **nothing in this module may return a value the
 * caller could route on.** The record it returns is hashes, grades and counts.
 *
 * Sequence, in this order for a reason:
 *
 *   1. hash the layers                 pure, no store access, cheapest to abandon
 *   2. resolve identity                pure, from already-fetched rows
 *   3. take the session lock           only when continuing an existing session
 *   4. one transaction: turn + prefix state + session row (+ close a predecessor)
 *   5. release the lock
 *
 * Step 3 sits outside the transaction because it may wait (up to the 250 ms budget)
 * and holding a SQLite write transaction open while sleeping would block every other
 * session, converting an advisory per-session lock into a global one. A turn that
 * cannot take the lock still proceeds, with its confidence degraded one step and the
 * label `identity-degraded-by-lock` (§12.2) — the conservative direction.
 *
 * Effects are injected, never reached for: `clock` (the Clock port), `newId`, `owner`,
 * `tokenizer`, `sleep`. That is what lets the concurrency and lifecycle tests drive
 * time and identity directly, and it is also what keeps I1 intact — a path, an
 * environment variable and a process id are all host knowledge that arrive as
 * arguments.
 *
 * Fail-open is the *caller's* job, deliberately: this function throws on a real
 * failure so tests can see it, and `adapters/ninerouter/sessionObserver.js` swallows
 * everything so an observation can never change a response.
 */

import { randomUUID } from "node:crypto";

import { computePrefixLayers, prefixLayerSummary } from "../prefix/hasher.js";
import { serializeLayerList } from "../prefix/invalidation.js";
import { M1_LABELS, atLeastAsStrong, degradeConfidence } from "../identity/confidence.js";
import {
  RESOLUTION_ACTION,
  layersToPrefixState,
  resolveSessionIdentity,
} from "../identity/sessionResolver.js";
import {
  UNKNOWN_PROJECT_ROOT,
  hashProjectRoot,
  sanitizeProjectRoot,
  validateSessionKey,
} from "../identity/sessionId.js";
import { DEFAULT_SESSION_POLICY } from "./policy.js";
import { acquireSessionLock, formatLockOwner, releaseSessionLock } from "./locks.js";

/** Resolve the project root exactly once, with privacy applied (§14.2). */
export function resolveProjectRoot({ projectRoot, hashProjectPaths = false, salt = null }) {
  const clean = sanitizeProjectRoot(projectRoot);
  if (!hashProjectPaths) return { project_root: clean, hashed: false, note: null };
  if (!salt) {
    // Hashing was asked for and cannot be done honestly. Storing the plain path
    // anyway would break the privacy promise, so the root becomes `unknown` and the
    // turn says why.
    return { project_root: UNKNOWN_PROJECT_ROOT, hashed: false, note: "project_root_hash_salt_missing" };
  }
  return { project_root: hashProjectRoot(clean, salt), hashed: true, note: null };
}

/** Everything the turn row needs from the hashed layers. No content, by construction. */
function turnLayerFields(layers) {
  return {
    ...prefixLayerSummary(layers),
    token_estimator: layers.messages.estimator ?? layers.system.estimator ?? layers.tools.estimator ?? null,
  };
}

function joinList(values) {
  return Array.isArray(values) && values.length ? values.join(",") : null;
}

/**
 * Observe one turn.
 *
 * @param {object} args
 * @param {object} args.store output of openContinuityStore (db + repositories)
 * @param {object} args.request the three prefix layers plus non-content metadata:
 *        `{tools, system, messages, protocol, model, client_hint: {session_key, project_root}}`
 * @param {{now: () => number}} args.clock the injected Clock port
 * @param {object} [args.policy]
 * @param {() => string} [args.newId] session id factory
 * @param {string} [args.owner] lock owner token
 * @param {Function} [args.tokenizer] see prefix/tokens.js
 * @param {boolean} [args.hashProjectPaths]
 * @param {string|null} [args.projectRootSalt]
 * @param {(ms:number)=>Promise<void>} [args.sleep]
 * @returns {Promise<object>} a content-free observation record
 */
export async function observeTurn({
  store,
  request = {},
  clock,
  policy = DEFAULT_SESSION_POLICY,
  newId = () => randomUUID(),
  owner = formatLockOwner(0, "observer"),
  tokenizer = null,
  hashProjectPaths = false,
  projectRootSalt = null,
  sleep = undefined,
} = {}) {
  const { db, sessions, prefixState } = store;
  const notes = [];
  const labels = [];

  // ---- 1. Hash the layers. Pure, and the only place request content is touched.
  const layers = computePrefixLayers(
    { tools: request.tools, system: request.system, messages: request.messages },
    { tokenizer },
  );
  const nextPrefix = layersToPrefixState(layers);

  const root = resolveProjectRoot({
    projectRoot: request.client_hint?.project_root,
    hashProjectPaths,
    salt: projectRootSalt,
  });
  if (root.note) notes.push(root.note);

  // ---- 2. Validate the explicit key, then resolve identity from store rows.
  const keyCheck = validateSessionKey(request.client_hint?.session_key);
  if (!keyCheck.ok && keyCheck.reason !== "absent") notes.push(`session_key_rejected:${keyCheck.reason}`);
  const explicitKey = keyCheck.ok ? keyCheck.key : null;

  let explicitCandidate = null;
  let explicitPredecessor = null;
  let candidates = [];

  if (explicitKey) {
    const open = sessions.findOpenByClientKey(db, explicitKey);
    if (open) explicitCandidate = { session: open, prefix: prefixState.getPrefixState(db, open.id) ?? {} };
    else explicitPredecessor = sessions.findLatestClosedByClientKey(db, explicitKey);
  } else {
    candidates = sessions.findOpenCandidatesByLayers(db, {
      projectRoot: root.project_root,
      toolsHash: nextPrefix.tools_hash,
      systemHash: nextPrefix.system_hash,
    });
  }

  const resolution = resolveSessionIdentity({
    layers,
    explicitKey,
    explicitCandidate,
    explicitPredecessor,
    candidates,
    policy,
  });
  notes.push(...resolution.notes);
  // The resolver raises labels too (a softened prefix verdict says so with one), and a
  // label it raised has to reach the turn row or the softening would be invisible.
  labels.push(...resolution.labels);

  // ---- 3. Lock, but only when writing into a session another writer may hold. A
  // session this turn is about to create cannot be contended: nobody knows its id yet.
  let confidence = resolution.confidence;
  let lock = null;
  const continuing = resolution.action === RESOLUTION_ACTION.CONTINUE && resolution.session_id;

  if (continuing) {
    lock = await acquireSessionLock({
      db,
      sessionId: resolution.session_id,
      owner,
      clock,
      policy,
      ...(sleep ? { sleep } : {}),
    });
    if (!lock.acquired) {
      confidence = degradeConfidence(confidence);
      labels.push(M1_LABELS.IDENTITY_DEGRADED_BY_LOCK);
    }
    if (lock.took_over) notes.push("stale_lock_taken_over");
  }

  try {
    return writeObservation({
      store,
      request,
      clock,
      policy,
      newId,
      layers,
      nextPrefix,
      root,
      resolution,
      confidence,
      labels,
      notes,
      lock,
    });
  } finally {
    if (continuing && lock?.acquired) releaseSessionLock(db, { sessionId: resolution.session_id, owner });
  }
}

/**
 * The whole persistence step, in one transaction: close a predecessor if the evidence
 * demands it, create or update the session, insert the turn, replace the prefix state.
 *
 * One transaction because a turn whose prefix state did not land would make the *next*
 * turn compare against stale evidence and report a false divergence; a session row
 * without its turn would inflate the turn count. Either half alone is a lie about what
 * happened, so both commit together or neither does.
 */
function writeObservation({
  store,
  request,
  clock,
  policy,
  newId,
  layers,
  nextPrefix,
  root,
  resolution,
  confidence,
  labels,
  notes,
  lock,
}) {
  const { db, sessions, turns, prefixState } = store;
  const at = clock.now();

  return db.transaction(() => {
    let createdSession = false;
    let closedPredecessor = null;
    let sessionId = resolution.session_id;

    // A proven discontinuity on an explicitly identified session: the predecessor is
    // closed with the reason the evidence supports (§5), never with a guess. The
    // repository's `closed_at IS NULL` guard makes this idempotent under a race.
    if (resolution.close_predecessor) {
      sessions.closeSession(db, {
        id: resolution.close_predecessor.session_id,
        closed_at: at,
        close_reason: resolution.close_predecessor.reason,
      });
      closedPredecessor = { ...resolution.close_predecessor };
    }

    if (resolution.action === RESOLUTION_ACTION.OPEN || !sessionId) {
      sessionId = newId();
      sessions.insertSession(db, {
        id: sessionId,
        project_root: root.project_root,
        project_root_hashed: root.hashed,
        identity_confidence: confidence,
        identity_source: resolution.source,
        client_key: resolution.client_key,
        predecessor_id: resolution.predecessor_id,
        state: "active",
        opened_at: at,
        last_seen_at: at,
        turn_count: 0,
      });
      createdSession = true;
    }

    const idx = turns.insertTurnAtNextIndex(db, {
      session_id: sessionId,
      at,
      ...turnLayerFields(layers),
      identity_confidence: confidence,
      identity_source: resolution.source,
      relation: resolution.relation,
      divergence_index: resolution.divergence_index,
      prefix_rule_version: resolution.prefix_rule_version,
      strict_relation: resolution.strict_relation,
      strict_divergence_index: resolution.strict_divergence_index,
      invalidated_layers: serializeLayerList(resolution.invalidated) || null,
      boundary: resolution.boundary,
      labels: joinList(labels),
      notes: joinList(notes),
      protocol: request.protocol ?? null,
      requested_model: request.model ?? null,
    });

    prefixState.upsertPrefixState(db, {
      session_id: sessionId,
      updated_at: at,
      turn_idx: idx,
      prefix: nextPrefix,
      maxDigests: policy.maxChainMessages,
    });

    // The session row carries the best grade this session ever earned. A turn that was
    // degraded by a lock, or a weakly inferred turn on a session that was once
    // explicit, must not downgrade it — that would let contention silently rewrite
    // history. Strengthening is allowed; weakening is not.
    if (!createdSession) {
      const current = sessions.getSession(db, sessionId);
      const strengthen = current && !atLeastAsStrong(current.identity_confidence, confidence);
      sessions.updateSessionActivity(db, {
        id: sessionId,
        last_seen_at: at,
        turn_count: idx + 1,
        identity_confidence: strengthen ? confidence : null,
        identity_source: strengthen ? resolution.source : null,
        state: "active",
      });
    } else {
      sessions.updateSessionActivity(db, { id: sessionId, last_seen_at: at, turn_count: idx + 1 });
    }

    return {
      observed: true,
      session_id: sessionId,
      turn_idx: idx,
      at,
      created_session: createdSession,
      closed_predecessor: closedPredecessor,
      predecessor_id: resolution.predecessor_id,
      identity_confidence: confidence,
      identity_confidence_resolved: resolution.confidence,
      identity_source: resolution.source,
      relation: resolution.relation,
      divergence_index: resolution.divergence_index,
      prefix_rule_version: resolution.prefix_rule_version,
      strict_relation: resolution.strict_relation,
      strict_divergence_index: resolution.strict_divergence_index,
      boundary: resolution.boundary,
      compaction: resolution.compaction,
      invalidated: resolution.invalidated,
      changed: resolution.changed,
      labels: [...labels],
      notes: [...notes],
      lock: lock ? { acquired: lock.acquired, took_over: lock.took_over, waited_ms: lock.waited_ms } : null,
      layers: prefixLayerSummary(layers),
      project_root_hashed: root.hashed,
    };
  });
}

export default observeTurn;
