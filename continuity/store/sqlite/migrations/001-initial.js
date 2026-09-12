/**
 * Migration 001 — create the continuity schema.
 *
 * `up` receives a store handle shaped like the inherited SQLite adapter
 * (`exec`, `run`, `get`, `all`, `transaction`) and is already inside a
 * transaction opened by the runner. It must not open its own.
 */

import { CORE_DDL, FUTURE_DDL, META_DDL } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  up(db) {
    db.exec(META_DDL);
    for (const stmt of CORE_DDL) db.exec(stmt);
    // Future-milestone tables are created here, empty, and stay that way until the
    // milestone that owns them lands. See schema.js.
    for (const stmt of FUTURE_DDL) db.exec(stmt);
  },
};
