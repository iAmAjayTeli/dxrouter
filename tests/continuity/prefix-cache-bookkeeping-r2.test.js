/**
 * Rule "r2": the two-position moved-cache-breakpoint window.
 *
 * Measured, not hypothesised. A capture of six consecutive `/v1/messages` bodies from ONE
 * real Claude Code (2.1.278) stream-json conversation, projected exactly the way
 * `adapters/ninerouter/normalizeAdapter.js` projects them (role=system/developer excluded
 * from the messages layer), gave projected counts 1,3,5,7,9,11 and this pattern:
 *
 *   pair 1->2  clean extension
 *   pair 2->3  offset [1]      messages[1].content[0].cache_control removed  (assistant)
 *   pair 3->4  offset [1]      messages[3].content[0].cache_control removed  (assistant)
 *   pair 4->5  offset [1]      messages[5].content[0].cache_control removed  (assistant)
 *   pair 5->6  offsets [0,1]   messages[7] (assistant) AND messages[8] (tool_result)
 *
 * Every differing JSON path was exactly `…content[0].cache_control` going from
 * `{"type":"ephemeral"}` to absent; `stripBookkeeping` restored exact digest equality in
 * all six changed messages; `tools_hash` and `system_hash` never moved. Because the
 * earlier of the two positions is `prev.count - 2`, r1's single-position guard refused
 * every pair and split a conversation that never ended.
 *
 * As in the r1 file, most of what follows is cases that must STILL be discontinuities:
 * the value of this rule is entirely in how narrow it is.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  MESSAGE_RELATION,
  classifyMessageSequences,
  classifyStrict,
  isPrefixContinuation,
} from "../../continuity/prefix/extension.js";
import { PREFIX_RULE_VERSION, BOOKKEEPING_FIELDS, bookkeepingDigest } from "../../continuity/prefix/bookkeeping.js";
import { CANON_VERSION } from "../../continuity/canonical/serialize.js";
import { computePrefixLayers, hashMessagesLayer } from "../../continuity/prefix/hasher.js";
import {
  RESOLUTION_ACTION,
  compareCandidate,
  layersToPrefixState,
  messagesViewOf,
  resolveSessionIdentity,
} from "../../continuity/identity/sessionResolver.js";
import { M1_LABELS } from "../../continuity/identity/confidence.js";
import { CONTINUITY_SCHEMA_VERSION } from "../../continuity/store/sqlite/schema.js";
import { MIGRATIONS, latestVersion } from "../../continuity/store/sqlite/migrations/index.js";
import { messages, openHarness, removeTmpDir, turnRequest, SYSTEM, TOOLS } from "./helpers/harness.js";

const EPHEMERAL = { type: "ephemeral" };
const bp = (block, on) => (on ? { ...block, cache_control: EPHEMERAL } : block);

const ask = (i, mark = false) => ({ role: "user", content: [bp({ type: "text", text: `ask ${i}` }, mark)] });
const callTool = (i, mark = false) => ({
  role: "assistant",
  content: [bp({ type: "tool_use", id: `tu${i}`, name: "Read", input: { file_path: `/f${i}.js` } }, mark)],
});
const toolResult = (i, mark = false) => ({
  role: "user",
  content: [bp({ type: "tool_result", tool_use_id: `tu${i}`, content: `file ${i} contents` }, mark)],
});

/** A full r2-era stored row: both boundary digests recorded. */
const recorded = (msgs) => {
  const layer = hashMessagesLayer(msgs);
  return {
    hash: layer.hash,
    count: layer.count,
    digests: layer.digests,
    final_digest_norm: layer.final_digest_norm,
    penultimate_digest_norm: layer.penultimate_digest_norm,
  };
};
/** An r1-era stored row: only the final boundary digest was ever written. */
const recordedR1 = (msgs) => {
  const r = recorded(msgs);
  delete r.penultimate_digest_norm;
  return r;
};
const incoming = (msgs) => hashMessagesLayer(msgs);

/**
 * The captured steady state, reduced to its essentials.
 *
 * PREV carries breakpoints on BOTH trailing messages (the assistant `tool_use` and the
 * `tool_result` after it). NEXT appends the next round trip and rolls both markers
 * forward, so both of PREV's last two messages lose theirs. First difference is at
 * index prev.count - 2.
 */
