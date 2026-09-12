/**
 * The fixture program format, and the one implementation of it.
 *
 * A fixture is a *program*, not a transcript: each turn says what happened to the
 * message history (append, reset, mutate one historical message, reorder two, truncate)
 * and messages are triples `[role, bytes, id]` expanded to deterministic filler of
 * exactly `bytes` length, seeded by `id`. Two reasons for that shape: it carries no
 * prose, so a fixture can describe real traffic structure without copying anything
 * anyone wrote; and identity is what the engine keys on, so `id` equality is exactly the
 * property under test.
 *
 * This lived in `tests/continuity/helpers/fixtures.js` in M1. §19.4 says there is one
 * replay implementation shared by the research harness and the ship gate, and a replayer
 * inside `continuity/` cannot import a helper out of `tests/` (I1). So the interpreter
 * moved here and the test helper delegates to it — the alternative was two expanders
 * that would eventually disagree about what a fixture means, which would make every
 * measured number unfalsifiable.
 *
 * No filesystem knowledge lives here: a fixture arrives as a parsed object. Where
 * fixtures are kept is host knowledge, and I1 keeps host knowledge out of the engine.
 */

import { createHash } from "node:crypto";

/** §15: a fixture must declare its own provenance, and `captured` is never inferred. */
export const FIXTURE_SOURCES = Object.freeze(["synthetic", "captured"]);

/** Deterministic filler of exactly `bytes` length, seeded by `id`. */
export function expandContent(id, bytes) {
  const seed = createHash("sha256").update(String(id)).digest("hex");
  if (bytes <= 0) return "";
  let out = "";
  let round = 0;
  while (out.length < bytes) {
    out += round === 0 ? seed : createHash("sha256").update(`${seed}${round}`).digest("hex");
    round += 1;
  }
  return out.slice(0, bytes);
}

/** `[role, bytes, id]` to a message object. */
export function expandMessage(triple) {
  const [role, bytes, id] = triple;
  const full = role === "a" || role === "assistant" ? "assistant" : "user";
  return { role: full, content: expandContent(id, bytes) };
}

/**
 * Expand `repeat` turns. A long session is mechanical by nature — the same append, many
 * times — and writing it out forty times would hide the one thing a reader needs to
 * check, which is that every message id is distinct. `{i}` in an id becomes the
 * iteration number.
 */
export function expandTurns(turns) {
  const out = [];
  const stamp = (m, i) => m.map((v) => (typeof v === "string" ? v.replace(/\{i\}/g, String(i)) : v));
  for (const turn of turns) {
    const times = Number.isInteger(turn.repeat) ? turn.repeat : 1;
    for (let i = 0; i < times; i += 1) {
      const copy = { ...turn };
      delete copy.repeat;
      copy.iteration = i;
      if (Array.isArray(turn.append)) copy.append = turn.append.map((m) => stamp(m, i));
      if (Array.isArray(turn.reset)) copy.reset = turn.reset.map((m) => stamp(m, i));
      out.push(copy);
    }
  }
  return out.map((t, i) => ({ ...t, i }));
}

/**
 * Apply one turn's history operations. Returns the new history.
 *
 * Ordering matters and is fixed: reset replaces, mutate rewrites in place, reorder
 * swaps, append extends, truncate shortens. A turn may combine them (a divergent restart
 * is a reset plus an append), which is what lets a fixture describe a real client's
 * behaviour without spelling out the whole array again.
 */
export function applyTurn(history, turn) {
  let next = history.slice();
  if (Array.isArray(turn.reset)) next = turn.reset.map((m) => m.slice());
  if (turn.mutate) next[turn.mutate.index] = turn.mutate.message.slice();
  if (turn.reorder) {
    const [i, j] = turn.reorder;
    [next[i], next[j]] = [next[j], next[i]];
  }
  if (Array.isArray(turn.append)) next = next.concat(turn.append.map((m) => m.slice()));
  if (Number.isInteger(turn.truncate)) next = next.slice(0, turn.truncate);
  return next;
}

/** Turn expansion applied once, so a fixture can be replayed twice without drifting. */
export function prepareFixture(fixture) {
  return { ...fixture, turns: expandTurns(fixture?.turns || []) };
}

/**
 * The provenance of a fixture, from what it declares — never from its contents.
 *
 * A fixture that says nothing is `synthetic`: §15 requires that `captured` be an
 * explicit claim, because the whole point of the label is that someone stands behind it.
 */
export function fixtureSource(fixture) {
  if (fixture?.is_captured_http_traffic === true) return "captured";
  const label = String(fixture?.label ?? "").trim().toLowerCase();
  return FIXTURE_SOURCES.includes(label) ? label : "synthetic";
}

/**
 * Where a fixture's *expected* provider counts came from, as the fixture declares it.
 *
 * `engine_estimator` is the honest label for a hand-written fixture whose `usage` numbers
 * were computed with this engine's own token estimator. Comparing a prediction against
 * such a number measures self-consistency and nothing else, so the value travels with the
 * replay and a measure that scores accuracy has to say so out loud. `null` means the
 * fixture makes no claim; only `captured` traffic can carry a provider's own arithmetic.
 */
export function fixtureExpectationBasis(fixture) {
  const v = fixture?.expectation_basis;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The project kind a fixture claims, for the Q2 "at least three project kinds" rule. */
export function fixtureProjectKind(fixture) {
  return fixture?.project_kind ?? fixture?.workload ?? fixture?.fixture_id ?? null;
}

export default prepareFixture;
