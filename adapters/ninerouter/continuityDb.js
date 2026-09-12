/**
 * `continuityDb` — opens the continuity SQLite file and hands the store a handle.
 *
 * ### Why a separate file from `data.sqlite`
 *
 * The continuity store and 9Router's store version independently: bumping
 * `SCHEMA_VERSION` in `src/lib/db/schema.js` must not trigger a continuity
 * migration, and vice versa. Sharing one file would couple two migration chains
 * with different owners, and the first accidental interleaving would be a data
 * incident. So: `DXR_DATA_DIR/db/continuity.sqlite`, alongside `data.sqlite`,
 * inside the one data root M0 requires. No second root, no repo-relative path.
 *
 * ### Why this file is in `adapters/` and not `continuity/`
 *
 * File paths, the driver fallback chain and `fs` are host knowledge. `continuity/`
 * receives an already-open handle and a `backup()` callback, which is what lets I1
 * hold as a structural fact rather than a convention: there is nothing in the
 * engine's reach that *could* name a path.
 *
 * The `src/` imports here are relative rather than `@/`-aliased so this file also
 * loads under bare node, which is what lets the `dxrouter sessions` CLI (§13) open
 * the very same database, with the same driver chain and the same migrations, instead
 * of re-deriving a path of its own.
 *
 * ### Backup
 *
 * A pre-migration file copy, only when the database already exists at an older
 * version. Unlike `backupDbLite`, this is a plain `copyFileSync`: the continuity
 * DB has no oversized observability table to skip, and a byte copy is the one
 * backup that cannot be wrong. Recovery is manual — copy the file back — matching
 * the inherited behaviour documented in `src/lib/db/backup.js`.
 *
 * ### Diagnostics go to stderr
 *
 * Every line this file prints is a diagnostic, and `dxrouter sessions --json` (§13)
 * writes machine-readable output to stdout from this same process. A driver banner
 * on stdout would sit in front of that JSON and break every consumer of it, so the
 * banner, the migration log and the backup notice all use stderr.
 */

import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, DB_DIR, ensureDirs } from "../../src/lib/db/paths.js";
import { timestampSlug } from "../../src/lib/db/version.js";
import { openContinuityStore } from "../../continuity/store/index.js";

/** The continuity database file. One data root, one predictable location. */
export const CONTINUITY_FILE = path.join(DB_DIR, "continuity.sqlite");

/** Survives Next.js dev hot-reload, like `src/lib/db/driver.js` does. */
if (!global._dxrContinuityDb) global._dxrContinuityDb = { store: null, initPromise: null, logged: false };
const state = global._dxrContinuityDb;

async function tryAdapter(name, loader) {
  try {
    const adapter = await loader();
    return adapter || null;
  } catch (e) {
    console.warn(`[DXR][continuity] ${name} unavailable: ${e.message}`);
    return null;
  }
}

/**
 * Same driver preference order as the host store, for the same reasons: native
 * first, built-in next, pure-JS last so a machine without build tools still works.
 */
export async function openContinuityAdapter(filePath = CONTINUITY_FILE) {
  ensureDirs();

  if (process.versions.bun) {
    const bun = await tryAdapter("bun:sqlite", async () => {
      const { createBunSqliteAdapter } = await import("../../src/lib/db/adapters/bunSqliteAdapter.js");
      return createBunSqliteAdapter(filePath);
    });
    if (bun) return bun;
  } else {
    const better = await tryAdapter("better-sqlite3", async () => {
      const { createBetterSqliteAdapter } = await import("../../src/lib/db/adapters/betterSqliteAdapter.js");
      return createBetterSqliteAdapter(filePath);
    });
    if (better) return better;

    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      const nodeSqlite = await tryAdapter("node:sqlite", async () => {
        const { createNodeSqliteAdapter } = await import("../../src/lib/db/adapters/nodeSqliteAdapter.js");
        return createNodeSqliteAdapter(filePath);
      });
      if (nodeSqlite) return nodeSqlite;
    }
  }

  const sqljs = await tryAdapter("sql.js", async () => {
    const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
    return createSqlJsAdapter(filePath);
  });
  if (sqljs) return sqljs;

  throw new Error("[DXR][continuity] no SQLite driver available (bun/better/node/sql.js all failed)");
}

/**
 * The `backup` callback the store calls before applying migrations to an existing
 * database. Injected, so the engine never learns a path.
 */
export function createContinuityBackup(filePath = CONTINUITY_FILE) {
  return ({ from, to }) => {
    if (!fs.existsSync(filePath)) return null;
    ensureDirs();
    const dir = path.join(BACKUPS_DIR, `continuity-v${from}-to-v${to}-${timestampSlug()}`);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "continuity.sqlite");
    fs.copyFileSync(filePath, dest);
    // WAL and shm are copied when present: restoring the main file alone can lose
    // the most recent committed transactions under a WAL-mode driver.
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${filePath}${suffix}`;
      if (fs.existsSync(side)) fs.copyFileSync(side, `${dest}${suffix}`);
    }
    console.error(`[DXR][continuity] pre-migration backup v${from} → v${to}: ${dest}`);
    return dest;
  };
}

/**
 * Open (and migrate) the continuity store. Memoised per process.
 *
 * M0: calling this creates an empty schema and nothing else. No request path
 * touches it, and no code writes a session, decision or cache entry — the DXR
 * engine is OFF and `accountFallback` remains authoritative.
 *
 * @returns {Promise<{db: object, schemaVersion: number, migration: object, tables: string[]}>}
 */
export async function getContinuityStore({ filePath = CONTINUITY_FILE } = {}) {
  if (state.store) return state.store;
  if (!state.initPromise) {
    state.initPromise = (async () => {
      const db = await openContinuityAdapter(filePath);
      const store = openContinuityStore({
        db,
        backup: createContinuityBackup(filePath),
        log: (msg) => console.error(`[DXR][continuity] ${msg}`),
      });
      if (!state.logged) {
        console.error(
          `[DXR][continuity] driver: ${db.driver} | file: ${filePath} | schema v${store.schemaVersion}`
        );
        state.logged = true;
      }
      state.store = store;
      return store;
    })();
  }
  return state.initPromise;
}

/** Test helper: drop the memoised handle so a fresh file can be opened. */
export function __resetContinuityStore() {
  state.store = null;
  state.initPromise = null;
  state.logged = false;
}

export default getContinuityStore;