const PREV = [ask(0), callTool(1), toolResult(1), callTool(2, true), toolResult(2, true)];
const NEXT = [ask(0), callTool(1), toolResult(1), callTool(2), toolResult(2), callTool(3, true), toolResult(3, true)];

describe("A. the one-position r1 case still behaves exactly as before", () => {
  const ONE_PREV = [ask(0), callTool(1), toolResult(1, true)];
  const ONE_NEXT = [ask(0), callTool(1), toolResult(1), callTool(3), toolResult(3, true)];

  it("softens a marker moved off the final recorded message", () => {
    const r = classifyMessageSequences(recorded(ONE_PREV), incoming(ONE_NEXT));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.divergence_index).toBeNull();
    expect(r.reason).toBe("cache_breakpoint_moved");
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("still reports the one-position reason, distinct from the window reason", () => {
    const one = classifyMessageSequences(recorded(ONE_PREV), incoming(ONE_NEXT));
    const two = classifyMessageSequences(recorded(PREV), incoming(NEXT));
    expect(one.reason).toBe("cache_breakpoint_moved");
    expect(two.reason).toBe("cache_breakpoint_moved_window");
    expect(one.reason).not.toBe(two.reason);
  });
});

describe("B. a two-position cache_control-only window softens to extension", () => {
  it("reads the captured steady-state pattern as a continuation", () => {
    const r = classifyMessageSequences(recorded(PREV), incoming(NEXT));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(isPrefixContinuation(r.relation)).toBe(true);
    expect(r.divergence_index).toBeNull();
    expect(r.reason).toBe("cache_breakpoint_moved_window");
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("was a divergence at prev.count - 2 before the rule ran", () => {
    const strict = classifyStrict(recorded(PREV), incoming(NEXT));
    expect(strict.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(strict.divergence_index).toBe(PREV.length - 2);
  });

  it("reads a same-length retry with both markers moved as identical", () => {
    const retry = [ask(0), callTool(1), toolResult(1), callTool(2), toolResult(2)];
    const r = classifyMessageSequences(recorded(PREV), incoming(retry));
    expect(r.relation).toBe(MESSAGE_RELATION.IDENTICAL);
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("softens when only the penultimate marker moved and the final message is untouched", () => {
    // Offset [1] alone: the earlier of the two positions, final message byte-identical.
    const prev = [ask(0), callTool(1), toolResult(1), callTool(2, true), toolResult(2)];
    const next = [ask(0), callTool(1), toolResult(1), callTool(2), toolResult(2), callTool(3), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(prev), incoming(next));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.strict_divergence_index).toBe(prev.length - 2);
    expect(r.reason).toBe("cache_breakpoint_moved_window");
  });

  it("stays exact: the rule is still only the enumerated field, over the same canon", () => {
    expect(BOOKKEEPING_FIELDS).toEqual(["cache_control"]);
    expect(CANON_VERSION).toBe("c1");
    // The softening is digest equality, nothing else: both window positions normalise equal.
    expect(bookkeepingDigest(PREV[PREV.length - 1])).toBe(bookkeepingDigest(NEXT[PREV.length - 1]));
    expect(bookkeepingDigest(PREV[PREV.length - 2])).toBe(bookkeepingDigest(NEXT[PREV.length - 2]));
  });
});

describe("C/D. anything beyond a cache_control move stays a discontinuity", () => {
  const stays = (r, reason) => {
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(isPrefixContinuation(r.relation)).toBe(false);
    expect(r.normalized_by).toBeNull();
    expect(r.reason).toBe(reason);
  };

  it("C. does not soften a real content mutation at the penultimate position", () => {
    const edited = { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/EDITED.js" } }] };
    const next = [ask(0), callTool(1), toolResult(1), edited, toolResult(2), callTool(3, true), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(PREV), incoming(next));
    stays(r, "boundary_differs_beyond_cache_bookkeeping");
    expect(r.strict_divergence_index).toBe(PREV.length - 2);
  });

  it("C. does not soften an extra field appearing at the penultimate position", () => {
    const tampered = {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/f2.js" }, cache_hint: "ephemeral" }],
    };
    const next = [ask(0), callTool(1), toolResult(1), tampered, toolResult(2), callTool(3, true), toolResult(3, true)];
    stays(classifyMessageSequences(recorded(PREV), incoming(next)), "boundary_differs_beyond_cache_bookkeeping");
  });

  it("C. does not soften a role change at the penultimate position", () => {
    const moved = { ...callTool(2), role: "user" };
    const next = [ask(0), callTool(1), toolResult(1), moved, toolResult(2), callTool(3, true), toolResult(3, true)];
    stays(classifyMessageSequences(recorded(PREV), incoming(next)), "boundary_differs_beyond_cache_bookkeeping");
  });

  it("C. does not soften when the penultimate normalises equal but the final does not", () => {
    // Window position count-2 is a clean marker move; count-1 really changed. The whole
    // window must match, so this is still a discontinuity.
    const editedFinal = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "file 2 EDITED" }] };
    const next = [ask(0), callTool(1), toolResult(1), callTool(2), editedFinal, callTool(3, true), toolResult(3, true)];
    stays(classifyMessageSequences(recorded(PREV), incoming(next)), "boundary_differs_beyond_cache_bookkeeping");
  });

  it("D. a divergence at prev.count - 3 stays a divergence", () => {
    const next = [ask(0), callTool(1), toolResult(1, true), callTool(2), toolResult(2), callTool(3, true), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(PREV), incoming(next));
    stays(r, "divergence_not_at_recorded_boundary");
    expect(r.strict_divergence_index).toBe(PREV.length - 3);
  });

  it("D. a divergence at index 0 of a long prefix stays a divergence", () => {
    const next = [ask(0, true), callTool(1), toolResult(1), callTool(2), toolResult(2), callTool(3, true), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(PREV), incoming(next));
    stays(r, "divergence_not_at_recorded_boundary");
    expect(r.strict_divergence_index).toBe(0);
  });
});

describe("E. missing evidence fails closed", () => {
  it("refuses the two-position path when no penultimate digest was recorded", () => {
    const r = classifyMessageSequences(recordedR1(PREV), incoming(NEXT));
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.normalized_by).toBeNull();
    expect(r.reason).toBe("no_normalized_penultimate_digest_recorded");
  });

  it("refuses when the final digest is missing even though the penultimate is present", () => {
    const row = { ...recorded(PREV), final_digest_norm: null };
    const r = classifyMessageSequences(row, incoming(NEXT));
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.reason).toBe("no_normalized_boundary_digest_recorded");
  });

  it("refuses when the incoming accessor is absent", () => {
    const view = incoming(NEXT);
    const r = classifyMessageSequences(recorded(PREV), { ...view, normalized_digest_at: null });
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.reason).toBe("normalized_boundary_digest_unavailable");
  });
});

