/**
 * Migration 006 — the second boundary digest that prefix rule `r2` needs.
 *
 * One nullable column on `session_prefix`: `penultimate_digest_norm`.
 *
 * Rule `r1` tolerated a moved `cache_control` breakpoint at exactly the previous
 * request's final message, and `final_digest_norm` (migration 005) is the one value that
 * re-test needs. A six-request capture of one real Claude Code stream-json conversation
 * then measured the same client keeping TWO rolling breakpoints — one on the newest
 * assistant block, one on the newest `tool_result` — so when both roll forward a
 * genuinely continuing request differs at `message_count - 1` AND `message_count - 2`.
 * Every differing JSON path in that capture was exactly `…content[0].cache_control`
 * going from `{"type":"ephemeral"}` to absent, and `stripBookkeeping` restored exact
 * digest equality in every changed message. Rule `r2` therefore widens the tolerated
 * position to those two indices and nothing else (`continuity/prefix/bookkeeping.js`).
 *
 * The column is required rather than derivable: `session_prefix` stores digests and
 * never messages, so a position that was not recorded at write time cannot be recovered
 * later. One extra digest per turn, from the accessor that already memoises them; there
 * is still exactly one digest chain.
 *
 * Same discipline as 002–005: `ALTER TABLE ADD COLUMN` only, nullable with no default,
 * guarded by a `PRAGMA table_info` read so a half-applied database can be re-run.
 * Nothing is dropped, rewritten or back-filled, and no existing hash changes meaning —
 * `CANON_VERSION` is still "c1" and every `messages_hash`, `digests_json` entry,
 * `final_digest_norm` and `relation` already stored keeps exactly the value and the
 * meaning it had.
 *
 * Existing rows get NULL, which is the truthful value and also the safety property: a
 * row written under `r1` has no penultimate digest, so `prefix/extension.js` fails
 * closed on the two-position path for it and the strict divergence stands. An old
 * observation is never retroactively reinterpreted as `r2` — its stored
 * `prefix_rule_version` is left exactly as written.
 *
 * `SESSION_PREFIX_DDL` still describes the table as it shipped, so a fresh database gets
 * this column from this migration the same way an upgraded one does.
 *
 * Runs inside the transaction the migration runner opened. It must not open its own.
 */

import { PREFIX_R2_SESSION_PREFIX_COLUMNS } from "../schema.js";

function existingColumns(db, table) {
  const rows = db.all(`PRAGMA table_info(${table})`) || [];
  return new Set(rows.map((r) => r.name));
}

function addMissingColumns(db, table, columns) {
  const present = existingColumns(db, table);
  for (const [name, ddl] of columns) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

export default {
  version: 6,
  name: "prefix-penultimate-norm",
  up(db) {
    addMissingColumns(db, "session_prefix", PREFIX_R2_SESSION_PREFIX_COLUMNS);
  },
};
