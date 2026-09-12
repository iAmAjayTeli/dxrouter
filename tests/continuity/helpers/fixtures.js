/**
 * Fixture loading and replay for section 15.
 *
 * A fixture is a *program*, not a transcript: each turn says what happened to the
 * message history (append, reset, mutate one historical message, reorder two) and what
 * the engine is expected to conclude. Messages are triples `[role, bytes, id]` and are
 * expanded to deterministic filler of exactly `bytes` length, seeded by `id`.
 *
 * Two reasons for that shape:
 *
 *  1. it carries no prose, so a fixture can describe real traffic structure without
 *     copying anything anyone wrote (`scripts/derive-session-fixture.mjs` emits the
 *     same shape from a transcript);
 *  2. identity is what the engine actually keys on, so `id` equality is exactly the
 *     property under test: same id, same bytes, same hash.
 *
 * Every fixture in `tests/fixtures/sessions/` states its own `label`. This repository
 * ships only `synthetic` ones; see the section 15 report for why the captured-traffic
 * criterion is BLOCKED.
 */

import fs from "node:fs";
import path from "node:path";

// One implementation of the fixture program, in the engine (section 19.4). This file
// keeps only what the engine may not know: where the fixtures live, and the M1
// identity replayer that drives a real store.
import {
  applyTurn,
  expandContent,
  expandMessage,
  expandTurns,
  fixtureProjectKind,
  fixtureSource,
  prepareFixture,
} from "../../../continuity/evidence/fixtures.js";

export { applyTurn, expandContent, expandMessage, expandTurns, fixtureProjectKind, fixtureSource };

export const FIXTURE_DIR = path.resolve(import.meta.dirname, "..", "..", "fixtures", "sessions");

export function loadFixture(name) {
  const file = path.join(FIXTURE_DIR, name.endsWith(".json") ? name : `${name}.json`);
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  fixture.__file = file;
  fixture.turns = prepareFixture(fixture).turns;
  return fixture;
}

export function listFixtures() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/**
 * Replay a whole fixture against a harness, one observation per turn.
 *
 * Returns the observation records plus the tallies section 15 asks to report:
 * `false_continuations` (the engine joined a session the fixture says is a different
 * conversation) and `false_splits` (the engine opened a new session where the fixture
 * says the conversation continued). Both are derived from the fixture's own
 * expectations, never from the engine's output, so a bug cannot move the goalposts.
 *
 * @param {object} args
 * @param {object} args.harness output of openHarness
 * @param {object} args.fixture output of loadFixture
 * @param {number} [args.gapMs] clock advance between turns
 */
export async function replayFixture({ harness, fixture, gapMs = 1000 }) {
  const layerSets = fixture.layer_sets || {};
  const records = [];
  // Named histories, so a fixture can interleave two conversations the way two agent
  // windows on one repository actually do. Unnamed turns share one history.
  const histories = new Map();
  let layerKey = null;
  let falseContinuations = 0;
  let falseSplits = 0;
  let boundaries = 0;

  for (const turn of fixture.turns) {
    if (turn.layers) layerKey = turn.layers;
    const layers = layerSets[layerKey] || {};
    const name = turn.history ?? "main";
    const history = applyTurn(histories.get(name) ?? [], turn);
    histories.set(name, history);

    const record = await harness.observe({
      tools: layers.tools ?? null,
      system: layers.system ?? null,
      messages: history.map(expandMessage),
      protocol: fixture.protocol || "openai",
      model: fixture.model || "model-under-test",
      client_hint: {
        session_key: turn.key ?? null,
        project_root: turn.project_root ?? fixture.project_root ?? "/repo/fixture",
      },
    });
    records.push({ turn, record });
    if (record.boundary) boundaries += 1;

    const expected = turn.expect || {};
    if (expected.new_session === true && record.created_session === false) falseContinuations += 1;
    if (expected.new_session === false && record.created_session === true) falseSplits += 1;
    // A turn the fixture says belongs to an earlier session must land in that session.
    if (expected.same_session_as !== undefined) {
      const target = records[expected.same_session_as]?.record?.session_id;
      if (record.session_id !== target) falseSplits += 1;
    }
    if (expected.different_session_from !== undefined) {
      const other = records[expected.different_session_from]?.record?.session_id;
      if (record.session_id === other) falseContinuations += 1;
    }

    harness.tick(gapMs);
  }

  return {
    records,
    sessions: [...new Set(records.map((r) => r.record.session_id))],
    boundaries,
    false_continuations: falseContinuations,
    false_splits: falseSplits,
  };
}
