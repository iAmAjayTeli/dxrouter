/**
 * Invariants of the lineage resolver, pinned after the front-layer split.
 *
 * `session-lineage-front-layer.test.js` proves the split does what it was built for:
 * a conversation that changes its tool set keeps its lineage and the change becomes
 * observable. This file pins the properties that make that safe, because relaxing a
 * membership predicate is exactly the kind of change whose failure mode is silent:
 *
 *   Q1  the (confidence, source) pair is the disambiguator. `weakly_inferred` covers
 *       two different situations and `identity_source` is what tells them apart.
 *   Q2  `invalidated_layers` is a prefix-ordered CACHE invalidation list, not a
 *       divergence report. `messages` appearing in it must not be readable as "the
 *       messages layer broke" — the messages verdict lives in relation/divergence_index.
 *   Q3  the decision is a property of the candidate SET, never of its order, and a
 *       truncated candidate set is never silently a missing predecessor.
 *   Q4  removing front-layer equality from candidate membership did not make
 *       `project_root` a lineage key, did not merge unrelated conversations, and did
 *       not let one plausible lineage win over an ambiguous set.
 *
 * Every test here is a property, not an example: reversed inputs, counted branches,
 * and pairs asserted together rather than one field at a time.
 */

import { describe, it, expect } from "vitest";

import {
  RESOLUTION_ACTION,
  layersToPrefixState,
  resolveSessionIdentity,
} from "../../continuity/identity/sessionResolver.js";
import { IDENTITY_CONFIDENCE, IDENTITY_SOURCE, M1_LABELS } from "../../continuity/identity/confidence.js";
import { computePrefixLayers } from "../../continuity/prefix/hasher.js";
import { MESSAGE_RELATION } from "../../continuity/prefix/extension.js";
import { SYSTEM, TOOLS, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const layersFor = (msgs, { tools = TOOLS, system = SYSTEM } = {}) =>
  computePrefixLayers({ tools, system, messages: msgs });

const candidateFor = (id, msgs, opts = {}) => ({
  session: { id, client_key: null, last_seen_at: opts.lastSeenAt ?? 1, ...(opts.session ?? {}) },
  prefix: layersToPrefixState(layersFor(msgs, opts)),
});

/**
 * A candidate whose front layers match the turn but whose messages layer was never
 * recorded: the §4.2 weak row, where the messages question cannot be asked at all.
 */
const unrecordedMessagesCandidate = (id, opts = {}) => {
  const prefix = layersToPrefixState(layersFor(messages(4), opts));
  return {
    session: { id, client_key: null, last_seen_at: opts.lastSeenAt ?? 1 },
    prefix: { ...prefix, messages_hash: null, message_count: null, digests: null, chain: null },
  };
};

const MORE_TOOLS = [...TOOLS, { name: "run_shell", description: "run a command", parameters: { type: "object" } }];
const OTHER_SYSTEM = SYSTEM + " Prefer small diffs.";

// ---------------------------------------------------------------------------
// Q1 — confidence is graded; `identity_source` is what disambiguates it
// ---------------------------------------------------------------------------

describe("Q1 — weakly_inferred is disambiguated by identity_source, not by a new grade", () => {
  it("front-layer change on a PROVEN chain is (weakly_inferred, prefix_extension)", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      candidates: [candidateFor("proven", messages(4))],
    });
    // The pair, asserted together: either field alone is ambiguous.
    expect([r.confidence, r.source]).toEqual([
      IDENTITY_CONFIDENCE.WEAKLY_INFERRED,
      IDENTITY_SOURCE.PREFIX_EXTENSION,
    ]);
    // …and the chain proof is legible on the row, so a reader never has to infer it
    // from the grade.
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.divergence_index).toBeNull();
    expect(r.labels).toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
  });

  it("indeterminate chain with a continuous front layer is (weakly_inferred, ambiguous_prefix)", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [unrecordedMessagesCandidate("unproven")],
    });
    expect([r.confidence, r.source]).toEqual([
      IDENTITY_CONFIDENCE.WEAKLY_INFERRED,
      IDENTITY_SOURCE.AMBIGUOUS_PREFIX,
    ]);
    expect(r.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    // The opposite of the case above: no chain proof, so no front-layer transition to
    // report either.
    expect(r.labels).not.toContain(M1_LABELS.FRONT_LAYER_TRANSITION);
  });

  it("the two weak cases are distinguishable from each other on the same grade", () => {
    const proven = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      candidates: [candidateFor("proven", messages(4))],
    });
    const unproven = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [unrecordedMessagesCandidate("unproven")],
    });
    expect(proven.confidence).toBe(unproven.confidence);
    // Same confidence, different source: this is the distinction, and it must not
    // collapse. If a later milestone needs to treat "lineage proven, prefix cold" and
    // "lineage unproven, prefix warm" differently, this is the field it reads.
    expect(proven.source).not.toBe(unproven.source);
  });

  it("all-layers-continuous stays the only route to strongly_inferred", () => {
    const strong = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("proven", messages(4))],
    });
    expect([strong.confidence, strong.source]).toEqual([
      IDENTITY_CONFIDENCE.STRONGLY_INFERRED,
      IDENTITY_SOURCE.PREFIX_EXTENSION,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Q2 — invalidated_layers is cache invalidation, not a divergence claim
// ---------------------------------------------------------------------------

describe("Q2 — `messages` in invalidated_layers never means the messages layer diverged", () => {
  it("records tools,system,messages while simultaneously proving an extension", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(8), { tools: MORE_TOOLS, system: OTHER_SYSTEM }),
      candidates: [candidateFor("lineage", messages(6))],
    });

    // The whole point of the pairing: these four facts are true at once. `messages` is
    // in the invalidation list because a changed `tools` layer invalidates everything
    // behind it (prefix/invalidation.js), while the messages VERDICT — carried by
    // `relation` and `divergence_index` — says the chain continued cleanly.
    expect(r.invalidated).toEqual(["tools", "system", "messages"]);
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.divergence_index).toBeNull();
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
  });

  it("`changed` reports only the layers that actually moved", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { system: OTHER_SYSTEM }),
      candidates: [candidateFor("lineage", messages(4))],
    });
    // tools did NOT move, so it is absent from `changed` even though a tools change
    // would have invalidated the same set. `changed` is the observation; `invalidated`
    // is the derived consequence.
    expect(r.changed).toEqual(["system", "messages"]);
    expect(r.invalidated).toEqual(["system", "messages"]);
    expect(r.notes).toContain("front_layer_changed:system");
  });

  it("the front-layer note lists front layers only, never `messages`", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(8), { tools: MORE_TOOLS, system: OTHER_SYSTEM }),
      candidates: [candidateFor("lineage", messages(6))],
    });
    const note = r.notes.find((n) => n.startsWith("front_layer_changed:"));
    expect(note).toBe("front_layer_changed:tools|system");
    // Belt and braces: if `messages` ever leaked into this note it would read as a
    // divergence claim, which is the confusion this test exists to prevent.
    expect(note).not.toContain("messages");
  });

  it("a genuine messages divergence is reported through relation, not through the list", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4, "Z")),
      candidates: [candidateFor("other", messages(4))],
    });
    // No continuation claimed, and the divergence is named as a relation.
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(r.notes).toContain("candidates_all_divergent");
  });
});

