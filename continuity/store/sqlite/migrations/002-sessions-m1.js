/**
 * Migration 002 — M1 session identity and prefix layers.
 *
 * Forward-only and non-destructive, as §12.3 requires: it adds nullable/defaulted
 * columns and one new table, and rewrites nothing. Nothing is dropped, renamed or
 * back-filled, so an M0 database opened by M1 code keeps every row it had.
 *
 * `ADD COLUMN` is guarded by a `PRAGMA table_info` read rather than a try/catch,
 * because a swallowed exception here is indistinguishable from a real failure and
 * this file must be safely re-runnable on a half-applied database (a crash between
 * two ALTERs is the case that matters — the runner's transaction covers the common
 * path, but `sql.js` and `node:sqlite` differ in how much DDL they roll back).
 *
 * Runs inside the transaction the migration runner opened. It must not open its own.
 */

import { M1_INDICES, M1_SESSION_COLUMNS, M1_TURN_COLUMNS, SESSION_PREFIX_DDL } from "../schema.js";

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
  version: 2,
  name: "sessions-m1",
  up(db) {
    addMissingColumns(db, "sessions", M1_SESSION_COLUMNS);
    addMissingColumns(db, "turns", M1_TURN_COLUMNS);
    db.exec(SESSION_PREFIX_DDL);
    for (const stmt of M1_INDICES) db.exec(stmt);
  },
};
