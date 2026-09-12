/**
 * Migration 005 — which prefix rule produced a stored observation.
 *
 * Five nullable columns: three on `turns` (`prefix_rule_version`, `strict_relation`,
 * `strict_divergence_index`) and two on `session_prefix` (`final_digest_norm`,
 * `prefix_rule_version`).
 *
 * They exist because the prefix comparison now has two verdicts. The strict,
 * byte-for-byte test is unchanged and still runs first; when it fails at exactly the
 * previous request's final message, that one message is re-tested with the enumerated
 * cache-bookkeeping fields removed (`continuity/prefix/bookkeeping.js`), because a real
 * client moves its `cache_control` breakpoint off the previously-final message and
 * would otherwise split a conversation that never ended. `final_digest_norm` is the one
 * value that re-test needs from the previous turn; the two `strict_*` columns keep the
 * unrelaxed verdict measurable; `prefix_rule_version` says which rule was in force.
 *
 * Same discipline as 002–004: `ALTER TABLE ADD COLUMN` only, every column nullable with
 * no default, guarded by a `PRAGMA table_info` read so a half-applied database can be
 * re-run. Nothing is dropped, rewritten or back-filled, and no existing hash changes
 * meaning — `CANON_VERSION` is still "c1" and every `messages_hash`, `digests_json`
 * entry and `relation` already stored keeps exactly the value and the meaning it had.
 *
 * Existing rows get NULL in all five, which is the truthful value: those turns were
 * observed by a build with no such rule, so their `relation` is strict by construction.
 * Back-filling a version onto them would assert something that was never measured.
 *
 * The released bodies of 001–004 are untouched, and `SESSION_PREFIX_DDL` still describes
 * the table as it shipped — a fresh database gets these columns from this migration the
 * same way an upgraded one does, so both converge on one shape by one code path.
 *
 * Runs inside the transaction the migration runner opened. It must not open its own.
 */

import { PREFIX_RULE_SESSION_PREFIX_COLUMNS, PREFIX_RULE_TURN_COLUMNS } from "../schema.js";

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
  version: 5,
  name: "prefix-rule-provenance",
  up(db) {
    addMissingColumns(db, "turns", PREFIX_RULE_TURN_COLUMNS);
    addMissingColumns(db, "session_prefix", PREFIX_RULE_SESSION_PREFIX_COLUMNS);
  },
};
