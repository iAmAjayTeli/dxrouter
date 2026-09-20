/**
 * The moved-cache-breakpoint rule (prefix/bookkeeping.js), one-position cases.
 *
 * Measured, not hypothesised: a bounded capture of real Claude Code traffic through the
 * local gateway showed `cache_control: {"type":"ephemeral"}` moving onto the newest
 * message and off the message that had been newest, with the rest of that message
 * byte-identical (same `tool_use_id`, same content, same content hash). Under strict
 * canonical hashing that splits one conversation into two sessions, at exactly index
 * prev.count - 1 every time.
 *
 * The message shapes below reproduce that captured pattern: a `tool_result` block that
 * carries the breakpoint while it is trailing and loses it once it is history.
 *
 * Rule `r2` later widened the tolerated position to prev.count - 2 as well, after a
 * six-request capture measured the same client keeping two rolling breakpoints. Those
 * cases live in `prefix-cache-bookkeeping-r2.test.js`; this file keeps the
 * one-position behaviour and the narrowness guarantees.
 *
 * What these tests are really guarding is the *narrowness* of the rule. A relaxation
 * that is too wide is a false continuation — one conversation reading another's prefix
 * state — so most of this file is cases that must still be discontinuities.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  MESSAGE_RELATION,
  classifyMessageSequences,
  classifyStrict,
  isPrefixContinuation,
} from "../../continuity/prefix/extension.js";
import {
  BOOKKEEPING_FIELDS,
  PREFIX_RULE_VERSION,
  bookkeepingDigest,
  stripBookkeeping,
} from "../../continuity/prefix/bookkeeping.js";
import { computePrefixLayers, hashMessagesLayer } from "../../continuity/prefix/hasher.js";
import { digest } from "../../continuity/canonical/serialize.js";
import {
  RESOLUTION_ACTION,
  compareCandidate,
  layersToPrefixState,
  resolveSessionIdentity,
} from "../../continuity/identity/sessionResolver.js";
import { IDENTITY_CONFIDENCE, IDENTITY_SOURCE, M1_LABELS } from "../../continuity/identity/confidence.js";
import { messages, openHarness, removeTmpDir, turnRequest, SYSTEM, TOOLS } from "./helpers/harness.js";

const EPHEMERAL = { type: "ephemeral" };
const bp = (block, on) => (on ? { ...block, cache_control: EPHEMERAL } : block);

/** The three message shapes the capture contained. `mark` places the breakpoint. */
const ask = (i, mark = false) => ({ role: "user", content: [bp({ type: "text", text: `ask ${i}` }, mark)] });
const callTool = (i, mark = false) => ({
  role: "assistant",
  content: [bp({ type: "tool_use", id: `tu${i}`, name: "Read", input: { file_path: `/f${i}.js` } }, mark)],
});
const toolResult = (i, mark = false) => ({
  role: "user",
  content: [bp({ type: "tool_result", tool_use_id: `tu${i}`, content: `file ${i} contents` }, mark)],
});

/** What the store keeps for a session, including the boundary digests it now records. */
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
/** What a fresh request produces: chain plus the lazy normalized-digest accessor. */
const incoming = (msgs) => hashMessagesLayer(msgs);

/** Request 1 of the captured conversation: the breakpoint sits on the trailing message. */
const FIRST = [ask(0), callTool(1), toolResult(1, true)];
/** Request 2: the same three messages, breakpoint moved to the new trailing message. */
const SECOND = [ask(0), callTool(1), toolResult(1), callTool(3), toolResult(3, true)];

describe("the strict test still decides every ordinary case", () => {
  it("leaves a normal prefix extension alone, with no rule applied", () => {
    const A = messages(3);
    const r = classifyMessageSequences(recorded(A), incoming([...A, ...messages(2, "more-")]));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.strict_relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.strict_divergence_index).toBeNull();
    expect(r.normalized_by).toBeNull();
  });

  it("leaves an identical resend alone", () => {
    const A = messages(3);
    const r = classifyMessageSequences(recorded(A), incoming(A));
    expect(r.relation).toBe(MESSAGE_RELATION.IDENTICAL);
    expect(r.normalized_by).toBeNull();
  });

  it("never touches a strict digest: only the named fields are removed", () => {
    expect(BOOKKEEPING_FIELDS).toEqual(["cache_control"]);
    const plain = toolResult(1);
    // No bookkeeping field present => the normalized digest IS the strict digest.
    expect(bookkeepingDigest(plain)).toBe(digest(plain));
    expect(stripBookkeeping(plain)).toBe(plain);
    // Present => a different digest, and the strict one is unaffected.
    const marked = toolResult(1, true);
    expect(digest(marked)).not.toBe(digest(plain));
    expect(bookkeepingDigest(marked)).toBe(digest(plain));
  });
});