describe("F. an r1-era observation keeps its provenance and is not reinterpreted", () => {
  it("leaves a stored r1 row's rule version exactly as written", () => {
    const row = { ...recordedR1(PREV), prefix_rule_version: "r1" };
    const r = classifyMessageSequences(row, incoming(NEXT));
    // The row is untouched by classification, and it still says r1.
    expect(row.prefix_rule_version).toBe("r1");
    // And the verdict is not softened, because the evidence r2 needs was never written.
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.normalized_by).toBeNull();
  });

  it("does not recompute the missing penultimate digest from anything it holds", () => {
    // The row holds digests and never messages, so there is nothing to derive from. The
    // guard is data-level, not a version-string check: absent value => fail closed.
    const row = recordedR1(PREV);
    expect(row.penultimate_digest_norm).toBeUndefined();
    expect(classifyMessageSequences(row, incoming(NEXT)).reason).toBe("no_normalized_penultimate_digest_recorded");
  });

  it("still honours a legacy row on the one-position path, as r1 did", () => {
    const ONE_PREV = [ask(0), callTool(1), toolResult(1, true)];
    const ONE_NEXT = [ask(0), callTool(1), toolResult(1), callTool(3), toolResult(3, true)];
    const r = classifyMessageSequences(recordedR1(ONE_PREV), incoming(ONE_NEXT));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.reason).toBe("cache_breakpoint_moved");
  });
});

