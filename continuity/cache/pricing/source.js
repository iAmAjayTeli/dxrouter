/**
 * Where pricing records come from.
 *
 * A source is two functions — `keys()` and `read(key)` — which is all the loader needs
 * and the smallest thing a test can fake. Three implementations:
 *
 *  - `shippedSource()` reads the records committed next to this file. Resolved from
 *    `import.meta.url`, so it is engine-internal knowledge, not a host path: I1 stops
 *    the engine from knowing a *data root*, not from reading its own assets.
 *  - `createDirectorySource(dir)` reads any directory. The adapter points one at the
 *    operator override directory under the data root.
 *  - `layerSources(...)` stacks them, later winning. This is what makes a pricing fix
 *    deployable without a release (§9.2 "correctable without rewriting routing logic"):
 *    drop a corrected `anthropic.yaml` in the override directory and it shadows the
 *    shipped one, key by key, with no code change.
 *
 * Read errors are returned as `null` rather than thrown. A directory that does not
 * exist is the normal case for the override layer, and the loader already has a
 * well-defined path for "no file at all".
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const YAML_RE = /^([a-z0-9][a-z0-9_.-]*)\.ya?ml$/i;

/** @returns {{name: string, dir: string|null, keys: () => string[], read: (key: string) => string|null}} */
export function createDirectorySource(dir, { name = dir } = {}) {
  return {
    name,
    dir,
    keys() {
      try {
        return fs
          .readdirSync(dir)
          .map((f) => YAML_RE.exec(f)?.[1])
          .filter(Boolean)
          .map((k) => k.toLowerCase())
          .sort();
      } catch {
        return [];
      }
    },
    read(key) {
      for (const ext of [".yaml", ".yml"]) {
        try {
          return fs.readFileSync(path.join(dir, `${key}${ext}`), "utf8");
        } catch {
          /* next extension */
        }
      }
      return null;
    },
  };
}

/** The directory name holding the committed records, next to this file. */
const SHIPPED_DIR = "data";

/** Where a standalone build puts those records, relative to the process root. */
const SHIPPED_FROM_ROOT = ["continuity", "cache", "pricing", SHIPPED_DIR];

/**
 * Candidate locations for the committed records, best first.
 *
 * `import.meta.url` is read through `path.dirname`, not `new URL("./data/", …)`. A
 * bundler treats the second form as a static asset request, cannot resolve a directory
 * (`Module not found: Can't resolve './data/'`) and therefore refuses to compile every
 * route that reaches this file. Inside a server bundle that expression is also rewritten
 * to a build-machine path — the same rewrite `next.config.mjs` keeps `open` external to
 * avoid — which `fileURLToPath` can reject outright on another platform. Hence the
 * `try`, and hence the second candidate: `outputFileTracingIncludes` copies the records
 * to that path, so a standalone build finds them where the process root says they are.
 */
function shippedDirs() {
  const dirs = [];
  try {
    dirs.push(path.join(path.dirname(fileURLToPath(import.meta.url)), SHIPPED_DIR));
  } catch {
    /* a rewritten import.meta.url: the process root is the remaining answer */
  }
  dirs.push(path.join(process.cwd(), ...SHIPPED_FROM_ROOT));
  return dirs;
}

/** The records committed in this repository. */
export function shippedSource() {
  const dirs = shippedDirs();
  for (const dir of dirs) {
    const source = createDirectorySource(dir, { name: "shipped" });
    if (source.keys().length) return source;
  }
  // Readable nowhere: an empty source over the first candidate, which the loader already
  // handles as "no file at all" rather than as a failure to start.
  return createDirectorySource(dirs[0], { name: "shipped" });
}

/** Later sources shadow earlier ones, per key. */
export function layerSources(...sources) {
  const layers = sources.filter(Boolean);
  return {
    name: layers.map((s) => s.name).join("+") || "empty",
    dir: null,
    layers,
    keys() {
      const seen = new Set();
      for (const s of layers) for (const k of s.keys()) seen.add(k);
      return [...seen].sort();
    },
    read(key) {
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const text = layers[i].read(key);
        if (typeof text === "string") return text;
      }
      return null;
    },
    /** Which layer answered — reported in the pricing table so an override is visible. */
    originOf(key) {
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        if (typeof layers[i].read(key) === "string") return layers[i].name;
      }
      return null;
    },
  };
}

/** In-memory source, for tests and for the `default` synthesis path. */
export function createMemorySource(records = {}, { name = "memory" } = {}) {
  const map = new Map(Object.entries(records).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    name,
    dir: null,
    keys: () => [...map.keys()].sort(),
    read: (key) => (map.has(key) ? map.get(key) : null),
  };
}

export default shippedSource;
