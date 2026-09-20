/**
 * Ordered migration list. Forward-only: append, never edit or reorder a released
 * entry. `version` must equal the file's numeric prefix and increase by one.
 */

import m001 from "./001-initial.js";
import m002 from "./002-sessions-m1.js";
import m003 from "./003-cache-m2.js";
import m004 from "./004-attempt-outcome.js";
import m005 from "./005-prefix-rule-provenance.js";
import m006 from "./006-prefix-penultimate-norm.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006];

/** Highest version this build knows how to reach. */
export function latestVersion() {
  return MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

/**
 * Guard against a hand-edited list: gaps or duplicates would silently skip a
 * migration on some installs and not others.
 */
export function assertMigrationsWellFormed(migrations = MIGRATIONS) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`[continuity][migrate] migration #${i} has version ${m.version}, expected ${i + 1}`);
    }
    if (typeof m.up !== "function") {
      throw new Error(`[continuity][migrate] migration ${m.version} has no up()`);
    }
  });
  return true;
}
