/**
 * prefixStateRepo — one row per session holding the last observed prefix state.
 *
 * This is the memory the prefix-extension check reads. It stores hashes, counts and
 * per-message digests: never a message, never a role, never text. A digest is a
 * one-way function of canonical bytes, so the row is useless for reconstructing the
 * conversation and sufficient for proving continuity.
 *
 * The digest list is capped (policy `maxChainMessages`) and truncated from the tail,
 * because a divergence index is measured from the front of the sequence. When the cap
 * bites, `digests_truncated` is set: identity still resolves at full strength (the
 * proof uses the incoming request's own rolling chain against `messages_hash` and
 * `message_count`), only the reported divergence index may be unavailable.
 */

const PREFIX_COLUMNS = `session_id, updated_at, turn_idx, tools_hash, system_hash, messages_hash,
  message_count, tools_tokens, system_tokens, messages_tokens, digests_json, digests_truncated,
  final_digest_norm, penultimate_digest_norm, prefix_rule_version`;

/** Cap a digest list, keeping the opening messages. */
export function capDigests(digests, maxDigests) {
  if (!Array.isArray(digests)) return { digests: null, truncated: false };
  if (!Number.isInteger(maxDigests) || maxDigests <= 0 || digests.length <= maxDigests) {
    return { digests, truncated: false };
  }
  return { digests: digests.slice(0, maxDigests), truncated: true };
}

function parseDigests(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    // Corruption degrades to "no evidence", which the resolver already handles as
    // ambiguity. It must never throw out of an observation.
    return null;
  }
}

/** The recorded state, in the flat shape the resolver compares. */
export function getPrefixState(db, sessionId) {
  const r = db.get(`SELECT ${PREFIX_COLUMNS} FROM session_prefix WHERE session_id = ?`, [sessionId]);
  if (!r) return null;
  return {
    session_id: r.session_id,
    updated_at: r.updated_at,
    turn_idx: r.turn_idx,
    tools_hash: r.tools_hash,
    system_hash: r.system_hash,
    messages_hash: r.messages_hash,
    message_count: r.message_count,
    tools_tokens: r.tools_tokens,
    system_tokens: r.system_tokens,
    messages_tokens: r.messages_tokens,
    digests: parseDigests(r.digests_json),
    digests_truncated: !!r.digests_truncated,
    // The boundary re-test's inputs, and the rule that produced them. NULL on a row
    // written before the corresponding value was recorded, which leaves the strict
    // verdict standing — `penultimate_digest_norm` is NULL on every pre-r2 row, which is
    // what stops the two-position path from softening an old observation.
    final_digest_norm: r.final_digest_norm ?? null,
    penultimate_digest_norm: r.penultimate_digest_norm ?? null,
    prefix_rule_version: r.prefix_rule_version ?? null,
  };
}

/**
 * Write the latest state for a session. One row per session, so this replaces.
 *
 * @param {object} db store handle
 * @param {object} args
 * @param {string} args.session_id
 * @param {number} args.updated_at integer ms from the injected clock
 * @param {number} args.turn_idx the turn this state was observed on
 * @param {object} args.prefix flat prefix state (layersToPrefixState output)
 * @param {number} [args.maxDigests] cap from the session policy
 */
export function upsertPrefixState(db, { session_id, updated_at, turn_idx, prefix, maxDigests = 5000 }) {
  const { digests, truncated } = capDigests(prefix?.digests ?? null, maxDigests);
  db.run(
    `INSERT INTO session_prefix (${PREFIX_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       turn_idx = excluded.turn_idx,
       tools_hash = excluded.tools_hash,
       system_hash = excluded.system_hash,
       messages_hash = excluded.messages_hash,
       message_count = excluded.message_count,
       tools_tokens = excluded.tools_tokens,
       system_tokens = excluded.system_tokens,
       messages_tokens = excluded.messages_tokens,
       digests_json = excluded.digests_json,
       digests_truncated = excluded.digests_truncated,
       final_digest_norm = excluded.final_digest_norm,
       penultimate_digest_norm = excluded.penultimate_digest_norm,
       prefix_rule_version = excluded.prefix_rule_version`,
    [
      session_id,
      updated_at,
      turn_idx,
      prefix?.tools_hash ?? null,
      prefix?.system_hash ?? null,
      prefix?.messages_hash ?? null,
      Number.isInteger(prefix?.message_count) ? prefix.message_count : null,
      Number.isInteger(prefix?.tools_tokens) ? prefix.tools_tokens : null,
      Number.isInteger(prefix?.system_tokens) ? prefix.system_tokens : null,
      Number.isInteger(prefix?.messages_tokens) ? prefix.messages_tokens : null,
      digests ? JSON.stringify(digests) : null,
      truncated ? 1 : 0,
      // Not capped and not truncatable: one digest of one message each, and together
      // they are the only thing the next turn can re-test the r2 window against.
      prefix?.final_digest_norm ?? null,
      prefix?.penultimate_digest_norm ?? null,
      prefix?.prefix_rule_version ?? null,
    ],
  );
}

export function deletePrefixState(db, sessionId) {
  db.run(`DELETE FROM session_prefix WHERE session_id = ?`, [sessionId]);
}

export function countPrefixStates(db) {
  const row = db.get(`SELECT COUNT(*) AS n FROM session_prefix`);
  return row?.n ?? 0;
}

export default { capDigests, getPrefixState, upsertPrefixState, deletePrefixState, countPrefixStates };
