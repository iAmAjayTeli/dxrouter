/**
 * DXRouter ships no browser analytics.
 *
 * Upstream added Google Analytics to the root layout (3f9382de, made unconditional in
 * 7354c5e5): `<GoogleAnalytics gaId="G-LC959F603F" />` from @next/third-parties. It ran
 * on every page of every install, dashboard, login and the provider OAuth `/callback`
 * alike, with no setting and no consent. A captured page_view carried the full page
 * URL, so the callback's `?code=…&state=…` went to upstream's analytics property along
 * with a persistent `_ga` client id, the operator's IP and browser details.
 *
 * The integration is removed, not replaced. This pins that: nothing the app serves may
 * reference a Google Analytics / Tag Manager property, loader or collection endpoint,
 * and the package that provided the component is not a dependency.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Everything that ends up in the served application: pages/components/routes (src),
// the routing engine it imports (open-sse), and static files served as-is (public).
const SHIPPED_ROOTS = ["src", "open-sse", "public"];
const TEXT_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".html", ".css", ".svg", ".txt"]);

const FORBIDDEN = [
  { what: "the upstream GA property id", re: /G-LC959F603F/ },
  { what: "any GA4 measurement id", re: /\bG-[A-Z0-9]{8,12}\b/ },
  { what: "the gtag.js / Tag Manager loader", re: /googletagmanager\.com/ },
  { what: "a GA collection endpoint", re: /google-analytics\.com|analytics\.google\.com|\/g\/collect\b/ },
  { what: "a gtag() call", re: /\bgtag\s*\(/ },
  { what: "the @next/third-parties Google components", re: /@next\/third-parties/ },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT_EXT.has(path.extname(entry.name))) yield full;
  }
}

describe("no third-party browser analytics in what DXRouter serves", () => {
  const files = SHIPPED_ROOTS.flatMap((root) => [...walk(path.join(REPO_ROOT, root))]);

  it("scans a real tree (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(path.join(REPO_ROOT, "src", "app", "layout.js"));
    expect(files).toContain(path.join(REPO_ROOT, "src", "app", "callback", "page.js"));
  });

  it.each(FORBIDDEN)("contains no $what", ({ re }) => {
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (re.test(line)) hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("does not depend on @next/third-parties", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      expect(pkg[field]?.["@next/third-parties"], field).toBeUndefined();
    }
    const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
    expect(lock.packages[""].dependencies?.["@next/third-parties"]).toBeUndefined();
    expect(lock.packages["node_modules/@next/third-parties"]).toBeUndefined();
  });
});
