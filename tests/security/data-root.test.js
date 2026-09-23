/**
 * One data root, and the migration/backup behaviour that lives in it.
 *
 * M0 requires a single `DXR_DATA_DIR` used consistently, with no hidden second
 * location: no repo-relative credential store, no duplicated usage DB, no
 * alternate persistence path. Two of those are properties of the source tree
 * rather than of one run, so this file checks the tree as well as the behaviour —
 * a module that re-derives `~/.9router` itself would keep working on a default
 * install and silently write outside the configured root on every other one.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let DIR;
const SAVED = {};
const ENV_KEYS = ["DXR_DATA_DIR", "DATA_DIR", "DXR_MASTER_KEY", "ENABLE_REQUEST_LOGS"];

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-dataroot-"));
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  delete process.env.DATA_DIR;
  process.env.DXR_DATA_DIR = DIR;
  process.env.DXR_MASTER_KEY = "ab".repeat(32);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the SQLite handle; the OS reclaims the temp dir */
  }
});

/** Import a module fresh, so module-level path constants re-resolve. */
async function fresh(specifier) {
  vi.resetModules();
  return import(specifier);
}

describe("resolution precedence", () => {
  it("prefers DXR_DATA_DIR", async () => {
    const { DATA_DIR, DATA_DIR_SOURCE } = await fresh("@/lib/dataDir.js");
    expect(DATA_DIR).toBe(DIR);
    expect(DATA_DIR_SOURCE).toBe("DXR_DATA_DIR");
  });

  it("still honours the deprecated DATA_DIR, but says so", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-legacy-"));
    delete process.env.DXR_DATA_DIR;
    process.env.DATA_DIR = other;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { DATA_DIR, DATA_DIR_SOURCE } = await fresh("@/lib/dataDir.js");
      expect(DATA_DIR).toBe(other);
      expect(DATA_DIR_SOURCE).toBe("DATA_DIR");
      expect(warn.mock.calls.flat().join(" ")).toMatch(/DATA_DIR is deprecated/);
    } finally {
      warn.mockRestore();
      delete process.env.DATA_DIR;
      process.env.DXR_DATA_DIR = DIR;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("falls back to the platform default when nothing is configured", async () => {
    delete process.env.DXR_DATA_DIR;
    try {
      const { DATA_DIR, DATA_DIR_SOURCE } = await fresh("@/lib/dataDir.js");
      expect(DATA_DIR_SOURCE).toBe("default");
      const expected =
        process.platform === "win32"
          ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
          : path.join(os.homedir(), ".9router");
      expect(DATA_DIR).toBe(expected);
    } finally {
      process.env.DXR_DATA_DIR = DIR;
    }
  });

  it("creates the configured root instead of assuming it exists", async () => {
    const nested = path.join(DIR, "created", "on", "demand");
    process.env.DXR_DATA_DIR = nested;
    try {
      const { DATA_DIR } = await fresh("@/lib/dataDir.js");
      expect(DATA_DIR).toBe(nested);
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      process.env.DXR_DATA_DIR = DIR;
    }
  });
});

describe("everything derives from that one root", () => {
  it("puts the database, its backups, and every log under it", async () => {
    const { DATA_DIR, LOGS_DIR, TRANSLATOR_LOGS_DIR } = await fresh("@/lib/dataDir.js");
    const { DB_DIR, DATA_FILE, BACKUPS_DIR, LEGACY_FILES } = await import("@/lib/db/paths.js");

    for (const p of [LOGS_DIR, TRANSLATOR_LOGS_DIR, DB_DIR, DATA_FILE, BACKUPS_DIR, ...Object.values(LEGACY_FILES)]) {
      const rel = path.relative(DATA_DIR, p);
      expect(rel.startsWith(".."), p).toBe(false);
      expect(path.isAbsolute(rel), p).toBe(false);
    }
    expect(DATA_FILE).toBe(path.join(DIR, "db", "data.sqlite"));
  });

  it("keeps usage and request logs in the same database, not a second store", async () => {
    // Upstream kept `usage.json` + `log.txt` on a hardcoded `~/.9router` path that
    // ignored the configured root. Both now go through the SQLite layer.
    const usageDb = await fresh("@/lib/usageDb.js");
    const db = await import("@/lib/db/index.js");
    for (const fn of ["saveRequestUsage", "appendRequestLog", "getRecentLogs", "saveRequestDetail"]) {
      expect(typeof usageDb[fn], fn).toBe("function");
      expect(usageDb[fn], fn).toBe(db[fn]);
    }
  });
});

describe("no second data root in the source tree", () => {
  /**
   * Modules allowed to derive the root themselves. `src/mitm/paths.js` runs as a
   * CommonJS process outside the app's module graph, so it cannot import the ESM
   * resolver; it duplicates the precedence and says so in a comment.
   *
   * There was a second entry, `src/lib/updater/updater.js` — a script copied into the
   * data directory and run by bare node. It was deleted along with the self-install path
   * it served, so the list is down to one.
   */
  const ALLOWED = new Set([
    path.join("src", "lib", "dataDir.js"),
    path.join("src", "mitm", "paths.js"),
  ]);

  // Code-shaped only: `%APPDATA%/9router` in a documentation string is describing
  // the default location, not choosing one.
  const OWN_ROOT = /(?:homedir\(\)|process\.env\.APPDATA)[^\n]*(?:9router|APP_NAME)/;

  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("has no module that invents its own ~/.9router", () => {
    const offenders = [];
    for (const root of ["src", "open-sse", "continuity"]) {
      const dir = path.join(REPO_ROOT, root);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const rel = path.relative(REPO_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const text = fs.readFileSync(file, "utf8");
        for (const [i, line] of text.split("\n").entries()) {
          // Reading another tool's config directory is fine; deriving *our own*
          // state directory is what must go through the resolver.
          if (OWN_ROOT.test(line)) offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the one documented duplicator in step with the resolver", () => {
    for (const rel of [path.join("src", "mitm", "paths.js")]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      // A duplicator that does not read DXR_DATA_DIR is exactly the hidden second
      // root this rule exists to prevent.
      expect(text, rel).toMatch(/DXR_DATA_DIR/);
      expect(text, rel).toMatch(/kept in step/);
    }
  });

  it("no longer carries the updater as a second duplicator", () => {
    // Deleted with the self-install path. Pinned so the permitted-duplicator list cannot
    // quietly grow back to two.
    expect(fs.existsSync(path.join(REPO_ROOT, "src", "lib", "updater", "updater.js"))).toBe(false);
    expect(ALLOWED.has(path.join("src", "lib", "updater", "updater.js"))).toBe(false);
  });
});

describe("a fresh install", () => {
  let adapter;
  let paths;
  let latest;

  beforeAll(async () => {
    global._dbAdapter = null;
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    adapter = (await import("@/lib/db/driver.js")).getAdapterSync();
    paths = await import("@/lib/db/paths.js");
    latest = (await import("@/lib/db/migrations/index.js")).latestVersion();
  });

  it("creates the database inside the configured root and nowhere else", () => {
    expect(fs.existsSync(paths.DATA_FILE)).toBe(true);
    expect(paths.DATA_FILE.startsWith(DIR)).toBe(true);
    // Not next to the repo: a credential store in the working tree is one
    // `git add -A` away from being published.
    expect(fs.existsSync(path.join(REPO_ROOT, "data.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "db.json"))).toBe(false);
  });

  it("runs the migration chain to the latest version", () => {
    const row = adapter.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latest);
  });

  it("creates every declared table", async () => {
    const { TABLES } = await import("@/lib/db/schema.js");
    const present = new Set(adapter.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name));
    for (const name of Object.keys(TABLES)) expect(present.has(name), name).toBe(true);
  });

  it("is idempotent — a second start reuses the same database", async () => {
    const before = fs.statSync(paths.DATA_FILE).size;
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    expect((await import("@/lib/db/driver.js")).getAdapterSync()).toBe(adapter);
    expect(fs.statSync(paths.DATA_FILE).size).toBeGreaterThanOrEqual(before);
  });

  it("takes no backup on a fresh install — there is nothing to protect yet", () => {
    const dirs = fs.existsSync(paths.BACKUPS_DIR) ? fs.readdirSync(paths.BACKUPS_DIR) : [];
    expect(dirs).toEqual([]);
  });
});

describe("upgrading an existing database", () => {
  const KV_MARKER = "M0-KV-MARKER-8f3a";
  const DETAIL_MARKER = "M0-DETAIL-MARKER-8f3a";

  it("backs the database up before a schema change, excluding the observability log", async () => {
    const adapter = (await import("@/lib/db/driver.js")).getAdapterSync();
    const { BACKUPS_DIR } = await import("@/lib/db/paths.js");
    const { SCHEMA_VERSION } = await import("@/lib/db/schema.js");

    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('m0test', 'marker', ?)`, [KV_MARKER]);
    adapter.run(
      `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data)
       VALUES('m0test', ?, 'p', 'm', NULL, 200, ?)`,
      [new Date().toISOString(), JSON.stringify({ marker: DETAIL_MARKER })]
    );
    // Pretend this install last ran an older schema.
    adapter.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('backupSchemaVersion', '1')`);

    // A fresh import gives a migrate module that has not yet seen this adapter.
    vi.resetModules();
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    await runMigrationOnce(adapter);

    const dirs = fs.readdirSync(BACKUPS_DIR);
    const backup = dirs.find((d) => d.startsWith(`schema-1-to-${SCHEMA_VERSION}-`));
    expect(backup, `expected a schema-1-to-${SCHEMA_VERSION} backup, got ${dirs.join(", ")}`).toBeTruthy();

    const file = path.join(BACKUPS_DIR, backup, "data.sqlite");
    expect(fs.existsSync(file)).toBe(true);
    const bytes = fs.readFileSync(file).toString("latin1");
    // Real material, not a mock: the row is in the backup file.
    expect(bytes).toContain(KV_MARKER);
    // requestDetails is deliberately excluded — it is an auto-pruned log, and
    // copying it would make every backup as large as the whole database.
    expect(bytes).not.toContain(DETAIL_MARKER);

    // The version stamp advances, so the next boot does not back up again.
    expect(adapter.get(`SELECT value FROM _meta WHERE key = 'backupSchemaVersion'`).value).toBe(String(SCHEMA_VERSION));
  });

  it("leaves the live database intact after the backup", async () => {
    const adapter = (await import("@/lib/db/driver.js")).getAdapterSync();
    expect(adapter.get(`SELECT value FROM kv WHERE scope='m0test' AND key='marker'`).value).toBe(KV_MARKER);
    expect(adapter.get(`SELECT data FROM requestDetails WHERE id='m0test'`).data).toContain(DETAIL_MARKER);
    expect(parseInt(adapter.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value, 10)).toBeGreaterThan(0);
  });
});