describe("G. the 5 -> 6 migration is additive and idempotent", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });
  const harness = async () => {
    const h = await openHarness({ tag: "r2mig" });
    open.push(h);
    return h;
  };

  it("registers migration 006 and reaches schema version 6", () => {
    expect(CONTINUITY_SCHEMA_VERSION).toBe(6);
    expect(latestVersion()).toBe(CONTINUITY_SCHEMA_VERSION);
    const m006 = MIGRATIONS.find((m) => m.version === 6);
    expect(m006).toBeTruthy();
    expect(m006.name).toBe("prefix-penultimate-norm");
  });

  it("adds penultimate_digest_norm to session_prefix without touching anything else", async () => {
    const h = await harness();
    const cols = h.db.all("PRAGMA table_info(session_prefix)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["final_digest_norm", "prefix_rule_version", "penultimate_digest_norm"]));
    const col = h.db.all("PRAGMA table_info(session_prefix)").find((c) => c.name === "penultimate_digest_norm");
    expect(col.type).toBe("TEXT");
    // Nullable, no default: an existing row is truthfully "not recorded".
    expect(col.notnull).toBe(0);
    expect(col.dflt_value == null).toBe(true);
  });

  it("is re-runnable on an already-migrated database", async () => {
    const h = await harness();
    const before = h.db.all("PRAGMA table_info(session_prefix)").length;
    const m006 = MIGRATIONS.find((m) => m.version === 6);
    m006.up(h.db);
    m006.up(h.db);
    expect(h.db.all("PRAGMA table_info(session_prefix)").length).toBe(before);
  });
});

describe("H. short message lists behave correctly", () => {
  it("reports no boundary digests for an empty list", () => {
    const layer = hashMessagesLayer([]);
    expect(layer.count).toBe(0);
    expect(layer.final_digest_norm).toBeNull();
    expect(layer.penultimate_digest_norm).toBeNull();
  });

  it("reports only a final digest for a single message", () => {
    const layer = hashMessagesLayer([ask(0)]);
    expect(layer.count).toBe(1);
    expect(layer.final_digest_norm).toBe(bookkeepingDigest(ask(0)));
    expect(layer.penultimate_digest_norm).toBeNull();
  });

  it("reports both digests for two messages", () => {
    const msgs = [ask(0), callTool(1, true)];
    const layer = hashMessagesLayer(msgs);
    expect(layer.count).toBe(2);
    expect(layer.final_digest_norm).toBe(bookkeepingDigest(msgs[1]));
    expect(layer.penultimate_digest_norm).toBe(bookkeepingDigest(msgs[0]));
  });

  it("reports nulls when the request carries no messages layer at all", () => {
    const layer = hashMessagesLayer(null);
    expect(layer.count).toBeNull();
    expect(layer.final_digest_norm).toBeNull();
    expect(layer.penultimate_digest_norm).toBeNull();
    expect(layer.normalized_digest_at(0)).toBeNull();
  });

  it("softens a two-message prefix whose only marker moved, with no index underflow", () => {
    const prev = [ask(0), callTool(1, true)];
    const next = [ask(0), callTool(1), toolResult(1, true)];
    const r = classifyMessageSequences(recorded(prev), incoming(next));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("softens a one-message prefix whose only marker moved", () => {
    const prev = [ask(0, true)];
    const next = [ask(0), callTool(1, true)];
    const r = classifyMessageSequences(recorded(prev), incoming(next));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.reason).toBe("cache_breakpoint_moved");
  });
});

describe("I. the strict verdict is preserved and recorded", () => {
  it("keeps strict_relation and strict_divergence_index on a softened window", () => {
    const r = classifyMessageSequences(recorded(PREV), incoming(NEXT));
    expect(r.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.strict_divergence_index).toBe(PREV.length - 2);
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.divergence_index).toBeNull();
  });

  it("carries both verdicts through the flat prefix state and the messages view", () => {
    const layers = computePrefixLayers({ tools: TOOLS, system: SYSTEM, messages: PREV });
    const flat = layersToPrefixState(layers);
    expect(flat.final_digest_norm).toBe(layers.messages.final_digest_norm);
    expect(flat.penultimate_digest_norm).toBe(layers.messages.penultimate_digest_norm);
    expect(flat.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
    const view = messagesViewOf(flat);
    expect(view.penultimate_digest_norm).toBe(flat.penultimate_digest_norm);
  });

  it("still reports a clean extension with no rule applied", () => {
    const A = messages(3);
    const r = classifyMessageSequences(recorded(A), incoming([...A, ...messages(2, "more-")]));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.strict_relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.normalized_by).toBeNull();
  });
});

