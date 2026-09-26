import fs from "node:fs";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";

let SQL = null;

// Every process event the adapter flushes on. `exit` is the one emitted by process.exit().
const SHUTDOWN_EVENTS = ["beforeExit", "exit", "SIGINT", "SIGTERM"];

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 100;

  function persist() {
    const data = db.export();
    fs.writeFileSync(filePath, Buffer.from(data));
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try { persist(); } catch (e) { console.error("[sqljs] save failed:", e); }
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      if (dirty) persist();
    } finally {
      // Always release the handle and the process listeners, even when the final write
      // fails, so a closed adapter is neither leaked nor flushed again at exit.
      for (const event of SHUTDOWN_EVENTS) process.off(event, flush);
      db.close();
    }
  }

  // Flush on shutdown.
  //
  // Writes sit in memory for up to SAVE_DEBOUNCE_MS before they reach disk, so every way
  // the process can end has to flush first. `exit` is the one that matters most: it is
  // the only event emitted when anything calls `process.exit()` — which the other
  // drivers' signal handlers, the app's cleanup handler and the shutdown routes all do —
  // and it runs synchronously, which `writeFileSync` is. Without it, committed rows were
  // silently discarded on every `process.exit()` inside the debounce window.
  //
  // The signal listeners are kept for their existing behaviour and are not changed here.
  const flush = () => { if (dirty) try { persist(); } catch {} };
  for (const event of SHUTDOWN_EVENTS) process.on(event, flush);

  return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
}
