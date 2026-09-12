/**
 * §15 — replay of the recorded/replayable agent workloads, and the honesty check on
 * where those recordings came from.
 *
 * §15 asks for six workloads (Claude Code-style, Cline/Roo/Aider-style, one long
 * session, one compaction, one tool change, one independent-session-with-similar-prefix)
 * and, separately, forbids labelling anything "real" that is not. Both halves are
 * tested here, because they are the same claim seen from two sides: the replay says
 * what the engine concluded, and the inventory says what the input actually was.
 *
 * The fixtures in this repository are ALL synthetic and every file says so in its own
 * `label` and `is_captured_http_traffic` fields — `no fixture claims captured traffic`
 * below asserts exactly that, so the BLOCKED report for the captured-traffic criterion
 * cannot quietly become false later: the day someone adds a genuine capture, that test
 * fails and the report has to be rewritten.
 *
 * Every tally the suite reports (`false_continuations`, `false_splits`) is derived from
 * the fixture's own `expect` block, never from the engine's answer, so a regression
 * moves the number instead of moving the target.
 */

import fs from "node:fs";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { expandContent, listFixtures, loadFixture, replayFixture } from "./helpers/fixtures.js";
import { openHarness, removeTmpDir } from "./helpers/harness.js";

const NAMES = listFixtures();
const dirs = [];
const REPORT = [];

/** The six §15 workload targets, and the fixture that stands in for each. */
const TARGETS = {
  "claude-code-style": "synthetic-claude-code-style",
  "cline-roo-aider-style": "synthetic-cline-style",
  "long-multi-turn": "synthetic-long-session",
  "context-compaction": "synthetic-compaction",
  "tool-change": "synthetic-tool-change",
  "independent-similar-prefix": "synthetic-independent-similar-prefix",
};

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTmpDir(dir);
});

/** `DXR_FIXTURE_REPORT=<path>` writes the §15 table; unset, the suite writes nothing. */
afterAll(() => {
  const out = process.env.DXR_FIXTURE_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(REPORT, null, 2), "utf8");
});

async function replay(name) {
  const fixture = loadFixture(name);
  const harness = await openHarness({ tag: "fixture" });
  dirs.push(harness.dir);
  const result = await replayFixture({ harness, fixture });
  return { fixture, harness, result };
}

/** The §15 row for one fixture: provenance, counts, and the grade of every turn. */
function reportRow(fixture, result) {
  return {
    fixture_id: fixture.fixture_id,
    label: fixture.label,
    source: fixture.source?.kind ?? null,
    is_captured_http_traffic: fixture.is_captured_http_traffic,
    turns: fixture.turns.length,
    expected_boundaries: fixture.expected_totals?.boundaries ?? null,
    observed_boundaries: result.boundaries,
    false_continuations: result.false_continuations,
    false_splits: result.false_splits,
    sessions: result.sessions.length,
    per_turn: result.records.map(({ turn, record }, i) => ({
      turn: i,
      history: turn.history ?? "main",
      identity_confidence: record.identity_confidence,
      identity_source: record.identity_source,
      relation: record.relation,
      boundary: record.boundary ?? null,
      new_session: record.created_session,
    })),
  };
}

