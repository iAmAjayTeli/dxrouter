/**
 * Continuity store migration runner.
 *
 * Deliberately small and deliberately dumb:
 *  - forward-only, one numbered migration at a time, each in its own transaction;
 *  - the version lives in a single `_meta` row (`schema_version`);
 *  - a database stamped NEWER than this build refuses to open rather than being
 *    "fixed" (that database belongs to a newer dxrouter; opening it read-write
 *    would corrupt columns this build does not know about);
 *  - no ORM, no auto-derived DDL, no destructive step without an explicit flag.
 *
 * The pre-migration backup is an injected callback: taking it requires knowing the
 * file path, and a file path is exactly the kind of host knowledge that must not
 * leak into `continuity/` (I1). The adapter owns it.
 *
 * The `db` handle is likewise injected. Its contract (the inherited SQLite adapter
 * shape) is: exec(sql), run(sql, params), get(sql, params), all(sql, params),
 * transaction(fn).
 */

import { MIGRATIONS, assertMigrationsWellFormed, latestVersion } from "./migrations/index.js";
import { META_DDL, PRAGMA_STATEMENTS } from "./schema.js";

export const SCHEMA_VERSION_KEY = "schema_version";

export class ContinuityMigrationError extends Error {
  constructor(message, { code = "CONTINUITY_MIGRATION_FAILED", from = null, to = null } = {}) {
    super(message);
    this.name = "ContinuityMigrationError";
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

function assertHandle(db) {
  for (const fn of ["exec", "run", "get", "all", "transaction"]) {
    if (typeof db?.[fn] !== "function") {
      throw new ContinuityMigrationError(
        `continuity store handle is missing ${fn}()`,
        { code: "CONTINUITY_BAD_HANDLE" }
      );
    }
  }
}

/** Current stored version, 0 for a fresh database. */
export function getSchemaVersion(db) {
  try {
    const row = db.get(`SELECT value FROM _meta WHERE key = ?`, [SCHEMA_VERSION_KEY]);
    if (!row) return 0;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // `_meta` does not exist yet.
    return 0;
  }
}

function setSchemaVersion(db, version) {
  db.run(
    `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SCHEMA_VERSION_KEY, String(version)]
  );
}

export function applyPragmas(db) {
  for (const pragma of PRAGMA_STATEMENTS) {
    try {
      db.exec(pragma);
    } catch {
      // A driver may reject a pragma (sql.js has no WAL, for instance). None of
      // them are correctness-critical, so a rejection is not fatal.
    }
  }
}

/**
 * Bring `db` up to `latestVersion()`.
 *
 * @param {object} db store handle (see module comment)
 * @param {object} [opts]
 * @param {(info: {from: number, to: number}) => void} [opts.backup] called once,
 *        before the first migration, only when the database is NOT fresh
 * @param {(msg: string) => void} [opts.log]
 * @param {Array} [opts.migrations] override for tests
 * @returns {{from: number, to: number, applied: number, fresh: boolean}}
 */
export function migrateContinuityStore(db, { backup = null, log = null, migrations = MIGRATIONS } = {}) {
  assertHandle(db);
  assertMigrationsWellFormed(migrations);

  applyPragmas(db);
  db.exec(META_DDL);

  const from = getSchemaVersion(db);
  const target = migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);

  if (from > target) {
    throw new ContinuityMigrationError(
      `continuity store is at schema version ${from}, but this build only knows ${target}. ` +
        `Refusing to open it: a newer dxrouter wrote this database.`,
      { code: "CONTINUITY_SCHEMA_AHEAD", from, to: target }
    );
  }

  if (from === target) return { from, to: target, applied: 0, fresh: from === 0 };

  const fresh = from === 0;
  if (!fresh && typeof backup === "function") {
    // Best-effort: a failed backup must not leave the store un-migrated and the
    // process half-working, but the operator has to hear about it.
    try {
      backup({ from, to: target });
    } catch (e) {
      log?.(`[continuity][migrate] pre-migration backup failed (continuing): ${e.message}`);
    }
  }

  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    try {
      db.transaction(() => {
        m.up(db);
        setSchemaVersion(db, m.version);
      });
    } catch (e) {
      throw new ContinuityMigrationError(
        `continuity migration ${m.version} (${m.name}) failed: ${e.message}`,
        { code: "CONTINUITY_MIGRATION_FAILED", from, to: m.version }
      );
    }
    log?.(`[continuity][migrate] applied #${m.version} ${m.name}`);
  }

  return { from, to: target, applied: pending.length, fresh };
}

export { latestVersion };
