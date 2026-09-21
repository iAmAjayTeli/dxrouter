/**
 * Lineage discovery vs front-layer observation.
 *
 * The GameTest pilot made the defect concrete: ONE autonomous Claude Code conversation
 * produced 31 recorded turns spread over 15 sessions, with a different `tools_hash` on
 * nearly every one and `invalidated_layers` never once containing `tools` or `system`.
 * Front-layer equality was acting as a lineage key — enforced in SQL and re-checked in
 * the resolver — so a conversation that changed its tool set had its own predecessor
 * filtered out before any comparison ran. The change could then only ever surface as a
 * new session row, which is why front-layer churn was unobservable in principle rather
 * than merely unobserved.
 *
 * These tests pin the separation:
 *   - MESSAGES layer proves lineage.
 *   - tools/system are observed state, recorded in `invalidated_layers` and labelled.
 *   - fail-closed is unchanged: no proof, or more than one plausible proof, means a new
 *     session; nearest-in-time is never a tie-break.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  RESOLUTION_ACTION,
  layersToPrefixState,
  resolveSessionIdentity,
} from "../../continuity/identity/sessionResolver.js";
import { IDENTITY_CONFIDENCE, IDENTITY_SOURCE, M1_LABELS } from "../../continuity/identity/confidence.js";
import { computePrefixLayers } from "../../continuity/prefix/hasher.js";
import { MESSAGE_RELATION } from "../../continuity/prefix/extension.js";
import { PREFIX_RULE_VERSION } from "../../continuity/prefix/bookkeeping.js";
import { SYSTEM, TOOLS, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const layersFor = (msgs, { tools = TOOLS, system = SYSTEM } = {}) =>
  computePrefixLayers({ tools, system, messages: msgs });

const candidateFor = (id, msgs, opts = {}) => ({
  session: { id, client_key: null, ...(opts.session ?? {}) },
  prefix: layersToPrefixState(layersFor(msgs, opts)),
});

const MORE_TOOLS = [...TOOLS, { name: "run_shell", description: "run a command", parameters: { type: "object" } }];
const OTHER_SYSTEM = SYSTEM + " Prefer small diffs.";

describe("TEST A — a lineage that changes tools stays eligible, and the change is observable", () => {
  it("continues the same lineage and records the tools transition", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      candidates: [candidateFor("lineage", messages(4))],
    });

    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("lineage");
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    // The observable front break: before the split this list could never contain `tools`.
    expect(r.invalidated).toContain("tools");
    expect(r.changed).toContain("tools");
    expect(r.labels).toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
    expect(r.notes.some((n) => n.startsWith("front_layer_changed:"))).toBe(true);
    // Honest grading: the chain proved lineage, but not every layer held.
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.WEAKLY_INFERRED);
    expect(r.source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
  });

  it("still grades an all-layers-continuous continuation as strong", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("lineage", messages(4))],
    });
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(r.labels).not.toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
    expect(r.invalidated).toEqual(["messages"]);
  });
});

describe("TEST B — a lineage that changes system stays eligible, and the change is observable", () => {
  it("continues the same lineage and records the system transition", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { system: OTHER_SYSTEM }),
      candidates: [candidateFor("lineage", messages(4))],
    });

    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("lineage");
    expect(r.changed).toContain("system");
    expect(r.changed).not.toContain("tools");
    // Prefix-ordered invalidation: system invalidates system and everything behind it.
    expect(r.invalidated).toEqual(["system", "messages"]);
    expect(r.labels).toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
    expect(r.notes).toContain("front_layer_changed:system");
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.WEAKLY_INFERRED);
  });
});

describe("TEST C — changing BOTH tools and system does not split the lineage by itself", () => {
  it("continues on the messages proof and reports both layers", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(8), { tools: MORE_TOOLS, system: OTHER_SYSTEM }),
      candidates: [candidateFor("lineage", messages(6))],
    });

    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("lineage");
    expect(r.changed).toEqual(["tools", "system", "messages"]);
    expect(r.invalidated).toEqual(["tools", "system", "messages"]);
    expect(r.notes).toContain("front_layer_changed:tools|system");
    expect(r.labels).toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
    // The old rule is gone: nothing was excluded for a front-layer change.
    expect(r.notes).not.toContain("candidates_dropped_on_tools_or_system_change");
  });
});

describe("TEST D — two plausible concurrent lineages are refused, not guessed", () => {
  it("opens a new session and marks the turn ambiguous", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("a", messages(4)), candidateFor("b", messages(4))],
    });

    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.notes).toContain("multiple_prefix_extension_candidates");
    // Censored, not merely new: a reader counting continuations must see the difference.
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });

  it("refuses even when the two candidates differ in front-layer state", () => {
    // Relaxing the front-layer gate must not become a tie-break either: a differing
    // tool set is not a reason to prefer one plausible lineage over another.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      candidates: [
        candidateFor("same-front", messages(4), { tools: MORE_TOOLS }),
        candidateFor("other-front", messages(4)),
      ],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });
});

describe("TEST E — temporal proximity alone never merges an unrelated conversation", () => {
  it("refuses a candidate whose messages do not extend, however recent it is", () => {
    // Same length, different content: unambiguously a different conversation rather than
    // a compaction of this one, so the divergence branch is the one under test.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4, "Z")),
      candidates: [candidateFor("recent", messages(4))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.source).toBe(IDENTITY_SOURCE.NEW);
    expect(r.session_id).toBeNull();
    expect(r.notes).toContain("candidates_all_divergent");
  });

  it("stays separate end to end even when the new conversation starts moments later", async () => {
    const h = await openHarness({ tag: "lineage-e" });
    try {
      const first = await h.observe(turnRequest({ msgs: messages(4) }));
      h.tick(50); // milliseconds apart: as temporally close as it gets
      const second = await h.observe(turnRequest({ msgs: [{ role: "user", content: "unrelated task" }] }));
      expect(second.session_id).not.toBe(first.session_id);
      expect(second.created_session).toBe(true);
      expect(second.identity_confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    } finally {
      h.close();
      removeTmpDir(h.dir);
    }
  });
});

describe("TEST F — explicit x-dxr-session still identifies the lineage deterministically", () => {
  it("honours the key across a front-layer change and ignores inference candidates", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS, system: OTHER_SYSTEM }),
      explicitKey: "cc-deterministic",
      explicitCandidate: candidateFor("keyed", messages(4)),
      candidates: [candidateFor("inferred", messages(4))],
    });
    expect(r.session_id).toBe("keyed");
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(r.source).toBe(IDENTITY_SOURCE.HEADER);
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
  });

  it("is deterministic: the same inputs give the same answer every time", () => {
    const args = () => ({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      explicitKey: "cc-deterministic",
      explicitCandidate: candidateFor("keyed", messages(4)),
    });
    const a = resolveSessionIdentity(args());
    const b = resolveSessionIdentity(args());
    expect(a).toEqual(b);
  });

  it("keeps the key and opens a successor when the prefix proves a restart", () => {
    const r = resolveSessionIdentity({
      layers: layersFor([{ role: "user", content: "brand new task" }]),
      explicitKey: "cc-deterministic",
      explicitCandidate: candidateFor("keyed", messages(8)),
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(r.close_predecessor?.session_id).toBe("keyed");
  });
});

describe("TEST G — r2 cache-breakpoint behaviour is unchanged by the split", () => {
  // The captured Claude Code steady state, reduced to essentials (see
  // prefix-cache-bookkeeping-r2.test.js for the six-request capture this comes from):
  // PREV carries `cache_control` on BOTH trailing messages, NEXT rolls both markers
  // forward, so the strict test diverges at `prev.count - 2` and rule r2 softens it.
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

  const SOFTEN_PREV = [ask(0), callTool(1), toolResult(1), callTool(2, true), toolResult(2, true)];
  const SOFTEN_NEXT = [
    ask(0),
    callTool(1),
    toolResult(1),
    callTool(2),
    toolResult(2),
    callTool(3, true),
    toolResult(3, true),
  ];

  it("softens a genuinely moved breakpoint even when the tool set changed on the same turn", () => {
    // Softening and a front-layer transition are independent facts about one boundary,
    // and the pilot produces both together: Claude Code rolls its cache breakpoints
    // forward on every request, and an MCP server can finish connecting at any time.
    // Both must be recorded — neither may mask the other.
    const r = resolveSessionIdentity({
      layers: layersFor(SOFTEN_NEXT, { tools: MORE_TOOLS }),
      candidates: [candidateFor("lineage", SOFTEN_PREV)],
    });

    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("lineage");
    // The softening really happened: effective verdict is a continuation, and the strict
    // verdict underneath it is a divergence.
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.divergence_index).toBeNull();
    expect(r.normalized_by).toBe(PREFIX_RULE_VERSION);
    expect(r.strict_relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.strict_divergence_index).toBe(SOFTEN_PREV.length - 2);
    // …and both labels ride on the same turn.
    expect(r.labels).toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    expect(r.labels).toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
    // …with the notes for each kept separate and both legible.
    expect(r.notes).toContain(`strict_prefix_divergence_at:${SOFTEN_PREV.length - 2}`);
    expect(r.notes).toContain(`prefix_normalized_by:${PREFIX_RULE_VERSION}`);
    expect(r.notes).toContain("front_layer_changed:tools");
  });

  it("softens the same boundary identically when the tool set did NOT change", () => {
    // The control: removing the front-layer change must alter the grade and the labels
    // and nothing else about the prefix verdict, which is what makes the two facts
    // independent rather than coupled.
    const changed = resolveSessionIdentity({
      layers: layersFor(SOFTEN_NEXT, { tools: MORE_TOOLS }),
      candidates: [candidateFor("lineage", SOFTEN_PREV)],
    });
    const unchanged = resolveSessionIdentity({
      layers: layersFor(SOFTEN_NEXT),
      candidates: [candidateFor("lineage", SOFTEN_PREV)],
    });

    expect(unchanged.relation).toBe(changed.relation);
    expect(unchanged.strict_relation).toBe(changed.strict_relation);
    expect(unchanged.strict_divergence_index).toBe(changed.strict_divergence_index);
    expect(unchanged.normalized_by).toBe(changed.normalized_by);
    expect(unchanged.labels).toContain(M1_LABELS.PREFIX_CACHE_BREAKPOINT_MOVED);
    expect(unchanged.labels).not.toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
    expect(unchanged.confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(changed.confidence).toBe(IDENTITY_CONFIDENCE.WEAKLY_INFERRED);
  });

  it("reports the strict verdict alongside the effective one", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("lineage", messages(4))],
    });
    expect(r.strict_relation).toBeTruthy();
    expect(r.prefix_rule_version).toBe(PREFIX_RULE_VERSION);
  });
});

describe("TEST H — the pilot's observed shape is now representable", () => {
  it("records a tools transition inside one session instead of opening a new one", async () => {
    // This is the GameTest pilot in miniature: one logical conversation whose tool set
    // changes partway through. Previously each change produced another session and
    // `invalidated_layers` never mentioned `tools`.
    const h = await openHarness({ tag: "lineage-h" });
    try {
      const t1 = await h.observe(turnRequest({ msgs: messages(2) }));
      h.tick(1000);
      const t2 = await h.observe(turnRequest({ msgs: messages(4) }));
      h.tick(1000);
      // The MCP server finishes connecting: same conversation, larger tool set.
      const t3 = await h.observe(turnRequest({ msgs: messages(6), tools: MORE_TOOLS }));
      h.tick(1000);
      const t4 = await h.observe(turnRequest({ msgs: messages(8), tools: MORE_TOOLS }));

      expect(t2.session_id).toBe(t1.session_id);
      expect(t3.session_id).toBe(t1.session_id);
      expect(t4.session_id).toBe(t1.session_id);
      expect(t3.created_session).toBe(false);
      expect([t1.turn_idx, t2.turn_idx, t3.turn_idx, t4.turn_idx]).toEqual([0, 1, 2, 3]);

      const rows = h.db.all(
        "SELECT idx, invalidated_layers, labels, prefix_rule_version FROM turns WHERE session_id = ? ORDER BY idx",
        [t1.session_id],
      );
      expect(rows.length).toBe(4);
      // The front break is now a recorded event on turn 2, not a missing session.
      expect(rows[2].invalidated_layers).toBe("tools,system,messages");
      expect(rows[2].labels ?? "").toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
      // and the turn after it is continuous again
      expect(rows[3].invalidated_layers).toBe("messages");
      for (const row of rows) expect(row.prefix_rule_version).toBe(PREFIX_RULE_VERSION);

      const sessions = h.db.all("SELECT COUNT(*) AS n FROM sessions");
      expect(sessions[0].n).toBe(1);
    } finally {
      h.close();
      removeTmpDir(h.dir);
    }
  });

  it("keeps two genuinely concurrent lineages apart rather than merging them", async () => {
    // The pilot also showed genuinely overlapping sessions. Interleaving two independent
    // conversations must still produce two sessions, and the ambiguous turns must say so
    // rather than being silently attached to whichever was touched last.
    const h = await openHarness({ tag: "lineage-h2" });
    try {
      const a1 = await h.observe(turnRequest({ msgs: messages(2, "A") }));
      h.tick(10);
      const b1 = await h.observe(turnRequest({ msgs: messages(2, "B") }));
      expect(b1.session_id).not.toBe(a1.session_id);
      h.tick(10);
      const a2 = await h.observe(turnRequest({ msgs: messages(4, "A") }));
      h.tick(10);
      const b2 = await h.observe(turnRequest({ msgs: messages(4, "B") }));

      expect(a2.session_id).toBe(a1.session_id);
      expect(b2.session_id).toBe(b1.session_id);
      expect(h.db.all("SELECT COUNT(*) AS n FROM sessions")[0].n).toBe(2);
    } finally {
      h.close();
      removeTmpDir(h.dir);
    }
  });

  it("reports a truncated candidate set rather than calling it 'no predecessor'", () => {
    const many = Array.from({ length: 3 }, (_, i) => candidateFor(`s${i}`, [{ role: "user", content: `x${i}` }]));
    const r = resolveSessionIdentity({
      layers: layersFor(messages(2)),
      candidates: many,
      candidateLimit: 3,
    });
    expect(r.notes).toContain("candidate_limit_reached:3");
  });
});