/** One turn against its own `expect` block. Every message names the turn it failed on. */
function checkTurn(records, index) {
  const { turn, record } = records[index];
  const e = turn.expect || {};
  const at = `${turn.history ?? "main"}#${index}`;

  expect(record.observed, `${at} observed`).toBe(true);
  if (e.confidence) expect(record.identity_confidence, `${at} confidence`).toBe(e.confidence);
  if (e.source) expect(record.identity_source, `${at} source`).toBe(e.source);
  if (e.relation) expect(record.relation, `${at} relation`).toBe(e.relation);
  if ("boundary" in e) expect(record.boundary ?? null, `${at} boundary`).toBe(e.boundary);
  if ("new_session" in e) expect(record.created_session, `${at} new_session`).toBe(e.new_session);
  if (e.notes_include) expect(record.notes, `${at} notes`).toContain(e.notes_include);
  if (Array.isArray(e.notes)) expect(record.notes, `${at} notes`).toEqual(e.notes);

  if (e.same_session_as !== undefined) {
    expect(record.session_id, `${at} same session as #${e.same_session_as}`).toBe(records[e.same_session_as].record.session_id);
  }
  if (e.different_session_from !== undefined) {
    expect(record.session_id, `${at} distinct from #${e.different_session_from}`).not.toBe(
      records[e.different_session_from].record.session_id,
    );
  }
  if (e.closes_predecessor) {
    expect(record.closed_predecessor, `${at} closed a predecessor`).toBeTruthy();
    expect(record.closed_predecessor.reason, `${at} close reason`).toBe(e.boundary);
  }
  if (e.predecessor_is !== undefined) {
    expect(record.predecessor_id, `${at} predecessor`).toBe(records[e.predecessor_is].record.session_id);
  }
}

describe("§15 fixture inventory — provenance is declared, not assumed", () => {
  it("finds a fixture for each of the six workload targets", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(Object.keys(TARGETS).length);
    for (const [target, id] of Object.entries(TARGETS)) {
      expect(NAMES, `no fixture for target ${target}`).toContain(`${id}.json`);
    }
  });

  it.each(NAMES)("%s declares id, label, provenance and expected totals", (name) => {
    const fixture = loadFixture(name);
    expect(fixture.fixture_id).toBe(name.replace(/\.json$/, ""));
    expect(typeof fixture.label).toBe("string");
    expect(fixture.label.length).toBeGreaterThan(0);
    expect(typeof fixture.is_captured_http_traffic).toBe("boolean");
    expect(fixture.source?.kind, `${name} names no source kind`).toBeTruthy();
    expect(String(fixture.source?.note ?? "").length, `${name} explains no provenance`).toBeGreaterThan(20);
    expect(fixture.workload, `${name} states no workload`).toBeTruthy();
    expect(fixture.expected_totals).toBeTruthy();
    expect(fixture.turns.length).toBeGreaterThan(0);
  });

  // The load-bearing honesty test. It is written as an assertion rather than a comment
  // so the BLOCKED acceptance criterion cannot silently rot: adding a real capture to
  // this directory breaks this test, which forces the report to be updated with it.
  it("no fixture claims captured traffic, which is why criterion 17 is BLOCKED", () => {
    for (const name of NAMES) {
      const fixture = loadFixture(name);
      expect(fixture.is_captured_http_traffic, `${name} claims captured HTTP traffic`).toBe(false);
      expect(fixture.label, `${name} is labelled ${fixture.label}`).toBe("synthetic");
      expect(fixture.source.kind).toBe("handwritten");
    }
  });

  it("labels a fixture as synthetic only when the message layer is content-free", () => {
    // A synthetic fixture describes messages as `[role, bytes, id]` triples and nothing
    // else: the bytes are expanded to deterministic filler at replay time. If a message
    // op ever carried a literal string, the label would stop being true, so the shape
    // is checked rather than trusted. (Tool schemas and system prompts are handwritten
    // prose on purpose — they are the layers under test, not conversation.)
    const ROLES = new Set(["u", "a", "user", "assistant"]);
    for (const name of NAMES) {
      const fixture = loadFixture(name);
      for (const turn of fixture.turns) {
        const ops = [...(turn.append || []), ...(turn.reset || []), ...(turn.mutate ? [turn.mutate.message] : [])];
        for (const triple of ops) {
          expect(triple, `${name} turn ${turn.i}: not a triple`).toHaveLength(3);
          expect(ROLES.has(triple[0]), `${name} turn ${turn.i}: role ${triple[0]}`).toBe(true);
          expect(Number.isInteger(triple[1]), `${name} turn ${turn.i}: byte count`).toBe(true);
          expect(typeof triple[2], `${name} turn ${turn.i}: message id`).toBe("string");
        }
      }
    }
  });
});

