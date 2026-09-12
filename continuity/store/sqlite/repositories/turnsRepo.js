/**
 * turnsRepo — the append-only per-turn record (§10).
 *
 * What is written: hashes, counts, provenance, the identity grade, the prefix
 * relation and boundary metadata. What is never written: a request body, a prompt,
 * a tool name, a file path, a model output. §14 makes that a rule; the column list
 * below makes it a fact — there is no column a body could go in.
 *
 * `PRIMARY KEY (session_id, idx)` means the index must be allocated inside the same
 * transaction as the insert, otherwise two concurrent turns on one session both read
 * the same MAX(idx) and the second insert fails. `nextTurnIndex` is therefore only
 * correct when called inside `db.transaction` — `insertTurnAtNextIndex` does that
 * for callers and is the function the observer uses.
 */

const TURN_COLUMNS = `session_id, idx, at, tools_hash, system_hash, messages_hash,
  tools_tokens, system_tokens, messages_tokens, tokens_in, tokens_out,
  identity_confidence, identity_source, message_count,
  tools_tokens_provenance, system_tokens_provenance, messages_tokens_provenance,
  token_estimator, relation, divergence_index, invalidated_layers, boundary,
  labels, notes, protocol, requested_model,
  prefix_rule_version, strict_relation, strict_divergence_index`;

/** Next free index for this session. Call inside the write transaction. */
export function nextTurnIndex(db, sessionId) {
  const row = db.get(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM turns WHERE session_id = ?`, [sessionId]);
  return row?.next ?? 0;
}

/** Insert one turn at an explicit index. */
export function insertTurn(db, t) {
  db.run(
    `INSERT INTO turns (${TURN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.session_id,
      t.idx,
      t.at,
      t.tools_hash ?? null,
      t.system_hash ?? null,
      t.messages_hash ?? null,
      t.tools_tokens ?? null,
      t.system_tokens ?? null,
      t.messages_tokens ?? null,
      // tokens_in/tokens_out belong to a response. M1 observes requests only, so they
      // stay null rather than being guessed from the estimator.
      t.tokens_in ?? null,
      t.tokens_out ?? null,
      t.identity_confidence ?? null,
      t.identity_source ?? null,
      t.message_count ?? null,
      t.tools_tokens_provenance ?? null,
      t.system_tokens_provenance ?? null,
      t.messages_tokens_provenance ?? null,
      t.token_estimator ?? null,
      t.relation ?? null,
      Number.isInteger(t.divergence_index) ? t.divergence_index : null,
      t.invalidated_layers ?? null,
      t.boundary ?? null,
      t.labels ?? null,
      t.notes ?? null,
      t.protocol ?? null,
      t.requested_model ?? null,
      // Which normalization rule was in force, and what the strict test said. `relation`
      // above is the verdict identity was resolved on; these say whether the strict
      // comparison agreed, so a stored observation is never ambiguous about its rule.
      t.prefix_rule_version ?? null,
      t.strict_relation ?? null,
      Number.isInteger(t.strict_divergence_index) ? t.strict_divergence_index : null,
    ],
  );
  return t.idx;
}

/** Allocate the index and insert, both inside the caller's transaction. */
export function insertTurnAtNextIndex(db, turn) {
  const idx = nextTurnIndex(db, turn.session_id);
  insertTurn(db, { ...turn, idx });
  return idx;
}

export function countTurns(db, sessionId) {
  const row = db.get(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?`, [sessionId]);
  return row?.n ?? 0;
}

export function getTurn(db, sessionId, idx) {
  return db.get(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND idx = ?`, [sessionId, idx]) ?? null;
}

export function listTurns(db, sessionId, { limit = 100, ascending = true } = {}) {
  return (
    db.all(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ?
        ORDER BY idx ${ascending ? "ASC" : "DESC"} LIMIT ?`,
      [sessionId, limit],
    ) || []
  );
}

/** The most recent turn of a session, or null. */
export function latestTurn(db, sessionId) {
  return db.get(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY idx DESC LIMIT 1`, [sessionId]) ?? null;
}

/**
 * Every observed turn in a time window, across sessions, ordered so a reader can walk one
 * session at a time — the M1-side analogue of `turnResultsRepo.routeSequence`.
 *
 * `prefix_stability` (§19.4, Q2) needs the real observed prefix history, and the only way
 * to get it per-session was `listTurns` inside a loop over `listSessions`, which cannot
 * honour a `--window`: `sessions` has no `at`. This reads the window off `turns.at`
 * (indexed by `ix_turns_at`) and leaves the grouping to the caller.
 *
 * Deliberately not "sessions with their turns": the join would have to decide what to do
 * with a session whose earlier turns fell outside the window, and that is a measurement
 * decision, not a storage one. This returns rows.
 */
export function listTurnsSince(db, { since = 0, limit = 20000 } = {}) {
  return (
    db.all(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE at >= ?
        ORDER BY session_id, idx LIMIT ?`,
      [since, limit],
    ) || []
  );
}

/** Retention (§12.3): turns older than `cutoff` go, whatever their session. */
export function deleteTurnsBefore(db, cutoff) {
  db.run(`DELETE FROM turns WHERE at < ?`, [cutoff]);
}

export function countAllTurns(db) {
  const row = db.get(`SELECT COUNT(*) AS n FROM turns`);
  return row?.n ?? 0;
}

export default {
  nextTurnIndex,
  insertTurn,
  insertTurnAtNextIndex,
  countTurns,
  getTurn,
  listTurns,
  listTurnsSince,
  latestTurn,
  deleteTurnsBefore,
  countAllTurns,
};
