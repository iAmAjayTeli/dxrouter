/**
 * Documentation link + anchor checker.
 *
 * Deliberately dependency-free and run directly by node, so it works without the
 * `tests/` workspace install. Used by tests/unit/dxr-docs-consistency.test.js and
 * usable standalone:  node tests/tools/doc-links.mjs README.md
 *
 * Anchor slugs follow GitHub's `github-slugger`, which trims the raw heading FIRST
 * and strips punctuation AFTER. A leading emoji therefore leaves behind the space
 * that becomes the leading hyphen — which is why every README in this repo links to
 * `#-quick-start` rather than `#quick-start`. Getting that order wrong reports every
 * heading in the file as a broken anchor.
 */
import fs from "node:fs";
import path from "node:path";

export function slugify(heading) {
  return (
    "#" +
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-")
  );
}

/** Headings, with duplicate suffixes (-1, -2) the way GitHub disambiguates them. */
export function headingAnchors(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const base = slugify(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/**
 * Markdown links and HTML src/href attributes that point somewhere local.
 * Skips mailto:, absolute URLs, and bare anchors (handled separately).
 */
function localTargets(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ line: i + 1, target: m[1] });
    for (const m of line.matchAll(/(?:src|href)="([^"]+)"/g)) out.push({ line: i + 1, target: m[1] });
  });
  return out.filter(
    ({ target }) => !/^(https?:|mailto:|data:|#)/i.test(target) && target.trim() !== ""
  );
}

function anchorLinks(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\]\((#[^)]+)\)/g)) out.push({ line: i + 1, target: m[1] });
  });
  return out;
}

/** @returns {{brokenPaths: string[], brokenAnchors: string[]}} */
export function checkDoc(repoRoot, relFile) {
  const abs = path.join(repoRoot, relFile);
  const text = fs.readFileSync(abs, "utf8");
  const dir = path.dirname(abs);
  const anchors = headingAnchors(text);

  const brokenPaths = [];
  for (const { line, target } of localTargets(text)) {
    const [pathPart] = target.split("#");
    if (!pathPart) continue;
    const resolved = path.resolve(dir, decodeURIComponent(pathPart.split("?")[0]));
    if (!fs.existsSync(resolved)) brokenPaths.push(`${relFile}:${line} -> ${target}`);
  }

  const brokenAnchors = [];
  for (const { line, target } of anchorLinks(text)) {
    if (!anchors.has(target.toLowerCase())) brokenAnchors.push(`${relFile}:${line} -> ${target}`);
  }

  return { brokenPaths, brokenAnchors };
}

// Standalone CLI mode.
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const files = process.argv.slice(2);
  let bad = 0;
  for (const f of files) {
    const { brokenPaths, brokenAnchors } = checkDoc(process.cwd(), f);
    if (brokenPaths.length || brokenAnchors.length) {
      bad += brokenPaths.length + brokenAnchors.length;
      console.log(`\n${f}`);
      brokenPaths.forEach((b) => console.log(`  [path]   ${b}`));
      brokenAnchors.forEach((b) => console.log(`  [anchor] ${b}`));
    } else {
      console.log(`${f}: OK`);
    }
  }
  process.exit(bad ? 1 : 0);
}