// ---------------------------------------------------------------------------
// Q3 — the decision is a property of the candidate set, not of its order
// ---------------------------------------------------------------------------

describe("Q3 — candidate order cannot change the decision", () => {
  const reversedMatches = (args) => {
    const forward = resolveSessionIdentity({ ...args, candidates: [...args.candidates] });
    const backward = resolveSessionIdentity({ ...args, candidates: [...args.candidates].reverse() });
    return { forward, backward };
  };

  it("one plausible lineage among several divergent ones resolves identically either way", () => {
    const { forward, backward } = reversedMatches({
      layers: layersFor(messages(6)),
      candidates: [
        candidateFor("noise-1", messages(4, "X"), { lastSeenAt: 900 }),
        candidateFor("real", messages(4), { lastSeenAt: 100 }),
        candidateFor("noise-2", messages(2, "Y"), { lastSeenAt: 800 }),
      ],
    });
    expect(forward.session_id).toBe("real");
    // Deep equality, not field-by-field: any order-sensitive field at all would fail
    // here, including the notes and the recorded comparison.
    expect(forward).toEqual(backward);
  });

  it("an ambiguous set stays ambiguous either way", () => {
    const { forward, backward } = reversedMatches({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("a", messages(4)), candidateFor("b", messages(4))],
    });
    expect(forward.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(forward.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
    expect(forward).toEqual(backward);
  });

  it("order independence holds on the weak (indeterminate) path too", () => {
    const { forward, backward } = reversedMatches({
      layers: layersFor(messages(6)),
      candidates: [
        unrecordedMessagesCandidate("weak", { lastSeenAt: 10 }),
        candidateFor("front-changed", messages(4, "Q"), { tools: MORE_TOOLS, lastSeenAt: 999 }),
      ],
    });
    expect(forward.session_id).toBe("weak");
    expect(forward.source).toBe(IDENTITY_SOURCE.AMBIGUOUS_PREFIX);
    expect(forward).toEqual(backward);
  });

  it("the most recently active candidate is never preferred as a tie-break", () => {
    // Both candidates prove a continuation. One was active a moment ago, the other an
    // hour ago. Nearest-in-time is the tempting tie-break and it is forbidden: the
    // set is ambiguous, so nothing is claimed.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [
        candidateFor("stale", messages(4), { lastSeenAt: 1 }),
        candidateFor("fresh", messages(4), { lastSeenAt: 1_000_000 }),
      ],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });
});

