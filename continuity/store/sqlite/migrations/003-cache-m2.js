/**
 * Migration 003 — M2 cache state and evidence.
 *
 * Same discipline as 002: nullable or defaulted columns, one new table, guarded by a
 * `PRAGMA table_info` read so a half-applied database can be re-run. Nothing is
 * dropped, rewritten or back-filled — an M1 database opened by M2 code keeps every
 * row, and the released bodies of 001 and 002 are untouched.
 *
 * The one thing this migration deliberately does *not* do is relax
 * `attempts.decision_id`. SQLite cannot drop a NOT NULL without rebuilding the table,
 * and rebuilding a released table is the destructive step §12.3 rules out. M2's
 * observed provider results go to `turn_results` instead; see schema.js.
 *
 * Runs inside the transaction the migration runner opened. It must not open its own.
 */

import {
  M2_CACHE_ENTRY_COLUMNS,
  M2_EXPERIMENT_COLUMNS,
  M2_FIXTURE_COLUMNS,
  M2_INDICES,
  TURN_RESULTS_DDL,
} from "../schema.js";

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
  version: 3,
  name: "cache-m2",
  up(db) {
    addMissingColumns(db, "cache_entries", M2_CACHE_ENTRY_COLUMNS);
    addMissingColumns(db, "experiments", M2_EXPERIMENT_COLUMNS);
    addMissingColumns(db, "fixtures", M2_FIXTURE_COLUMNS);
    db.exec(TURN_RESULTS_DDL);
    for (const stmt of M2_INDICES) db.exec(stmt);
  },
};
