/**
 * Observed sessions — the real M1 record, projected into the shape a measure reduces.
 *
 * §19.4's Q2 asks how long a *real* coding session's cacheable prefix holds. Until this
 * file existed, `prefix_stability` could only reduce `replayFixture` output, so the only
 * population it could describe was a population somebody wrote. M1 has been persisting the
 * real thing all along — one `turns` row per observed request, carrying the per-layer
 * hashes, the prefix relation, and `invalidated_layers` exactly as `invalidatedLayers`
 * computed it on the live path.
 *
 * So this is a **reader, not a second representation**. Nothing here re-hashes anything,
 * re-derives an invalidation, or keeps its own notion of what a prefix is: the column is
 * parsed with `parseLayerList`, the inverse of the `serializeLayerList` the observer wrote
 * it with. If the two ever disagree the parse fails loudly rather than reporting a stable
 * prefix.
 *
 * Three honesty rules shape the output.
 *
 *  1. **`fixture_source: "observed"` is not a fixture source.** It is deliberately *not* a
 *     member of `FIXTURE_SOURCES`, so a fixture file cannot declare itself observed by
 *     writing a label, and observed traffic cannot be relabelled synthetic by a measure
 *     that only knows two values. §15's rule runs in both directions.
 *  2. **Project kind comes from the session's project root, or it is unknown.** Never from
 *     a prompt, a model name or a heuristic over content — this layer has no access to
 *     content and must not acquire one. A session whose root could not be resolved
 *     (`UNKNOWN_PROJECT_ROOT`, e.g. `project_root_hash_salt_missing`) yields
 *     `project_kind: null`, which the §23 three-kinds rule then does not count.
 *  3. **A window can truncate a session, and that is recorded.** `--window 7d` can put a
 *     session's later turns in range and its opening turns out of it. The prefix stretch
 *     running at the window edge is then *left*-censored: we do not know how long the front
 *     had already held. `truncated` says so, and the measure drops that leading run rather
 *     than counting it as a short one.
 *
 * No body, no prompt, no tool name and no file path passes through here — there is no
 * column any of them could come from (§14).
 */

import { UNKNOWN_PROJECT_ROOT } from "../identity/sessionId.js";
import { parseLayerList } from "../prefix/invalidation.js";

/**
 * The provenance value observed traffic carries. Kept apart from `FIXTURE_SOURCES` on
 * purpose; see rule 1 above.
 */
export const OBSERVED_SOURCE = "observed";

/** How a session's `project_kind` was arrived at. `unknown` is a real answer. */
export const PROJECT_KIND_SOURCES = Object.freeze(["project_root", "project_root_hash", "unknown"]);

/**
 * The project kind of a session, and where it came from.
 *
 * A hashed root (`DXR_HASH_PROJECT_PATHS`) is a perfectly good grouping key — it is stable
 * per project and reveals nothing — so it counts as a kind and says that it is a hash.
 */
export function projectKindOf(session) {
  const root = typeof session?.project_root === "string" ? session.project_root : null;
  if (!root || root === UNKNOWN_PROJECT_ROOT) return { project_kind: null, project_kind_source: "unknown" };
  return {
    project_kind: root,
    project_kind_source: session?.project_root_hashed ? "project_root_hash" : "project_root",
  };
}

/** One persisted `turns` row, as a measure's per-turn record. */
function projectTurn(row) {
  return Object.freeze({
    i: Number(row.idx),
    at: Number(row.at),
    // The live path's own list, read back through the writer's inverse.
    invalidated: Object.freeze(parseLayerList(row.invalidated_layers)),
    relation: row.relation ?? null,
    divergence_index: Number.isInteger(row.divergence_index) ? row.divergence_index : null,
    // The verdict above is the one identity was resolved on. These three say which
    // normalization rule was in force and what the strict, byte-for-byte comparison
    // said, so a measure can never be ambiguous about the rule behind a number. All
    // null on a turn recorded before the rule existed — where `relation` is strict by
    // construction — and nothing is back-filled to pretend otherwise.
    strict_relation: row.strict_relation ?? null,
    strict_divergence_index: Number.isInteger(row.strict_divergence_index) ? row.strict_divergence_index : null,
    prefix_rule_version: row.prefix_rule_version ?? null,
    boundary: row.boundary ?? null,
    identity_confidence: row.identity_confidence ?? null,
    layers: Object.freeze({
      tools_hash: row.tools_hash ?? null,
      system_hash: row.system_hash ?? null,
      messages_hash: row.messages_hash ?? null,
      tools_tokens: Number.isInteger(row.tools_tokens) ? row.tools_tokens : null,
      system_tokens: Number.isInteger(row.system_tokens) ? row.system_tokens : null,
      messages_tokens: Number.isInteger(row.messages_tokens) ? row.messages_tokens : null,
    }),
    // No `belief` key, and that is the point: M1 observes requests and keeps no cache
    // ledger, so there is nothing here to say a prefix was warm. A measure must report
    // that as unavailable rather than as zero warm turns (I4).
  });
}

/**
 * Every observed session in the window, newest activity irrelevant — ordering is by
 * session then turn index, because a run is a sequence.
 *
 * @param {object} args
 * @param {object} args.store an open continuity store
 * @param {number} [args.since] epoch ms; turns at or after this instant
 * @param {number} [args.limit] max sessions returned
 * @param {number} [args.maxTurns] row cap on the underlying read
 * @returns {Array<object>} one record per session, in the shape a measure reduces
 */
export function observedSessions({ store = null, since = 0, limit = 200, maxTurns = 20000 } = {}) {
  if (!store?.db || !store.turns?.listTurnsSince) return [];
  const rows = store.turns.listTurnsSince(store.db, { since, limit: maxTurns });

  const bySession = new Map();
  for (const row of rows) {
    if (!row?.session_id) continue;
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }

  const out = [];
  for (const [sessionId, turnRows] of bySession) {
    if (out.length >= limit) break;
    const session = store.sessions.getSession(store.db, sessionId);
    // A turn whose session was swept by retention is an orphan. Reporting it would mean
    // reporting a session with no project kind and no lifecycle, so it is dropped and
    // counted rather than guessed at.
    if (!session) continue;
    const turns = turnRows.map(projectTurn).sort((a, b) => a.i - b.i);
    const firstIdx = turns.length ? turns[0].i : null;

    out.push(
      Object.freeze({
        // `fixture_id` keeps its name because that is the field every measure already
        // reads as "which session is this". Its value is the session id, and
        // `fixture_source` says it is not a fixture at all.
        fixture_id: sessionId,
        session_id: sessionId,
        fixture_source: OBSERVED_SOURCE,
        ...projectKindOf(session),
        project_root_hashed: Boolean(session.project_root_hashed),
        state: session.state ?? null,
        opened_at: Number.isInteger(session.opened_at) ? session.opened_at : null,
        last_seen_at: Number.isInteger(session.last_seen_at) ? session.last_seen_at : null,
        closed_at: Number.isInteger(session.closed_at) ? session.closed_at : null,
        close_reason: session.close_reason ?? null,
        /** True when the window, not the session, decided where this record starts. */
        truncated: firstIdx !== null && firstIdx > 0,
        first_turn_idx: firstIdx,
        turns: Object.freeze(turns),
        n: turns.length,
      }),
    );
  }
  return out;
}

export default observedSessions;