describe("Q3 — exactly one plausible candidate continues; more than one never does", () => {
  it("continues on a single proven chain", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("only", messages(4))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("only");
  });

  it("refuses two proven chains", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("a", messages(4)), candidateFor("b", messages(4))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.notes).toContain("multiple_prefix_extension_candidates");
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });

  it("refuses two compaction-shaped candidates", () => {
    // Both candidates are long, front-continuous, and dwarf this turn's messages, so
    // both carry the §5 compaction signature. Two readings, no proof: nothing claimed.
    const r = resolveSessionIdentity({
      layers: layersFor([{ role: "user", content: "here is a summary of the work so far" }]),
      candidates: [candidateFor("long-a", messages(20, "A")), candidateFor("long-b", messages(20, "B"))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.notes).toContain("multiple_compaction_candidates");
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });

  it("refuses two indeterminate candidates", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [unrecordedMessagesCandidate("u1"), unrecordedMessagesCandidate("u2")],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.notes).toContain("multiple_ambiguous_candidates");
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });

  it("marks every ambiguous branch with the same label, so ambiguity is countable", () => {
    // Three different branches reach "refused"; a measure counting censored turns must
    // not have to know which one fired.
    const sets = [
      { candidates: [candidateFor("a", messages(4)), candidateFor("b", messages(4))], layers: layersFor(messages(6)) },
      {
        candidates: [candidateFor("la", messages(20, "A")), candidateFor("lb", messages(20, "B"))],
        layers: layersFor([{ role: "user", content: "summary" }]),
      },
      {
        candidates: [unrecordedMessagesCandidate("u1"), unrecordedMessagesCandidate("u2")],
        layers: layersFor(messages(6)),
      },
    ];
    for (const set of sets) {
      const r = resolveSessionIdentity(set);
      expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
      expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    }
  });
});

