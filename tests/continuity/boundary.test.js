/**
 * I1 — the continuity engine must not import 9Router.
 *
 * The invariant is only real if the build breaks when it is violated, so this file
 * tests two things: that the live tree is clean, and that the checker actually
 * fails on each way somebody might reach across the boundary. A checker that
 * silently passes everything would be worse than none, because it would license
 * the assumption that CI has this covered.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkImportBoundary, extractSpecifiers } from "../../scripts/check-import-boundary.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-import-boundary.mjs");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "boundary");

function runChecker(root) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    return { code: 0, output: stdout };
  } catch (e) {
    return { code: e.status, output: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

describe("the real continuity tree", () => {
  it("has zero forbidden imports", () => {
    const result = checkImportBoundary(path.join(REPO_ROOT, "continuity"));
    expect(result.violations).toEqual([]);
    expect(result.files).toBeGreaterThan(0);
  });

  it("passes the CI entry point with exit code 0", () => {
    const { code } = runChecker(path.join(REPO_ROOT, "continuity"));
    expect(code).toBe(0);
  });
});

describe("the checker itself", () => {
  it("accepts relative-inside and node: imports", () => {
    const result = checkImportBoundary(path.join(FIXTURES, "good"));
    expect(result.violations).toEqual([]);
  });

  it("rejects every form of boundary crossing", () => {
    const result = checkImportBoundary(path.join(FIXTURES, "bad"));
    const specifiers = result.violations.map((v) => v.specifier);
    expect(specifiers).toContain("open-sse/executors/index.js"); // bare package
    expect(specifiers).toContain("@/lib/db/index.js"); // path alias
    expect(specifiers).toContain("../../../../src/lib/dataDir.js"); // relative escape
    expect(specifiers).toContain("open-sse/services/provider.js"); // dynamic import
    expect(result.violations).toHaveLength(4);
  });

  it("fails CI with a non-zero exit code and an actionable message", () => {
    const { code, output } = runChecker(path.join(FIXTURES, "bad"));
    expect(code).toBe(1);
    expect(output).toMatch(/I1 VIOLATION/);
    // The message has to say what to do instead, or the next person just deletes
    // the import list rather than widening a port.
    expect(output).toMatch(/widening a port/);
  });

  it("sees require() and dynamic import(), not just static imports", () => {
    const found = extractSpecifiers(`
      const a = require("open-sse");
      const b = await import("@/lib/db/index.js");
      export { x } from "next/server";
    `).map((s) => s.specifier);
    expect(found).toEqual(expect.arrayContaining(["open-sse", "@/lib/db/index.js", "next/server"]));
  });

  it("ignores specifiers that only appear in comments", () => {
    // Otherwise a header documenting the rule ("never import @/lib/db") would fail
    // the build it is describing.
    const found = extractSpecifiers(`
      // do not: import x from "@/lib/db/index.js"
      /* also not: import y from "open-sse" */
      import { real } from "./real.js";
    `).map((s) => s.specifier);
    expect(found).toEqual(["./real.js"]);
  });

  it("reports the file and line of each violation", () => {
    const result = checkImportBoundary(path.join(FIXTURES, "bad"));
    for (const v of result.violations) {
      expect(v.file).toMatch(/boundary/);
      expect(v.line).toBeGreaterThan(0);
      expect(typeof v.reason).toBe("string");
    }
  });
});