describe("the resolver acts on a softened window and says that it did", () => {
  const candidateFor = (msgs, { id = "cand" } = {}) => ({
    session: { id, client_key: null },
    prefix: layersToPrefixState(computePrefixLayers({ tools: TOOLS, system: SYSTEM, messages: msgs })),
  });
  const layersFor = (msgs, { tools = TOOLS, system = SYSTEM } = {}) =>
    computePrefixLayers({ tools, system, messages: msgs });

  it("carries the window softening through compareCandidate", () => {
    const c = compareCandidate(candidateFor(PREV).prefix, layersFor(NEXT));
    expect(c.relation.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(c.relation.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(c.relation.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("continues an inferred session and labels the softening", () => {
    const r = resolveSessionIdentity({ layers: layersFor(NEXT), candidates: [candidateFor(PREV)] });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("cand");
    expect(r.strict_divergence_index).toBe(PREV.length - 2);
    expect(r.labels).toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    expect(r.notes).toContain(`strict_prefix_divergence_at:${PREV.length - 2}`);
    expect(r.notes).toContain(`prefix_normalized_by:${PREFIX_RULE_VERSION}`);
  });

  it("continues an explicitly keyed session instead of closing it", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(NEXT),
      explicitKey: "k-window",
      explicitCandidate: candidateFor(PREV, { id: "keyed" }),
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("keyed");
    expect(r.close_predecessor).toBeNull();
  });

  it("keeps the lineage when tools changed, reporting the window softening and the transition", () => {
    const otherTools = [...TOOLS, { name: "run", description: "run a command", parameters: { type: "object" } }];
    const r = resolveSessionIdentity({
      layers: layersFor(NEXT, { tools: otherTools }),
      candidates: [candidateFor(PREV)],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
    expect(r.invalidated).toContain("tools");
    expect(r.notes).not.toContain("candidates_dropped_on_tools_or_system_change");
  });
});

describe("end to end: the captured steady state lands in ONE session", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });
  const harness = async () => {
    const h = await openHarness({ tag: "r2e2e" });
    open.push(h);
    return h;
  };

  it("observes two turns as one session, with no session key sent", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: PREV }));
    h.tick(4000);
    const second = await h.observe(turnRequest({ msgs: NEXT }));

    expect(second.session_id).toBe(first.session_id);
    expect(second.created_session).toBe(false);
    expect(second.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(second.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(second.strict_divergence_index).toBe(PREV.length - 2);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(1);
  });

  it("persists the penultimate digest as a digest, not content", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: PREV }));
    const row = h.db.get("SELECT * FROM session_prefix WHERE session_id = ?", [first.session_id]);
    expect(row.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
    expect(row.penultimate_digest_norm).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(row.penultimate_digest_norm).toBe(bookkeepingDigest(PREV[PREV.length - 2]));
    const leaked = Object.values(row).filter((v) => typeof v === "string" && v.includes("file 2 contents"));
    expect(leaked).toEqual([]);
  });

  it("keeps a pre-r2 row interpretable: it splits, exactly as it did before", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: PREV }));
    // Simulate a row written by a build that predates r2.
    h.db.run("UPDATE session_prefix SET penultimate_digest_norm = NULL, prefix_rule_version = 'r1' WHERE session_id = ?", [
      first.session_id,
    ]);
    h.tick(4000);
    const second = await h.observe(turnRequest({ msgs: NEXT }));
    expect(second.session_id).not.toBe(first.session_id);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(2);
  });

  it("still opens a second session when a window message really changed", async () => {
    const h = await harness();
    const edited = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "file 2 EDITED" }] };
    const first = await h.observe(turnRequest({ msgs: PREV }));
    h.tick(4000);
    const second = await h.observe(
      turnRequest({ msgs: [ask(0), callTool(1), toolResult(1), callTool(2), edited, callTool(3, true), toolResult(3, true)] }),
    );
    expect(second.session_id).not.toBe(first.session_id);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(2);
  });
});
