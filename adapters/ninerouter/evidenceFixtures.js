/**
 * `evidenceFixtures` — where replay fixtures are read from on this host.
 *
 * The fixture *format* is engine knowledge (`continuity/evidence/fixtures.js` is the one
 * interpreter). The fixture *location* is not, so it lives here (I1).
 *
 * Three directories, in precedence order, and every one of them that exists is read:
 *
 *   1. `DXR_FIXTURE_DIR`                  an explicit operator override
 *   2. `<data root>/evidence/fixtures/`   fixtures an operator added on this machine
 *   3. the repository's `tests/fixtures/` a development checkout's committed fixtures
 *
 * First directory to supply a given `fixture_id` wins, so an operator can correct a
 * shipped fixture by name without editing the checkout. Directory 3 is absent in an
 * installed package, which is the normal case and not an error: a host with no fixtures
 * makes the replay measures report BLOCKED with `no_fixtures`, which is the honest
 * outcome rather than a zero.
 *
 * Both repository subdirectories are read. `sessions/` is M1's §15 population and is left
 * exactly as M1 shipped it — nothing here writes to it, and no fixture was added to it,
 * so the §15 report's fixture set is unchanged. `cache/` holds fixtures that additionally
 * declare per-turn provider usage, which only M2's replay reads.
 *
 * Provenance is never inferred here. `fixtureSource` reads what a fixture declares, and
 * every fixture in this repository declares `synthetic`.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../src/lib/dataDir.js";
import { prepareFixture, fixtureSource } from "../../continuity/evidence/fixtures.js";

/** `<data root>/evidence/fixtures/` — kept in step with `src/lib/dataDir.js`, one root. */
export const OPERATOR_FIXTURE_DIR = path.join(DATA_DIR, "evidence", "fixtures");

/** The committed fixtures, relative to this file so a CLI run from anywhere finds them. */
const REPO_FIXTURE_DIRS = Object.freeze([
  path.resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "sessions"),
  path.resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "cache"),
]);

/** The directories that will be searched, in order, whether or not they exist. */
export function fixtureDirs({ env = process.env, dir = null } = {}) {
  const out = [];
  if (dir) out.push(path.resolve(dir));
  else if (env.DXR_FIXTURE_DIR) out.push(path.resolve(env.DXR_FIXTURE_DIR));
  out.push(OPERATOR_FIXTURE_DIR, ...REPO_FIXTURE_DIRS);
  return Object.freeze(out);
}

/**
 * Whether an explicitly named path should be the *whole* population.
 *
 * `--fixture` names what to measure, so it excludes the shipped fixtures rather than
 * ranking above them. That distinction matters for provenance: an operator who points the
 * CLI at their own captured fixtures must not silently get this repository's synthetic ones
 * mixed into the same `n`. `DXR_FIXTURE_DIR` keeps its original additive precedence,
 * because that is the behaviour it shipped with.
 */
function resolveTargets(env, dir) {
  if (!dir) return { dirs: fixtureDirs({ env }), files: null };
  const full = path.resolve(dir);
  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }
  // A single named file is a population of one, which is how a fixture gets re-run in
  // isolation after it is corrected.
  if (stat?.isFile()) return { dirs: [path.dirname(full)], files: [full] };
  return { dirs: [full], files: null };
}

function readDir(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    // Missing or unreadable is the normal case for two of the three directories.
    return [];
  }
}

/**
 * Every fixture this host can see, parsed and turn-expanded once.
 *
 * A file that will not parse is skipped with a diagnostic rather than thrown: one bad
 * fixture must degrade that fixture, not the whole measurement — the same rule §9.3
 * applies to a bad pricing record.
 *
 * @param {object} [args]
 * @param {object} [args.env]
 * @param {string|null} [args.dir] an explicit fixture path (`--fixture`): a directory, or a
 *        single `.json` file. Either way it becomes the entire population.
 * @returns {{fixtures: Array<object>, diagnostics: Array<{file: string, message: string}>,
 *            dirs: string[]}}
 */
export function loadFixtures({ env = process.env, dir = null } = {}) {
  const { dirs, files } = resolveTargets(env, dir);
  const fixtures = [];
  const diagnostics = [];
  const seen = new Set();

  for (const d of dirs) {
    for (const file of files ? files.map((f) => path.basename(f)) : readDir(d)) {
      const full = path.join(d, file);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (e) {
        diagnostics.push({ file: full, message: `unreadable fixture: ${e.message}` });
        continue;
      }
      const id = parsed?.fixture_id ?? file.replace(/\.json$/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      fixtures.push({ ...prepareFixture(parsed), fixture_id: id, __file: full, __source: fixtureSource(parsed) });
    }
  }

  return { fixtures, diagnostics, dirs: dirs.filter((d) => readDir(d).length > 0) };
}

export default loadFixtures;