describe.each(NAMES)("§15 replay — %s", (name) => {
  it("reaches the totals the fixture declares", async () => {
    const { fixture, harness, result } = await replay(name);
    const totals = fixture.expected_totals;

    // Recorded here rather than in a per-turn test so the report row describes the same
    // replay the totals were taken from.
    REPORT.push(reportRow(fixture, result));

    expect(result.sessions.length, "distinct sessions").toBe(totals.sessions);
    expect(result.boundaries, "observed boundaries").toBe(totals.boundaries);
    expect(result.false_continuations, "false continuations").toBe(totals.false_continuations);
    expect(result.false_splits, "false splits").toBe(totals.false_splits);
    if (totals.turns !== undefined) expect(fixture.turns.length, "turns").toBe(totals.turns);

    // The store must agree with the record: one session row per distinct id, one turn
    // row per replayed turn, and closes counted where the fixture says so.
    expect(harness.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(totals.sessions);
    expect(harness.db.get("SELECT COUNT(*) AS n FROM turns").n).toBe(fixture.turns.length);
    if (totals.closed_sessions !== undefined) {
      expect(harness.db.get("SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NOT NULL").n).toBe(totals.closed_sessions);
    }
    harness.close();
  });

  it("matches the expectation of every turn it declares one for", async () => {
    const { fixture, harness, result } = await replay(name);
    const declared = fixture.turns.filter((t) => t.expect).length;
    expect(declared, `${name} declares no expectations`).toBeGreaterThan(0);
    for (let i = 0; i < result.records.length; i += 1) checkTurn(result.records, i);
    harness.close();
  });

  it("persists the whole replay without any message content", async () => {
    const { fixture, harness, result } = await replay(name);

    // Every id the fixture ever mentioned, expanded to the filler the engine hashed.
    // If any of it reached a column, the persisted-no-bodies claim (§10, gate 11) is
    // false for this workload, not merely for the hand-written privacy case.
    const ids = new Set();
    for (const turn of fixture.turns) {
      for (const triple of [...(turn.append || []), ...(turn.reset || []), ...(turn.mutate ? [turn.mutate.message] : [])]) {
        ids.add(`${triple[2]}:${triple[1]}`);
      }
    }
    const tables = harness.db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name);
    const dump = JSON.stringify(Object.fromEntries(tables.map((t) => [t, harness.db.all(`SELECT * FROM ${t}`)])));
    for (const spec of ids) {
      const [id, bytes] = spec.split(":");
      const body = expandContent(id, Number(bytes));
      expect(dump.includes(body.slice(0, 48)), `${name}: content of ${id} was persisted`).toBe(false);
    }

    // …and the hashes of it were, for all three layers, on every turn.
    for (const { record } of result.records) {
      expect(record.layers.tools_hash === null || /^c1:[0-9a-f]{64}$/.test(record.layers.tools_hash)).toBe(true);
      expect(record.layers.system_hash === null || /^c1:[0-9a-f]{64}$/.test(record.layers.system_hash)).toBe(true);
      expect(record.layers.messages_hash).toMatch(/^c1:[0-9a-f]{64}$/);
      expect(record.layers.messages_tokens_provenance).toBe("estimated");
    }
    harness.close();
  });
});

describe("§16.16 — across the whole validated set", () => {
  it("produces no false continuation and no false split in any fixture", async () => {
    let continuations = 0;
    let splits = 0;
    let turns = 0;
    for (const name of NAMES) {
      const { fixture, harness, result } = await replay(name);
      continuations += result.false_continuations;
      splits += result.false_splits;
      turns += fixture.turns.length;
      harness.close();
    }
    expect(turns, "replayed turns").toBeGreaterThan(60);
    expect(continuations, "false continuations across the set").toBe(0);
    expect(splits, "false splits across the set").toBe(0);
  });
});
