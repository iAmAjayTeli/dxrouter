/**
 * Continuity store — open + migrate, plus the M1 and M2 repositories.
 *
 * M0 built the container; M1 filled three tables (`sessions`, `turns`, `session_prefix`)
 * and M2 adds four more (`cache_entries`, `turn_results`, and the evidence pair
 * `experiments` / `fixtures`). Still nothing here writes a decision or a candidate:
 * those tables stay empty until the milestone that owns them, and their existence is not
 * permission to use them.
 *
 * The SQLite handle is injected, never opened here — opening it needs a file path,
 * and file paths live in the host adapter (I1).
 */

import {
  ALL_TABLES,
  CONTINUITY_SCHEMA_VERSION,
  CORE_TABLES,
  FUTURE_TABLES,
  M1_TABLES,
  M2_TABLES,
} from "./schema.js";
import { ContinuityMigrationError, getSchemaVersion, migrateContinuityStore } from "./migrate.js";
import * as sessionsRepo from "./repositories/sessionsRepo.js";
import * as turnsRepo from "./repositories/turnsRepo.js";
import * as prefixStateRepo from "./repositories/prefixStateRepo.js";
import * as cacheRepo from "./repositories/cacheRepo.js";
import * as turnResultsRepo from "./repositories/turnResultsRepo.js";
import * as experimentsRepo from "./repositories/experimentsRepo.js";
import * as fixturesRepo from "./repositories/fixturesRepo.js";

/**
 * @param {object} opts
 * @param {object} opts.db store handle: exec/run/get/all/transaction
 * @param {(info: {from: number, to: number}) => void} [opts.backup]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{db: object, schemaVersion: number, migration: object, tables: string[]}}
 */
export function openContinuityStore({ db, backup = null, log = null } = {}) {
  if (!db) {
    throw new ContinuityMigrationError("openContinuityStore requires a db handle", {
      code: "CONTINUITY_BAD_HANDLE",
    });
  }
  const migration = migrateContinuityStore(db, { backup, log });
  return {
    db,
    schemaVersion: getSchemaVersion(db),
    migration,
    tables: [...ALL_TABLES],
    sessions: sessionsRepo,
    turns: turnsRepo,
    prefixState: prefixStateRepo,
    cache: cacheRepo,
    turnResults: turnResultsRepo,
    experiments: experimentsRepo,
    fixtures: fixturesRepo,
  };
}

export {
  ALL_TABLES,
  CONTINUITY_SCHEMA_VERSION,
  ContinuityMigrationError,
  CORE_TABLES,
  FUTURE_TABLES,
  M1_TABLES,
  M2_TABLES,
  getSchemaVersion,
  migrateContinuityStore,
  sessionsRepo,
  turnsRepo,
  prefixStateRepo,
  cacheRepo,
  turnResultsRepo,
  experimentsRepo,
  fixturesRepo,
};