describe("the one softened case: a breakpoint moved off the recorded boundary", () => {
  it("reads the captured pattern as a continuation", () => {
    const r = classifyMessageSequences(recorded(FIRST), incoming(SECOND));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(isPrefixContinuation(r.relation)).toBe(true);
    expect(r.divergence_index).toBeNull();
    expect(r.reason).toBe("cache_breakpoint_moved");
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("keeps the strict verdict on the record rather than replacing it", () => {
    const r = classifyMessageSequences(recorded(FIRST), incoming(SECOND));
    expect(r.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.strict_divergence_index).toBe(FIRST.length - 1);
    // And the unrelaxed function is still callable on its own, for measurement.
    const strict = classifyStrict(recorded(FIRST), incoming(SECOND));
    expect(strict.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(strict.divergence_index).toBe(FIRST.length - 1);
  });

  it("reads a same-length retry with a moved breakpoint as identical", () => {
    const retry = [ask(0), callTool(1), toolResult(1)];
    const r = classifyMessageSequences(recorded(FIRST), incoming(retry));
    expect(r.relation).toBe(MESSAGE_RELATION.IDENTICAL);
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });

  it("softens the boundary when several legitimate breakpoints are in play", () => {
    // Two breakpoints; the historical one stays put, the trailing one moves.
    const prev = [ask(0, true), callTool(1), toolResult(1, true)];
    const next = [ask(0, true), callTool(1), toolResult(1), callTool(3), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(prev), incoming(next));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.strict_divergence_index).toBe(2);
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
  });
});

describe("everything else remains a genuine discontinuity", () => {
  const stays = (r, reason) => {
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(isPrefixContinuation(r.relation)).toBe(false);
    expect(r.normalized_by).toBeNull();
    expect(r.reason).toBe(reason);
  };

  it("does not ignore a breakpoint on a historical message outside the window", () => {
    // Rule r2 tolerates prev.count - 1 and prev.count - 2. This marker moves at index 1
    // of a five-message prefix — prev.count - 4 — so it is a real discontinuity.
    const prev5 = [ask(0), callTool(1), toolResult(1), callTool(2), toolResult(2, true)];
    const next = [ask(0), callTool(1, true), toolResult(1), callTool(2), toolResult(2), callTool(3), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(prev5), incoming(next));
    stays(r, "divergence_not_at_recorded_boundary");
    expect(r.strict_divergence_index).toBe(1);
  });

  it("does not ignore a historical breakpoint that disappeared", () => {
    const prev = [ask(0, true), callTool(1), toolResult(1, true)];
    const next = [ask(0), callTool(1), toolResult(1), callTool(3), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(prev), incoming(next));
    stays(r, "divergence_not_at_recorded_boundary");
    expect(r.strict_divergence_index).toBe(0);
  });

  it("does not soften a real content mutation at the boundary", () => {
    const edited = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file 1 EDITED" }] };
    const next = [ask(0), callTool(1), edited, callTool(3), toolResult(3, true)];
    const r = classifyMessageSequences(recorded(FIRST), incoming(next));
    stays(r, "boundary_differs_beyond_cache_bookkeeping");
    expect(r.strict_divergence_index).toBe(2);
  });

  it("does not soften an arbitrary field change at the boundary", () => {
    const tampered = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "file 1 contents", cache_hint: "ephemeral" }],
    };
    const next = [ask(0), callTool(1), tampered, callTool(3), toolResult(3, true)];
    stays(classifyMessageSequences(recorded(FIRST), incoming(next)), "boundary_differs_beyond_cache_bookkeeping");
  });

  it("does not soften a role change at the boundary", () => {
    const moved = { ...toolResult(1), role: "assistant" };
    const next = [ask(0), callTool(1), moved, callTool(3), toolResult(3, true)];
    stays(classifyMessageSequences(recorded(FIRST), incoming(next)), "boundary_differs_beyond_cache_bookkeeping");
  });

  it("leaves the strict divergence standing when the boundary digest was never recorded", () => {
    const legacy = { ...recorded(FIRST), final_digest_norm: null };
    stays(classifyMessageSequences(legacy, incoming(SECOND)), "no_normalized_boundary_digest_recorded");
  });

  it("leaves the strict divergence standing when the recorded digests are unavailable", () => {
    const noDigests = { ...recorded(FIRST), digests: null };
    const r = classifyMessageSequences(noDigests, incoming(SECOND));
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.divergence_index).toBeNull();
    expect(r.normalized_by).toBeNull();
  });

  it("leaves the strict divergence standing when the incoming accessor is missing", () => {
    const view = incoming(SECOND);
    stays(
      classifyMessageSequences(recorded(FIRST), { ...view, normalized_digest_at: null }),
      "normalized_boundary_digest_unavailable",
    );
  });
});

