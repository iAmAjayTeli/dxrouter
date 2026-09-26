/**
 * The sql.js driver must not lose committed writes when the process exits.
 *
 * sql.js keeps the database in memory and writes the file on a 100ms debounce
 * (src/lib/db/adapters/sqljsAdapter.js). It flushed on `beforeExit`, SIGINT and SIGTERM
 * but not on `exit`, and `exit` is the only event `process.exit()` emits. Everything
 * that ends this server does call it: the other drivers' signal handlers, the app's
 * cleanup handler in initializeApp.js, and both shutdown routes. So a row written less
 * than 100ms before shutdown was acknowledged to the caller and never reached disk —
 * on a fresh database, the file was never created at all.
 *
 * sql.js is the last-resort driver: it is what runs on Node < 22.5 without a native
 * better-sqlite3 build, which cli/package.json (`engines: >=18`) admits. Settings,
 * the dashboard password hash and provider credentials all live in that database.
 *
 * `process.exit()` cannot be exercised in the test process, so each case runs in a
 * child and the file is read back by a second, separate child.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER = pathToFileURL(path.join(REPO_ROOT, "src", "lib", "db", "adapters", "sqljsAdapter.js")).href;
const ROWS = 5;

let DIR;
let WRITER;
let READER;

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-sqljs-durability-"));

  WRITER = path.join(DIR, "writer.mjs");
  fs.writeFileSync(
    WRITER,
    [
      `import { createSqlJsAdapter } from ${JSON.stringify(ADAPTER)};`,
      "const [file, mode] = process.argv.slice(2);",
      // An app-level handler that ends in process.exit(), registered before the
      // database is opened — the order initializeApp.js and the other drivers use.
      'if (mode === "signal") process.on("SIGINT", () => process.exit(0));',
      "const db = await createSqlJsAdapter(file);",
      'db.exec("CREATE TABLE t (v INTEGER)");',
      `for (let i = 0; i < ${ROWS}; i++) db.run("INSERT INTO t (v) VALUES (?)", [i]);`,
      'if (mode === "exit") process.exit(0);',
      // Dispatch to the listeners in registration order, exactly as a delivered
      // signal would, without depending on platform signal semantics.
      'if (mode === "signal") process.emit("SIGINT");',
    ].join("\n")
  );

  READER = path.join(DIR, "reader.mjs");
  fs.writeFileSync(
    READER,
    [
      'import fs from "node:fs";',
      `import { createSqlJsAdapter } from ${JSON.stringify(ADAPTER)};`,
      "const file = process.argv[2];",
      'if (!fs.existsSync(file)) { process.stdout.write("missing"); process.exit(0); }',
      "const db = await createSqlJsAdapter(file);",
      'process.stdout.write(String(db.get("SELECT COUNT(*) AS n FROM t").n));',
      "db.close();",
    ].join("\n")
  );
});

afterAll(() => {
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* the OS reclaims the temp directory either way */
  }
});

function node(script, args) {
  return execFileSync(process.execPath, ["--no-warnings", script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
}

/**
 * Node 24 on Windows aborts during teardown when `process.exit()` runs after the sql.js
 * WASM module has loaded: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * file src\win\async.c`. It reproduces with sql.js alone and no code from this
 * repository, it does not happen on Node 22, and the `exit` listeners have already run
 * by then — so it says nothing about durability, which is what the reader checks.
 * Exactly that signature is tolerated, on win32 only; any other failure still fails.
 */
const WIN_TEARDOWN_ABORT = /UV_HANDLE_CLOSING[\s\S]*src\\win\\async\.c/;

function write(file, mode) {
  const r = spawnSync(process.execPath, ["--no-warnings", WRITER, file, mode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (r.error) throw r.error;
  const knownAbort = process.platform === "win32" && WIN_TEARDOWN_ABORT.test(r.stderr);
  if (r.status !== 0 && !knownAbort) {
    throw new Error(`writer (${mode}) exited ${r.status}: ${r.stderr}`);
  }
}

function rowsAfter(mode) {
  const file = path.join(DIR, `${mode}.sqlite`);
  write(file, mode);
  return node(READER, [file]);
}

describe("sql.js flushes committed writes on every way the process ends", () => {
  it("keeps writes when something calls process.exit() inside the save debounce", () => {
    expect(rowsAfter("exit")).toBe(String(ROWS));
  });

  it("keeps writes when an earlier signal handler exits the process", () => {
    expect(rowsAfter("signal")).toBe(String(ROWS));
  });

  it("still keeps writes when the event loop simply drains", () => {
    expect(rowsAfter("drain")).toBe(String(ROWS));
  });
});

describe("closing an adapter releases it", () => {
  const EVENTS = ["beforeExit", "exit", "SIGINT", "SIGTERM"];
  const counts = () => Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

  it("removes the shutdown listeners it registered", async () => {
    const { createSqlJsAdapter } = await import(ADAPTER);
    const before = counts();
    const db = await createSqlJsAdapter(path.join(DIR, "listeners.sqlite"));
    for (const e of EVENTS) expect(process.listenerCount(e), e).toBe(before[e] + 1);
    db.close();
    // Without this, every adapter ever opened stayed reachable through its listener,
    // and would try to flush a closed database at exit.
    expect(counts()).toEqual(before);
  });

  it("releases the handle and listeners even when the final write fails", async () => {
    const { createSqlJsAdapter } = await import(ADAPTER);
    const before = counts();
    const gone = path.join(DIR, "gone");
    fs.mkdirSync(gone);
    const db = await createSqlJsAdapter(path.join(gone, "db.sqlite"));
    db.exec("CREATE TABLE t (v INTEGER)");
    fs.rmSync(gone, { recursive: true, force: true });

    // The pending write cannot land, and close() says so rather than hiding it...
    expect(() => db.close()).toThrow();
    // ...but it does not leave a live listener pointing at the dead adapter.
    expect(counts()).toEqual(before);
  });
});
