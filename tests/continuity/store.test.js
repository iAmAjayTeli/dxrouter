/**
 * Continuity store — migrations and schema shape.
 *
 * These run against a real SQLite file (the sql.js adapter, which is always
 * available), not a mock. The point of the milestone is that a fresh install gets
 * a correct schema on every driver, and a mock cannot tell you that column types
 * survived DDL.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import {
  CONTINUITY_SCHEMA_VERSION,
  CORE_TABLES,
  FUTURE_TABLES,
  MICRO_USD_COLUMNS,
} from "../../continuity/store/sqlite/schema.js";
import {
  ContinuityMigrationError,
  getSchemaVersion,
  migrateContinuityStore,
} from "../../continuity/store/sqlite/migrate.js";
import { openContinuityStore } from "../../continuity/store/index.js";
import { MIGRATIONS, assertMigrationsWellFormed, latestVersion } from "../../continuity/store/sqlite/migrations/index.js";

let tmpDir;

async function freshDb(name) {
  return createSqlJsAdapter(path.join(tmpDir, `${name}.sqlite`));
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-continuity-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("migration set", () => {
  it("is well formed (version equals position, every step has an up)", () => {
    expect(() => assertMigrationsWellFormed(MIGRATIONS)).not.toThrow();
    expect(latestVersion()).toBe(CONTINUITY_SCHEMA_VERSION);
  });
});

describe("fresh install", () => {
  it("creates the schema and reports itself fresh", async () => {
    const db = await freshDb("fresh");
    const result = migrateContinuityStore(db);

    expect(result.fresh).toBe(true);
    expect(result.from).toBe(0);
    expect(result.to).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(result.applied).toBeGreaterThan(0);
    expect(getSchemaVersion(db)).toBe(CONTINUITY_SCHEMA_VERSION);
  });

  it("does not take a backup — there is nothing to lose yet", async () => {
    const db = await freshDb("fresh-nobackup");
    let called = 0;
    migrateContinuityStore(db, { backup: () => { called += 1; } });
    expect(called).toBe(0);
  });

  it("creates every core table", async () => {
    const db = await freshDb("core");
    migrateContinuityStore(db);
    const names = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name);
    for (const table of CORE_TABLES) expect(names).toContain(table);
  });

  it("creates the future tables empty, and leaves them empty", async () => {
    const db = await freshDb("future");
    migrateContinuityStore(db);
    for (const table of FUTURE_TABLES) {
      const row = db.get(`SELECT COUNT(*) AS n FROM ${table}`);
      // Present, so a later milestone is a code change and not a migration
      // scramble; empty, because a table existing is not permission to use it.
      expect(row.n).toBe(0);
    }
  });

  it("declares money columns as INTEGER micro-USD, never REAL", async () => {
    const db = await freshDb("money");
    migrateContinuityStore(db);
    for (const [table, columns] of Object.entries(MICRO_USD_COLUMNS)) {
      const info = db.all(`PRAGMA table_info(${table})`);
      const byName = new Map(info.map((c) => [c.name, String(c.type).toUpperCase()]));
      for (const column of columns) {
        expect(byName.get(column), `${table}.${column} must exist`).toBeDefined();
        // Float money would make the canonical decision hash unstable across a
        // DB round-trip, which would break replay of a stored decision.
        expect(byName.get(column), `${table}.${column}`).toBe("INTEGER");
      }
    }
    for (const table of Object.keys(MICRO_USD_COLUMNS)) {
      const reals = db.all(`PRAGMA table_info(${table})`).filter((c) => String(c.type).toUpperCase() === "REAL");
      expect(reals).toEqual([]);
    }
  });
});

describe("re-running a migration", () => {
  it("is idempotent — a second pass applies nothing", async () => {
    const db = await freshDb("idempotent");
    migrateContinuityStore(db);
    const second = migrateContinuityStore(db);
    expect(second.applied).toBe(0);
    expect(second.from).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(second.to).toBe(CONTINUITY_SCHEMA_VERSION);
  });

  it("does not back up when there is nothing to apply", async () => {
    const db = await freshDb("idempotent-nobackup");
    migrateContinuityStore(db);
    let called = 0;
    migrateContinuityStore(db, { backup: () => { called += 1; } });
    expect(called).toBe(0);
  });
});

describe("upgrading an existing database", () => {
  // One step past the shipped chain, so there is a real N → N+1 upgrade to observe.
  // Derived from CONTINUITY_SCHEMA_VERSION rather than written as a number: every
  // milestone that adds a migration would otherwise silently invalidate these three
  // tests, which is exactly the class of staleness they exist to catch elsewhere.
  const SHIPPED = CONTINUITY_SCHEMA_VERSION;
  const nextStep = {
    version: SHIPPED + 1,
    name: "test-next-step",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS dxr_test_step_two(id TEXT PRIMARY KEY)`);
    },
  };

  it("backs up first, then applies only the pending steps", async () => {
    const db = await freshDb("upgrade");
    migrateContinuityStore(db); // now at v1

    const backups = [];
    const result = migrateContinuityStore(db, {
      migrations: [...MIGRATIONS, nextStep],
      backup: (info) => backups.push(info),
    });

    expect(result.from).toBe(SHIPPED);
    expect(result.to).toBe(SHIPPED + 1);
    expect(result.applied).toBe(1);
    expect(result.fresh).toBe(false);
    expect(backups).toEqual([{ from: SHIPPED, to: SHIPPED + 1 }]);
    expect(db.get(`SELECT COUNT(*) AS n FROM dxr_test_step_two`).n).toBe(0);
  });

  it("continues when the backup callback throws — a failed backup is not data loss", async () => {
    const db = await freshDb("upgrade-badbackup");
    migrateContinuityStore(db);
    const logged = [];
    const result = migrateContinuityStore(db, {
      migrations: [...MIGRATIONS, nextStep],
      backup: () => {
        throw new Error("disk full");
      },
      log: (m) => logged.push(m),
    });
    expect(result.applied).toBe(1);
    expect(logged.join(" ")).toMatch(/backup/i);
  });

  it("rolls back a failing step and leaves the version untouched", async () => {
    const db = await freshDb("upgrade-fails");
    migrateContinuityStore(db);
    const exploding = {
      version: SHIPPED + 1,
      name: "explodes",
      up(handle) {
        handle.exec(`CREATE TABLE dxr_half_applied(id TEXT PRIMARY KEY)`);
        throw new Error("boom");
      },
    };
    expect(() => migrateContinuityStore(db, { migrations: [...MIGRATIONS, exploding] })).toThrow(/boom/);
    expect(getSchemaVersion(db)).toBe(SHIPPED);
    const names = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name);
    expect(names).not.toContain("dxr_half_applied");
  });
});

describe("a database from a newer build", () => {
  it("refuses to open rather than silently downgrading", async () => {
    const db = await freshDb("ahead");
    migrateContinuityStore(db);
    db.run(`INSERT INTO _meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [
      String(CONTINUITY_SCHEMA_VERSION + 5),
    ]);

    let thrown = null;
    try {
      migrateContinuityStore(db);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContinuityMigrationError);
    expect(thrown.code).toBe("CONTINUITY_SCHEMA_AHEAD");
  });
});

describe("openContinuityStore", () => {
  it("returns a migrated handle and the table list", async () => {
    const db = await freshDb("open");
    const store = openContinuityStore({ db });
    expect(store.schemaVersion).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(store.db).toBe(db);
    expect(store.tables).toEqual(expect.arrayContaining([...CORE_TABLES]));
  });

  it("rejects a handle that is not a SQLite adapter", () => {
    expect(() => openContinuityStore({ db: { run: () => {} } })).toThrow();
  });
});
