/**
 * Buffered request-detail rows must reach SQLite when the process is stopped.
 *
 * saveRequestDetail() buffers rows and flushes them on a timer (5s) or at a batch
 * threshold (20). Its shutdown handler was async: on SIGINT/SIGTERM it started a
 * flush, hit its first `await`, and the DB adapter's own signal listener then called
 * process.exit() in the same emit; on `exit`, nothing after an `await` runs at all.
 * So every Ctrl+C, `docker stop`, or process.exit() inside the flush window dropped
 * every buffered row — 0 of 3 persisted, on Node 22 and 24, with node:sqlite.
 *
 * Signals and process.exit() cannot be exercised in the test process, so each case
 * runs in a child and the database is read back by a second, separate child.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const url = (...p) => pathToFileURL(path.join(REPO_ROOT, ...p)).href;
const REPO = url("src", "lib", "db", "repos", "requestDetailsRepo.js");
const DRIVER = url("src", "lib", "db", "driver.js");
const SETTINGS = url("src", "lib", "db", "repos", "settingsRepo.js");
const ROWS = 3;

let DIR;
let HOOK;
let WRITER;
let READER;

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-request-details-"));

  // The repo's module graph uses the `@/` alias that Next/Vitest resolve; a bare
  // child process needs the same mapping.
  HOOK = path.join(DIR, "alias-hook.mjs");
  const srcBase = url("src") + "/";
  fs.writeFileSync(
    HOOK,
    [
      'import { register } from "node:module";',
      "const hook = `export async function resolve(spec, ctx, next) {",
      `  if (spec.startsWith("@/")) return next(${JSON.stringify(srcBase)} + spec.slice(2) + (/\\\\.[mc]?js$/.test(spec) ? "" : ".js"), ctx);`,
      "  return next(spec, ctx);",
      "}`;",
      'register("data:text/javascript," + encodeURIComponent(hook));',
    ].join("\n")
  );

  WRITER = path.join(DIR, "writer.mjs");
  fs.writeFileSync(
    WRITER,
    [
      "const [mode, order] = process.argv.slice(2);",
      // "adapter-first": the DB is opened (and its signal handlers registered) before
      // this repo is imported, as when the app initialises the DB at boot.
      `if (order === "adapter-first") await (await import(${JSON.stringify(DRIVER)})).getAdapter();`,
      `const { saveRequestDetail } = await import(${JSON.stringify(REPO)});`,
      `await (await import(${JSON.stringify(DRIVER)})).getAdapter();`,
      // Signal/exit cases keep the default 5s flush window open; the drain control
      // shortens it (settings outrank the env var) so the timer flush ends the child.
      `if (mode === "drain") await (await import(${JSON.stringify(SETTINGS)})).updateSettings({ observabilityFlushIntervalMs: 100 });`,
      `for (let i = 0; i < ${ROWS}; i++) await saveRequestDetail({ id: "d" + i, provider: "p", model: "m", status: 200, request: {} });`,
      // Dispatch to the listeners in registration order, exactly as a delivered
      // signal would, without depending on platform signal semantics.
      'if (mode === "sigterm") process.emit("SIGTERM");',
      'if (mode === "sigint") process.emit("SIGINT");',
      'if (mode === "exit") process.exit(0);',
      // "drain": fall off the end; the pending flush timer keeps the loop alive.
    ].join("\n")
  );

  READER = path.join(DIR, "reader.mjs");
  fs.writeFileSync(
    READER,
    [
      `const db = await (await import(${JSON.stringify(DRIVER)})).getAdapter();`,
      'process.stdout.write("\\nROWS=" + db.get("SELECT COUNT(*) AS n FROM requestDetails").n);',
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

function node(script, args, dataDir) {
  return execFileSync(process.execPath, ["--no-warnings", "--import", pathToFileURL(HOOK).href, script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, DXR_DATA_DIR: dataDir, ENABLE_REQUEST_LOGS: "true" },
  });
}

function rowsAfter(mode, order = "repo-first") {
  const dataDir = path.join(DIR, `${mode}-${order}`);
  node(WRITER, [mode, order], dataDir);
  // The driver logs its choice to stdout; the count is the tagged last line.
  return node(READER, [], dataDir).match(/ROWS=(\d+)\s*$/)?.[1];
}

describe("buffered request details survive every way the process ends", () => {
  it.each(["sigterm", "sigint", "exit"])("%s inside the flush window", (mode) => {
    expect(rowsAfter(mode)).toBe(String(ROWS));
  });

  it("SIGTERM when the DB adapter registered its exit-on-signal handler first", () => {
    expect(rowsAfter("sigterm", "adapter-first")).toBe(String(ROWS));
  });

  it("still persists when the event loop simply drains", () => {
    expect(rowsAfter("drain")).toBe(String(ROWS));
  });
});

describe("re-evaluating the module does not stack shutdown listeners", () => {
  const EVENTS = ["beforeExit", "exit", "SIGINT", "SIGTERM"];
  const counts = () => Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

  it("replaces the previous handler instead of adding another (Next.js dev HMR)", async () => {
    await import("../../src/lib/db/repos/requestDetailsRepo.js");
    const after1 = counts();
    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      await import("../../src/lib/db/repos/requestDetailsRepo.js");
    }
    expect(counts()).toEqual(after1);
  });
});
