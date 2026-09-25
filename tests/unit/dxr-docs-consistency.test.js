/**
 * Documentation correctness invariants.
 *
 * This repository carried two divergent Chinese READMEs: `README.zh-CN.md` at the root
 * and `i18n/README.zh-CN.md`. Every language switcher pointed at the `i18n/` copy, so
 * that was the file Chinese readers reached — but it was the older of the two. It
 * predated the `DXR_*` runtime variables entirely and carried five markdown
 * corruptions. The newer root content was promoted into `i18n/README.zh-CN.md`, and the
 * root path was reduced to a pointer so a second Chinese source cannot reappear.
 *
 * The tests below are about *reachability and correctness*, not branding. A broad
 * 9Router -> DXRouter migration is deliberately out of scope, so these assertions must
 * keep passing while thousands of branding occurrences still exist.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDoc } from "../tools/doc-links.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CANONICAL_ZH = "i18n/README.zh-CN.md";
const POINTER_ZH = "README.zh-CN.md";

const LOCALES = [
  "i18n/README.es.md",
  "i18n/README.fa_IR.md",
  "i18n/README.fr.md",
  "i18n/README.id-ID.md",
  "i18n/README.ja-JP.md",
  "i18n/README.pt-BR.md",
  "i18n/README.ru.md",
  "i18n/README.th.md",
  "i18n/README.vi.md",
  CANONICAL_ZH,
];
const ALL_READMES = ["README.md", POINTER_ZH, ...LOCALES];

// ---------------------------------------------------------------------------
// A. One canonical Chinese README, and the switcher reaches it
// ---------------------------------------------------------------------------

describe("A. the Chinese README has a single source of truth", () => {
  it("keeps both paths on disk — neither file was silently deleted", () => {
    for (const rel of [CANONICAL_ZH, POINTER_ZH]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });

  it("is the canonical copy that every Chinese switcher link resolves to", () => {
    const canonicalAbs = path.join(REPO_ROOT, CANONICAL_ZH);
    const targets = [];

    for (const rel of ALL_READMES) {
      const dir = path.dirname(path.join(REPO_ROOT, rel));
      for (const m of read(rel).matchAll(/\[[^\]]*中文[^\]]*\]\(([^)]+)\)/g)) {
        targets.push({ rel, resolved: path.resolve(dir, m[1]) });
      }
    }

    // There is at least one, and every one of them lands on the canonical file.
    expect(targets.length).toBeGreaterThan(0);
    const strays = targets.filter((t) => t.resolved !== canonicalAbs).map((t) => t.rel);
    expect(strays).toEqual([]);
  });

  it("does not let the root path become a second Chinese document", () => {
    const pointer = read(POINTER_ZH);

    // A pointer, not a translation. The real thing is ~1300 lines; anything
    // approaching that means prose has crept back in.
    expect(pointer.split("\n").length).toBeLessThan(60);
    expect(pointer).toContain(`](./${CANONICAL_ZH})`);

    // The sections that make up the actual README must not be duplicated here.
    for (const marker of ["## ⚡", "## 📖", "npm install", "docker run"]) {
      expect(pointer, `pointer should not carry "${marker}"`).not.toContain(marker);
    }
  });

  it("carries the newer content — the DXR_* runtime variables the stale copy lacked", () => {
    const zh = read(CANONICAL_ZH);
    for (const v of ["DXR_ALLOW_NETWORK", "DXR_DATA_DIR", "DXR_MASTER_KEY"]) {
      expect(zh, `${CANONICAL_ZH} should document ${v}`).toContain(v);
    }
  });

  it("offers a way back to English, which the stale copy did not", () => {
    expect(read(CANONICAL_ZH)).toContain("](../README.md)");
  });
});

// ---------------------------------------------------------------------------
// B. The five markdown corruptions stay repaired
// ---------------------------------------------------------------------------

describe("B. the Chinese README is free of the five documented corruptions", () => {
  const CORRUPTIONS = [
    ["provider name truncated from iFlow to 'i'", /^### i（/m],
    ["a code fence merged into a heading", /^#{1,6} .*```/m],
    ['assignment missing =" (NEXT_PUBLIC_BASE_URLhttp)', /NEXT_PUBLIC_BASE_URLhttp/],
    ["table cell with unbalanced backticks", /\|\s*`BASE_URL`\s*\|http/],
    ["URL scheme mangled to httplocalhost", /httplocalhost/],
  ];

  it.each(CORRUPTIONS)("does not reintroduce: %s", (_label, pattern) => {
    expect(read(CANONICAL_ZH)).not.toMatch(pattern);
  });

  it("holds for every README, not just the Chinese one", () => {
    const offenders = [];
    for (const rel of ALL_READMES) {
      const text = read(rel);
      for (const [label, pattern] of CORRUPTIONS) {
        if (pattern.test(text)) offenders.push(`${rel}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. Links and anchors resolve
// ---------------------------------------------------------------------------

describe("C. every README link and in-page anchor resolves", () => {
  it.each(ALL_READMES)("%s", (rel) => {
    const { brokenPaths, brokenAnchors } = checkDoc(REPO_ROOT, rel);
    expect({ brokenPaths, brokenAnchors }).toEqual({ brokenPaths: [], brokenAnchors: [] });
  });
});

// ---------------------------------------------------------------------------
// D. Deployment guidance matches what the server actually does
// ---------------------------------------------------------------------------

describe("D. no README hands out a wildcard bind without the opt-in", () => {
  /**
   * `cli/cli.js:128` gates every non-loopback bind behind DXR_ALLOW_NETWORK, and the
   * server refuses to start without it. A doc that shows HOSTNAME=0.0.0.0 with no gate
   * nearby is therefore both insecure and wrong — it cannot work as printed.
   */
  it.each(ALL_READMES)("%s", (rel) => {
    const lines = read(rel).split("\n");
    const ungated = [];
    lines.forEach((line, i) => {
      if (!/HOSTNAME\s*=\s*"?0\.0\.0\.0/.test(line)) return;
      // The gate may sit on the same line or within the same short block.
      const window = lines.slice(Math.max(0, i - 2), i + 4).join("\n");
      if (!/DXR_ALLOW_NETWORK/.test(window)) ungated.push(`${rel}:${i + 1}`);
    });
    expect(ungated).toEqual([]);
  });

  it("never publishes a container port on every interface", () => {
    const offenders = [];
    for (const rel of ALL_READMES) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/-p\s+([\d.:]+)/);
          if (m && !m[1].startsWith("127.0.0.1")) offenders.push(`${rel}:${i + 1} -> -p ${m[1]}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. The port the docs name is the port the product binds
// ---------------------------------------------------------------------------

describe("E. operational instructions use DXRouter's real port", () => {
  /**
   * 20127 is the real port (`cli/cli.js` DEFAULT_PORT, `Dockerfile` ENV PORT). 20128 is
   * upstream's, and `cli/cli.js:111-118` records that it is deliberately NOT a fallback.
   *
   * The locale Docker blocks are the one exception: they still document upstream's
   * published image, which genuinely listens on 20128. Correcting those is the Docker
   * work applied to 9 more files, and is deliberately not part of this change — but the
   * port there may only survive alongside an upstream image reference.
   */
  it("leaves no 20128 at all in README.md or the canonical Chinese README", () => {
    for (const rel of ["README.md", CANONICAL_ZH]) {
      expect(read(rel), rel).not.toContain("20128");
    }
  });

  it("keeps every remaining 20128 inside an upstream-image Docker block", () => {
    const stray = [];
    for (const rel of LOCALES) {
      const lines = read(rel).split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("20128")) return;
        const window = lines.slice(Math.max(0, i - 12), i + 12).join("\n");
        const upstreamImage = /decolua\/9router|ghcr\.io\/decolua|docker\s+(run|build|pull)/.test(window);
        if (!upstreamImage) stray.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(stray).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F. No document tells a user to install or pull upstream's artefacts
// ---------------------------------------------------------------------------

describe("F. README.md and the canonical Chinese README do not ship upstream's artefacts", () => {
  /** A fenced command, as opposed to prose that names upstream deliberately. */
  const commandLines = (rel) => {
    const out = [];
    let inFence = false;
    read(rel)
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          return;
        }
        if (inFence) out.push([i + 1, line]);
      });
    return out;
  };

  it.each(["README.md", CANONICAL_ZH])("%s runs no upstream image", (rel) => {
    const bad = commandLines(rel)
      .filter(([, l]) => /decolua\/9router|ghcr\.io\/decolua|9router\/9router/.test(l))
      .map(([n, l]) => `${rel}:${n}: ${l.trim()}`);
    expect(bad).toEqual([]);
  });

  it.each(["README.md", CANONICAL_ZH])("%s installs no upstream npm package", (rel) => {
    const bad = commandLines(rel)
      .filter(([, l]) => /npm\s+(install|update|uninstall)[^\n]*\s9router\b|npx\s+9router\b/.test(l))
      .map(([n, l]) => `${rel}:${n}: ${l.trim()}`);
    expect(bad).toEqual([]);
  });

  it("does not claim a published DXRouter image or npm package exists", () => {
    for (const rel of ["README.md", CANONICAL_ZH]) {
      const text = read(rel);
      // Neither artefact exists yet: the fork has no remote tags and `dxrouter` is not
      // on the npm registry. Documenting either would send users at nothing.
      expect(text, rel).not.toMatch(/docker\s+pull\s+ghcr\.io\/iamajayteli/i);
      expect(text, rel).not.toMatch(/npm\s+install\s+-g\s+dxrouter/i);
    }
  });
});

// ---------------------------------------------------------------------------
// G. Compatibility identifiers survived the identity pass
// ---------------------------------------------------------------------------

describe("G. identifiers that must stay 9router were not renamed", () => {
  /**
   * Each of these is a literal the running code compares against, so renaming it in
   * documentation would produce a config the product rejects. Verified against source:
   * `sk_9router` (ClaudeToolCard.js:175 and five siblings), `[providers.9router]`
   * (JcodeToolCard.js:194), `[model_providers.9router]` (codex-settings/route.js:79),
   * the `9router/<model>` prefix (cliTools.js:366), and the `~/.9router` data root
   * (dataDir.js:5, whose comment states renaming it orphans existing installs).
   */
  const REQUIRED = [
    ["data root", /\.9router\b/],
    ["compose volume", /9router-data/],
    ["server data root", /\/var\/lib\/9router/],
    ["deprecated DATA_DIR alias", /DATA_DIR/],
    ["localhost API key placeholder", /sk_9router/],
    ["provider key in client config", /"9router":/],
    ["wire-level model prefix", /9router\/(kr|cc)\//],
  ];

  it.each(REQUIRED)("%s is still present in README.md", (_label, pattern) => {
    expect(read("README.md")).toMatch(pattern);
  });

  it("never renamed one of them to a dxrouter spelling", () => {
    const LEAKS = [
      /sk_dxrouter/i,
      /dxrouter-data/,
      /\.dxrouter\b/,
      /\/var\/lib\/dxrouter/,
      /custom:DXRouter/,
      /X-DXRouter-Token-Saver/i,
      /images\/dxrouter\.png/,
      /"dxrouter":\s*\{/,
    ];
    const offenders = [];
    for (const rel of ALL_READMES) {
      const text = read(rel);
      for (const re of LEAKS) if (re.test(text)) offenders.push(`${rel} :: ${re}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps attribution that is about other people's work", () => {
    const readme = read("README.md");
    // OmniRoute forked 9Router, not DXRouter — the sentence is true as written.
    expect(readme).toMatch(/OmniRoute/);
    expect(readme).toMatch(/fork of 9Router/);
    // Third-party video titles say what the creators titled them.
    expect(readme).toMatch(/OpenClaw \+ 9Router/);
    // Upstream credit.
    expect(readme).toMatch(/CLIProxyAPI/);
  });
});