/** A candidate row as the store would hand it back, for one message list. */
const candidateFor = (msgs, { tools = TOOLS, system = SYSTEM, id = "cand" } = {}) => ({
  session: { id, client_key: null },
  prefix: layersToPrefixState(computePrefixLayers({ tools, system, messages: msgs })),
});
const layersFor = (msgs, { tools = TOOLS, system = SYSTEM } = {}) => computePrefixLayers({ tools, system, messages: msgs });

describe("the resolver acts on the softened verdict and says that it did", () => {
  it("carries the softening through compareCandidate", () => {
    const c = compareCandidate(candidateFor(FIRST).prefix, layersFor(SECOND));
    expect(c.relation.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(c.relation.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(c.relation.normalized_by).toBe(PREFIX_RULE_VERSION);
    expect(c.invalidation.changed).not.toContain("tools");
    expect(c.invalidation.changed).not.toContain("system");
  });

  it("continues an inferred session instead of opening a new one", () => {
    const r = resolveSessionIdentity({ layers: layersFor(SECOND), candidates: [candidateFor(FIRST)] });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("cand");
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(r.source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.strict_divergence_index).toBe(2);
    expect(r.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
    expect(r.labels).toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    expect(r.notes).toContain("strict_prefix_divergence_at:2");
    expect(r.notes).toContain(`prefix_normalized_by:${PREFIX_RULE_VERSION}`);
  });

  it("continues an explicitly keyed session instead of closing it", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(SECOND),
      explicitKey: "k-move",
      explicitCandidate: candidateFor(FIRST, { id: "keyed" }),
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("keyed");
    expect(r.close_predecessor).toBeNull();
    expect(r.labels).toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
  });

  it("still refuses a candidate whose tools changed, softenable boundary or not", () => {
    const otherTools = [...TOOLS, { name: "run", description: "run a command", parameters: { type: "object" } }];
    const r = resolveSessionIdentity({
      layers: layersFor(SECOND, { tools: otherTools }),
      candidates: [candidateFor(FIRST)],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.notes).toContain("candidates_dropped_on_tools_or_system_change");
    expect(r.labels).not.toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
  });

  it("still refuses a candidate whose system prompt changed", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(SECOND, { system: `${SYSTEM} Be terse.` }),
      candidates: [candidateFor(FIRST)],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.notes).toContain("candidates_dropped_on_tools_or_system_change");
  });

  it("still closes an explicitly keyed session on a real content change", () => {
    const edited = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file 1 EDITED" }] };
    const r = resolveSessionIdentity({
      layers: layersFor([ask(0), callTool(1), edited, callTool(3), toolResult(3, true)]),
      explicitKey: "k-edit",
      explicitCandidate: candidateFor(FIRST, { id: "keyed" }),
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.close_predecessor).toEqual({ session_id: "keyed", reason: "prefix_discontinuity" });
    expect(r.normalized_by).toBeNull();
  });
});

describe("end to end: the captured pattern lands in one session", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });
  const harness = async () => {
    const h = await openHarness({ tag: "cachebp" });
    open.push(h);
    return h;
  };

  it("observes two turns of one session, with no session key sent", async () => {
    const h = await harness();
    // No `key`: real Claude Code sends none, so this is the path that mattered.
    const first = await h.observe(turnRequest({ msgs: FIRST }));
    h.tick(4000);
    const second = await h.observe(turnRequest({ msgs: SECOND }));

    expect(second.session_id).toBe(first.session_id);
    expect(second.created_session).toBe(false);
    expect(second.turn_idx).toBe(1);
    expect(second.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(second.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(second.strict_divergence_index).toBe(2);
    expect(second.identity_confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(1);
    expect(h.db.get("SELECT turn_count AS n FROM sessions WHERE id = ?", [first.session_id]).n).toBe(2);
  });

  it("records the strict failure, the label and the rule version on the turn row", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: FIRST }));
    h.tick(4000);
    await h.observe(turnRequest({ msgs: SECOND }));

    const t0 = h.db.get("SELECT * FROM turns WHERE session_id = ? AND idx = 0", [first.session_id]);
    const t1 = h.db.get("SELECT * FROM turns WHERE session_id = ? AND idx = 1", [first.session_id]);

    expect(t0.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
    expect(t0.strict_relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(t0.strict_divergence_index).toBeNull();

    expect(t1.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(t1.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(t1.strict_divergence_index).toBe(2);
    expect(t1.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
    expect(String(t1.labels).split(",")).toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    const notes = String(t1.notes).split(",");
    expect(notes).toContain("strict_prefix_divergence_at:2");
    expect(notes).toContain(`prefix_normalized_by:${PREFIX_RULE_VERSION}`);
  });

  it("stores a boundary digest that is a digest, not content", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: FIRST }));
    const row = h.db.get("SELECT * FROM session_prefix WHERE session_id = ?", [first.session_id]);
    expect(row.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
    expect(row.final_digest_norm).toMatch(/^c1:[0-9a-f]{64}$/);
    // It is the *normalized* digest of the trailing message: the breakpoint is gone.
    expect(row.final_digest_norm).toBe(bookkeepingDigest(FIRST[FIRST.length - 1]));
    expect(row.final_digest_norm).not.toBe(digest(FIRST[FIRST.length - 1]));
    const leaked = Object.values(row).filter((v) => typeof v === "string" && v.includes("file 1 contents"));
    expect(leaked).toEqual([]);
  });

  it("still opens a second session when the trailing message really changed", async () => {
    const h = await harness();
    const edited = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file 1 EDITED" }] };
    const first = await h.observe(turnRequest({ msgs: FIRST }));
    h.tick(4000);
    const second = await h.observe(turnRequest({ msgs: [ask(0), callTool(1), edited, callTool(3), toolResult(3, true)] }));

    expect(second.session_id).not.toBe(first.session_id);
    expect(second.created_session).toBe(true);
    expect(second.strict_relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(String(second.labels)).not.toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(2);
  });

  it("still opens a second session when the tool set changed", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: FIRST }));
    h.tick(4000);
    const second = await h.observe(
      turnRequest({ msgs: SECOND, tools: [...TOOLS, { name: "run", description: "run", parameters: { type: "object" } }] }),
    );
    expect(second.session_id).not.toBe(first.session_id);
    expect(h.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(2);
  });

  it("keeps a legacy row without a boundary digest interpretable: it splits, as before", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: FIRST }));
    // Simulate a row written by a build that predates the rule.
    h.db.run("UPDATE session_prefix SET final_digest_norm = NULL, prefix_rule_version = NULL WHERE session_id = ?", [
      first.session_id,
    ]);
    h.tick(4000);
    const second = await h.observe(turnRequest({ msgs: SECOND }));
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
  });

  it("carries the new columns after a migration of an existing database", async () => {
    const h = await harness();
    expect(h.store.schema_version ?? h.db.get("SELECT value FROM _meta WHERE key = 'schema_version'")?.value).toBeTruthy();
    const turnCols = h.db.all("PRAGMA table_info(turns)").map((c) => c.name);
    const prefixCols = h.db.all("PRAGMA table_info(session_prefix)").map((c) => c.name);
    expect(turnCols).toEqual(expect.arrayContaining(["prefix_rule_version", "strict_relation", "strict_divergence_index"]));
    expect(prefixCols).toEqual(expect.arrayContaining(["final_digest_norm", "prefix_rule_version"]));
  });
});