describe("Q3 — a truncated candidate set is never a silent 'no predecessor'", () => {
  it("reports the cap alongside the negative verdict rather than instead of it", () => {
    const many = Array.from({ length: 4 }, (_, i) => candidateFor(`s${i}`, [{ role: "user", content: `x${i}` }]));
    const r = resolveSessionIdentity({
      layers: layersFor(messages(2)),
      candidates: many,
      candidateLimit: 4,
    });
    // Both notes present: "I found nothing" AND "I was not allowed to look further".
    // Either one alone would be a misleading record.
    expect(r.notes).toContain("candidate_limit_reached:4");
    expect(r.notes).toContain("candidates_all_divergent");
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
  });

  it("stays silent about the cap when the set was not truncated", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(2)),
      candidates: [candidateFor("s0", [{ role: "user", content: "x0" }])],
      candidateLimit: 4,
    });
    expect(r.notes.some((n) => n.startsWith("candidate_limit_reached"))).toBe(false);
    expect(r.notes).toContain("candidates_all_divergent");
  });

  it("reports the cap even on a successful continuation", () => {
    // A predecessor was found, but the cap was still reached, so a better one may have
    // been invisible. The successful answer does not excuse dropping that caveat.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("real", messages(4)), candidateFor("noise", messages(4, "X"))],
      candidateLimit: 2,
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("real");
    expect(r.notes).toContain("candidate_limit_reached:2");
  });

  it("defaults to no cap when the caller does not declare one", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("real", messages(4))],
    });
    expect(r.notes.some((n) => n.startsWith("candidate_limit_reached"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Q4 — what the relaxed membership predicate did NOT become
// ---------------------------------------------------------------------------

describe("Q4 — project_root is a scope, never a lineage key", () => {
  it("does not merge identical message chains across two project roots", async () => {
    const h = await openHarness({ tag: "inv-root" });
    try {
      const one = await h.observe(turnRequest({ msgs: messages(4), root: "/repo/one" }));
      h.tick(1000);
      // Byte-identical continuation of `one`'s chain — but in a different project. The
      // only thing keeping these apart is the candidate scope, so this is the test that
      // proves the scope is actually applied.
      const two = await h.observe(turnRequest({ msgs: messages(6), root: "/repo/two" }));
      expect(two.session_id).not.toBe(one.session_id);
      expect(two.created_session).toBe(true);
      expect(two.identity_confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);

      h.tick(1000);
      // …and the same chain inside the ORIGINAL project still continues, so the scope
      // is not simply blocking everything.
      const three = await h.observe(turnRequest({ msgs: messages(6), root: "/repo/one" }));
      expect(three.session_id).toBe(one.session_id);
      expect(three.created_session).toBe(false);

      expect(h.db.all("SELECT COUNT(*) AS n FROM sessions")[0].n).toBe(2);
    } finally {
      h.close();
      removeTmpDir(h.dir);
    }
  });

  it("keeps unrelated conversations in ONE project apart", async () => {
    const h = await openHarness({ tag: "inv-unrelated" });
    try {
      const a = await h.observe(turnRequest({ msgs: messages(4, "A"), root: "/repo/same" }));
      h.tick(1000);
      const b = await h.observe(turnRequest({ msgs: messages(4, "B"), root: "/repo/same" }));
      h.tick(1000);
      const c = await h.observe(turnRequest({ msgs: messages(4, "C"), root: "/repo/same" }));

      expect(new Set([a.session_id, b.session_id, c.session_id]).size).toBe(3);
      expect(h.db.all("SELECT COUNT(*) AS n FROM sessions")[0].n).toBe(3);
    } finally {
      h.close();
      removeTmpDir(h.dir);
    }
  });

  it("does not merge unrelated conversations just because their front layers match", () => {
    // The normal shape for two agents in one repository: same system prompt, same tool
    // set, different work. Front-layer equality is no longer a filter, and it must not
    // become a substitute proof either. Every candidate here is SHORTER than the turn,
    // so each one is judged on the chain and each one diverges.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(8, "Z")),
      candidates: [
        candidateFor("p", messages(4, "P")),
        candidateFor("q", messages(6, "Q")),
        candidateFor("r", messages(2, "R")),
      ],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.source).toBe(IDENTITY_SOURCE.NEW);
    expect(r.notes).toContain("candidates_all_divergent");
  });

  it("does not merge an unrelated LONGER conversation either, though it reads as compacted", () => {
    // Worth pinning separately, because the branch is different and less obvious: an
    // unrelated conversation that happens to be longer than this turn, with the same
    // tools and system prompt, carries the §5 compaction signature. The resolver records
    // the signature and still claims nothing, which is the whole point of that branch —
    // "the messages got shorter" describes a compaction and a brand-new short
    // conversation equally well.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4, "Z")),
      candidates: [candidateFor("longer-unrelated", messages(20, "Q"))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.source).toBe(IDENTITY_SOURCE.NEW);
    expect(r.notes).toContain("compaction_shaped_candidate_not_claimed");
  });
});

describe("Q4 — the weak paths kept their front-layer precondition", () => {
  it("drops an indeterminate candidate whose tools changed, rather than continuing it", () => {
    // No chain proof is available, so the tool set is the only remaining evidence that
    // this is even the same conversation. Losing it means no lineage, not a weaker one.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      candidates: [unrecordedMessagesCandidate("unproven")],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.notes).toContain("candidates_dropped_on_tools_or_system_change");
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
  });

  it("drops a compaction-shaped candidate whose system prompt changed", () => {
    const r = resolveSessionIdentity({
      layers: layersFor([{ role: "user", content: "summary" }], { system: OTHER_SYSTEM }),
      candidates: [candidateFor("long", messages(20))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.notes).toContain("candidates_dropped_on_tools_or_system_change");
  });

  it("does not raise the drop note when a chain proof carried the decision", () => {
    // The note means "a candidate was excluded for a front-layer change". On the strong
    // path nothing is excluded for that reason, so raising it there would be a false
    // record of a filter that did not run.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6), { tools: MORE_TOOLS }),
      candidates: [candidateFor("proven", messages(4))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.notes).not.toContain("candidates_dropped_on_tools_or_system_change");
  });
});

describe("Q4 — a proven chain outranks a weaker reading, deliberately", () => {
  it("prefers the single proven lineage over a concurrent compaction-shaped candidate", () => {
    // This is precedence, not a tie-break: the proven chain is decided by a byte-exact
    // hash comparison and the compaction reading is a shape. One is a measurement and
    // the other an inference, so they are not comparable candidates for the same slot.
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [candidateFor("proven", messages(4)), candidateFor("looks-compacted", messages(20))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("proven");
    expect(r.source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
    // The weaker reading is not recorded as ambiguity, because it never competed.
    expect(r.labels).not.toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });

  it("prefers the single proven lineage over a concurrent indeterminate candidate", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [unrecordedMessagesCandidate("unproven"), candidateFor("proven", messages(4))],
    });
    expect(r.session_id).toBe("proven");
    expect(r.source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
  });

  it("but one proven chain never resolves an ambiguous set of proven chains", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(6)),
      candidates: [
        candidateFor("a", messages(4)),
        candidateFor("b", messages(4)),
        unrecordedMessagesCandidate("weak"),
      ],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
    expect(r.labels).toContain(M1_LABELS.LINEAGE_AMBIGUOUS);
  });
});
