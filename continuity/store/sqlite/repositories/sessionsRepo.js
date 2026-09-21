/**
 * sessionsRepo — parameterized reads and writes for `sessions`.
 *
 * Every value reaches SQLite as a bound parameter. No identifier and no value is
 * ever interpolated into SQL text, which is the structural half of the §2 promise
 * that a session id can never become an injection vector (the other half is the
 * charset whitelist in identity/sessionId.js).
 *
 * The repository holds no policy. It does not decide what a candidate is, when to
 * close, or which confidence wins: it answers questions and writes rows. That is
 * what keeps the decisions in the pure resolver where they can be tested without
 * a database.
 *
 * Handle contract: `run/get/all/transaction` as provided by the host adapter.
 */

const SESSION_COLUMNS = `id, project_root, project_root_hashed, identity_confidence, identity_source,
  client_key, predecessor_id, state, opened_at, last_seen_at, turn_count, closed_at, close_reason,
  pin_provider, pin_model, pinned_at, lock_owner, lock_at`;

/** Insert a new session row. All columns explicit; nothing defaulted silently. */
export function insertSession(db, s) {
  db.run(
    `INSERT INTO sessions (
       id, project_root, project_root_hashed, identity_confidence, identity_source,
       client_key, predecessor_id, state, opened_at, last_seen_at, turn_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      s.project_root,
      s.project_root_hashed ? 1 : 0,
      s.identity_confidence,
      s.identity_source,
      s.client_key ?? null,
      s.predecessor_id ?? null,
      s.state ?? "active",
      s.opened_at,
      s.last_seen_at ?? s.opened_at,
      s.turn_count ?? 0,
    ],
  );
  return s.id;
}

export function getSession(db, id) {
  return db.get(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, [id]) ?? null;
}

/** The open session carrying this client key, most recently active first. */
export function findOpenByClientKey(db, clientKey) {
  if (!clientKey) return null;
  return (
    db.get(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE client_key = ? AND closed_at IS NULL
        ORDER BY last_seen_at DESC, opened_at DESC LIMIT 1`,
      [clientKey],
    ) ?? null
  );
}

