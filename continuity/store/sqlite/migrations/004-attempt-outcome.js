/**
 * Migration 004 — how a provider attempt ended, on the observed result row.
 *
 * Four nullable columns on `turn_results` (`error_class`, `retry_after_s`, `ttfb_ms`,
 * `total_ms`), so a failed attempt is recorded as a failure rather than as a success that
 * happened to report no usage. §19.4's Q3 asks about *forced* moves — the in-turn
 * `accountFallback` retry — and without the failure side of the record there is nothing to
 * distinguish one from a route change somebody chose.
 *
 * Same discipline as 002 and 003: `ALTER TABLE ADD COLUMN` only, every column nullable
 * with no default, guarded by a `PRAGMA table_info` read so a half-applied database can be
 * re-run. Nothing is dropped, rewritten or back-filled. Existing rows get NULL in all four,
 * which is the truthful value: those attempts were observed by a build that did not record
 * timing or an error class, and inventing a zero for them would be exactly the fabricated
 * measurement I4 forbids.
 *
 * The released bodies of 001–003 are untouched, and `TURN_RESULTS_DDL` still describes the
 * table as it shipped — a fresh database gets these columns from this migration, the same
 * way an upgraded one does, so the two converge on one shape by one code path.
 *
 * Runs inside the transaction the migration runner opened. It must not open its own.
 */

import { M2_TURN_RESULT_OUTCOME_COLUMNS } from "../schema.js";

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
  version: 4,
  name: "attempt-outcome",
  up(db) {
    addMissingColumns(db, "turn_results", M2_TURN_RESULT_OUTCOME_COLUMNS);
  },
};
