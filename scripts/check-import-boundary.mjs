#!/usr/bin/env node
/**
 * I1 enforcement: `continuity/**` must not import 9Router.
 *
 * The invariant is structural, not stylistic. The continuity engine is only worth
 * building if it can be reasoned about, tested and replayed without a Next.js
 * request, a SQLite handle or a provider SDK in scope. One `import { getSettings }
 * from "@/lib/..."` is enough to end that property, and it is exactly the import
 * somebody adds at 2am to unblock a feature. Code review does not reliably catch
 * it; a failing build does.
 *
 * ### The rule
 *
 * A module under the scanned root may import:
 *   - relative paths that resolve *inside* the root, and
 *   - `node:`-prefixed builtins.
 *
 * Everything else is a violation — including bare npm packages. That is
 * deliberate: an engine dependency is a decision worth making explicitly (by
 * widening this allowlist in a reviewable commit), not by accident.
 *
 * Usage:
 *   node scripts/check-import-boundary.mjs                 # checks continuity/
 *   node scripts/check-import-boundary.mjs --root <dir>     # checks another tree
 *   node scripts/check-import-boundary.mjs --json           # machine-readable
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");

/** Extensions worth parsing. */
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx"]);

/**
 * Specifiers that are allowed even though they are not relative. Keep this list
 * short and justified; every entry is a hole in I1.
 */
function isAllowedBareSpecifier(spec) {
  return spec.startsWith("node:");
}

/**
 * Names that make a violation easier to explain in the failure output. Matching is
 * for the message only — the pass/fail decision is made by the resolve check.
 */
const KNOWN_HOST_PREFIXES = [
  ["@/", "9Router application code (src/)"],
  ["open-sse", "the 9Router routing engine"],
  ["next", "Next.js"],
  ["../src/", "9Router application code (src/)"],
  ["../adapters/", "the 9Router adapter layer"],
];

function describeSpecifier(spec) {
  for (const [prefix, label] of KNOWN_HOST_PREFIXES) {
    if (spec === prefix || spec.startsWith(prefix)) return label;
  }
  return "code outside the engine boundary";
}

/** Collect every static and dynamic import specifier, with line numbers. */
export function extractSpecifiers(source) {
  const found = [];
  const lines = source.split(/\r?\n/);

  // Comments are stripped line-wise so a documented counter-example (`do not
  // import "@/lib/db"`) in a header comment does not fail the build.
  const patterns = [
    /\bimport\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[\w*${},\s]+\s+)?from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  let inBlockComment = false;
  lines.forEach((rawLine, i) => {
    let line = rawLine;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd === -1) {
        line = line.slice(0, blockStart);
        inBlockComment = true;
      } else {
        line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
      }
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    if (!line.trim()) return;

    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        found.push({ specifier: m[1], line: i + 1 });
      }
    }
  });

  return found;
}

function listSourceFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(full);
        continue;
      }
      if (SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
    }
  }
  return out.sort();
}

/**
 * @param {string} root absolute path of the tree to check
 * @returns {{files: number, violations: Array<{file: string, line: number, specifier: string, reason: string}>}}
 */
export function checkImportBoundary(root) {
  const absRoot = path.resolve(root);
  const files = listSourceFiles(absRoot);
  const violations = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const { specifier, line } of extractSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        const inside = resolved === absRoot || resolved.startsWith(absRoot + path.sep);
        if (!inside) {
          violations.push({
            file: path.relative(REPO_ROOT, file),
            line,
            specifier,
            reason: `relative import escapes the boundary into ${describeSpecifier(specifier)}`,
          });
        }
        continue;
      }
      if (isAllowedBareSpecifier(specifier)) continue;
      violations.push({
        file: path.relative(REPO_ROOT, file),
        line,
        specifier,
        reason: `imports ${describeSpecifier(specifier)}`,
      });
    }
  }

  return { files: files.length, violations };
}

function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag !== -1 ? argv[rootFlag + 1] : path.join(REPO_ROOT, "continuity");
  const asJson = argv.includes("--json");

  if (!fs.existsSync(root)) {
    console.error(`[boundary] root not found: ${root}`);
    process.exit(2);
  }

  const result = checkImportBoundary(root);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.violations.length === 0) {
    console.log(`[boundary] OK — ${result.files} file(s) in ${path.relative(REPO_ROOT, root) || "."}, no forbidden imports`);
  } else {
    console.error(`[boundary] I1 VIOLATION — the continuity engine must not depend on 9Router.\n`);
    for (const v of result.violations) {
      console.error(`  ${v.file}:${v.line}  "${v.specifier}"\n      ${v.reason}`);
    }
    console.error(
      `\n${result.violations.length} violation(s). Fix by widening a port in continuity/ports/ ` +
        `(a reviewable change) and implementing it in adapters/ninerouter/ — not by importing here.`
    );
  }

  process.exit(result.violations.length === 0 ? 0 : 1);
}

// Only run when executed directly, so tests can import the checker.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfPath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (invokedPath && invokedPath === selfPath) main();