/** The most recently closed session carrying this key. Lineage only. */
export function findLatestClosedByClientKey(db, clientKey) {
  if (!clientKey) return null;
  return (
    db.get(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE client_key = ? AND closed_at IS NOT NULL
        ORDER BY closed_at DESC LIMIT 1`,
      [clientKey],
    ) ?? null
  );
}

/**
 * The columns every candidate query selects, and the mapper that turns a flat row into
 * the `{session, prefix}` pair the resolver compares.
 *
 * Shared by both candidate queries on purpose: the layer-scoped and project-scoped
 * lookups must hand the resolver byte-identical shapes, or a candidate would be judged
 * differently depending on which query found it. `final_digest_norm` and
 * `penultimate_digest_norm` are selected here as well as in prefixStateRepo because
 * this is the *inferred* path: a candidate that arrives without them can only be judged
 * strictly, which is how the moved-cache-breakpoint rule silently stopped applying to
 * real traffic.
 */
const CANDIDATE_COLUMNS = `s.id AS s_id, s.project_root, s.project_root_hashed, s.identity_confidence,
              s.identity_source, s.client_key, s.predecessor_id, s.state, s.opened_at,
              s.last_seen_at, s.turn_count, s.closed_at, s.close_reason,
              p.turn_idx, p.updated_at, p.tools_hash, p.system_hash, p.messages_hash,
              p.message_count, p.tools_tokens, p.system_tokens, p.messages_tokens,
              p.digests_json, p.digests_truncated,
              p.final_digest_norm, p.penultimate_digest_norm, p.prefix_rule_version`;

function mapCandidate(r) {
  return {
    session: {
      id: r.s_id,
      project_root: r.project_root,
      project_root_hashed: r.project_root_hashed,
      identity_confidence: r.identity_confidence,
      identity_source: r.identity_source,
      client_key: r.client_key,
      predecessor_id: r.predecessor_id,
      state: r.state,
      opened_at: r.opened_at,
      last_seen_at: r.last_seen_at,
      turn_count: r.turn_count,
      closed_at: r.closed_at,
      close_reason: r.close_reason,
    },
    prefix: {
      session_id: r.s_id,
      turn_idx: r.turn_idx,
      updated_at: r.updated_at,
      tools_hash: r.tools_hash,
      system_hash: r.system_hash,
      messages_hash: r.messages_hash,
      message_count: r.message_count,
      tools_tokens: r.tools_tokens,
      system_tokens: r.system_tokens,
      messages_tokens: r.messages_tokens,
      digests: r.digests_json ? safeParseArray(r.digests_json) : null,
      digests_truncated: !!r.digests_truncated,
      final_digest_norm: r.final_digest_norm ?? null,
      penultimate_digest_norm: r.penultimate_digest_norm ?? null,
      prefix_rule_version: r.prefix_rule_version ?? null,
    },
  };
}

/**
 * Open sessions in this project whose recorded tools AND system hashes match the
 * turn being observed.
 *
 * Retained for callers that genuinely want front-layer-scoped candidates (and for the
 * tests that pin that behaviour). It is NO LONGER the lookup the observer uses for
 * inferred identity: requiring exact front-layer equality here meant a conversation
 * that added an MCP tool mid-flight had its own predecessor filtered out before any
 * comparison could run, so the change surfaced as a new session rather than as a
 * recorded front-layer invalidation. See `findOpenCandidatesByProject`.
 *
 * Rows come back as `{session, prefix}` pairs, most recently active first, so the
 * order is deterministic; the resolver refuses to choose between two matches, so
 * the order is for reporting rather than selection.
 */
export function findOpenCandidatesByLayers(db, { projectRoot, toolsHash, systemHash, limit = 20 } = {}) {
  const rows =
    db.all(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM sessions s
         JOIN session_prefix p ON p.session_id = s.id
        WHERE s.closed_at IS NULL
          AND s.project_root = ?
          AND p.tools_hash IS ?
          AND p.system_hash IS ?
        ORDER BY s.last_seen_at DESC, s.opened_at DESC
        LIMIT ?`,
      [projectRoot, toolsHash ?? null, systemHash ?? null, limit],
    ) || [];

  return rows.map(mapCandidate);
}

/**
 * Open sessions in this project, whatever their recorded front-layer hashes are.
 *
 * This is lineage *discovery*, deliberately separated from front-layer *compatibility*:
 * the question "could this turn belong to an existing lineage?" is answered by the
 * messages-layer prefix proof in the resolver, not by tools/system equality in SQL. A
 * predicate that cannot be reached by a test is not an invariant, and this one was
 * silently deciding identity.
 *
 * `project_root` remains as a scope, not as identity. It bounds how many rows the
 * engine has to compare and keeps two unrelated repositories apart; it never on its own
 * makes two turns the same lineage — that still requires the prefix proof, which is why
 * an unrelated conversation in the same project is still a new session.
 *
 * Ordering is `last_seen_at DESC` for determinism and reporting only. The resolver
 * refuses to choose when more than one candidate is plausible, so "most recent" never
 * becomes a tie-break: nearest-in-time is not evidence of lineage.
 */
export function findOpenCandidatesByProject(db, { projectRoot, limit = 20 } = {}) {
  const rows =
    db.all(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM sessions s
         JOIN session_prefix p ON p.session_id = s.id
        WHERE s.closed_at IS NULL
          AND s.project_root = ?
        ORDER BY s.last_seen_at DESC, s.opened_at DESC
        LIMIT ?`,
      [projectRoot, limit],
    ) || [];

  return rows.map(mapCandidate);
}

function safeParseArray(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    // A corrupt row must degrade to "no evidence", never to a thrown request.
    return null;
  }
}

/**
 * Record activity on a session. `identity_confidence`/`identity_source` are written
 * only when supplied, so a weak turn cannot silently overwrite the grade an earlier
 * explicit turn earned — the caller decides, having compared the two.
 */
export function updateSessionActivity(db, { id, last_seen_at, turn_count, identity_confidence, identity_source, state }) {
  const sets = ["last_seen_at = ?"];
  const params = [last_seen_at];
  if (Number.isInteger(turn_count)) {
    sets.push("turn_count = ?");
    params.push(turn_count);
  }
  if (identity_confidence) {
    sets.push("identity_confidence = ?");
    params.push(identity_confidence);
  }
  if (identity_source) {
    sets.push("identity_source = ?");
    params.push(identity_source);
  }
  if (state) {
    sets.push("state = ?");
    params.push(state);
  }
  params.push(id);
  db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ? AND closed_at IS NULL`, params);
}

/**
 * Close a session. The `closed_at IS NULL` guard is what makes this safe to call
 * twice and what enforces §4.3: a closed session is never re-closed with a second
 * reason, so the recorded reason is always the first true one.
 */
export function closeSession(db, { id, closed_at, close_reason }) {
  db.run(
    `UPDATE sessions
        SET closed_at = ?, close_reason = ?, state = 'closed', lock_owner = NULL, lock_at = NULL
      WHERE id = ? AND closed_at IS NULL`,
    [closed_at, close_reason, id],
  );
}

/** Open sessions whose last activity is at or before `cutoff`. Sweeper input. */
export function listIdleOpenSessions(db, cutoff, limit = 500) {
  return (
    db.all(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE closed_at IS NULL AND COALESCE(last_seen_at, opened_at) <= ?
        ORDER BY COALESCE(last_seen_at, opened_at) ASC LIMIT ?`,
      [cutoff, limit],
    ) || []
  );
}

/** Inspection listing (§13). Newest activity first. */
export function listSessions(db, { includeClosed = true, projectRoot = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (!includeClosed) where.push("closed_at IS NULL");
  if (projectRoot) {
    where.push("project_root = ?");
    params.push(projectRoot);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  return (
    db.all(
      `SELECT ${SESSION_COLUMNS} FROM sessions ${clause}
        ORDER BY COALESCE(last_seen_at, opened_at) DESC LIMIT ?`,
      params,
    ) || []
  );
}

export function countSessions(db, { openOnly = false } = {}) {
  const row = openOnly
    ? db.get(`SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL`)
    : db.get(`SELECT COUNT(*) AS n FROM sessions`);
  return row?.n ?? 0;
}

/** Retention: delete sessions closed before `cutoff`. Turns cascade. */
export function deleteSessionsClosedBefore(db, cutoff) {
  db.run(`DELETE FROM sessions WHERE closed_at IS NOT NULL AND closed_at < ?`, [cutoff]);
}

export default {
  insertSession,
  getSession,
  findOpenByClientKey,
  findLatestClosedByClientKey,
  findOpenCandidatesByLayers,
  findOpenCandidatesByProject,
  updateSessionActivity,
  closeSession,
  listIdleOpenSessions,
  listSessions,
  countSessions,
  deleteSessionsClosedBefore,
};
