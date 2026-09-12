/**
 * Group B — prefix extension (§14 B, §3 of the milestone brief).
 *
 * The seven required cases, stated as the brief states them, plus the two that make
 * the check honest: "I cannot tell" must be reachable, and it must never be confused
 * with "yes". Message *count* is deliberately never sufficient evidence here — every
 * case below that shares a count with its comparand exists to prove that.
 */

import { describe, it, expect } from "vitest";

import { computePrefixLayers, hashMessagesLayer } from "../../continuity/prefix/hasher.js";
import {
  MESSAGE_RELATION,
  classifyMessageSequences,
  isPrefixContinuation,
} from "../../continuity/prefix/extension.js";
import { invalidatedLayers } from "../../continuity/prefix/invalidation.js";

const A = [
  { role: "user", content: "one" },
  { role: "assistant", content: "two" },
];
const B = { role: "user", content: "three" };
const C = { role: "user", content: "different three" };

/** What the store keeps for a session: the flat messages view. */
const recorded = (messages) => {
  const layer = hashMessagesLayer(messages);
  return { hash: layer.hash, count: layer.count, digests: layer.digests };
};
/** What a fresh request produces: hash, count, digests and the chain. */
const incoming = (messages) => hashMessagesLayer(messages);

describe("required cases", () => {
  it("A then A+B is an extension", () => {
    const r = classifyMessageSequences(recorded(A), incoming([...A, B]));
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(isPrefixContinuation(r.relation)).toBe(true);
  });

  it("A then A is identical, which is also continuity", () => {
    const r = classifyMessageSequences(recorded(A), incoming(A));
    expect(r.relation).toBe(MESSAGE_RELATION.IDENTICAL);
    expect(isPrefixContinuation(r.relation)).toBe(true);
  });

  it("A then A-with-C-instead-of-B is NOT continuity", () => {
    // Same length as the extension case above: only the prefix proof separates them.
    const r = classifyMessageSequences(recorded([...A, B]), incoming([...A, C]));
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(isPrefixContinuation(r.relation)).toBe(false);
    expect(r.divergence_index).toBe(2);
  });

  it("A then a shortened A is a discontinuity and a compaction candidate", () => {
    const r = classifyMessageSequences(recorded([...A, B]), incoming(A));
    expect(r.relation).toBe(MESSAGE_RELATION.SHORTENED);
    expect(isPrefixContinuation(r.relation)).toBe(false);
    // The survivors are still the original opening messages: a clean truncation.
    expect(r.next_is_prefix_of_prev).toBe(true);
  });

  it("reordered prior messages are NOT continuity, at the same count", () => {
    const r = classifyMessageSequences(recorded(A), incoming([A[1], A[0]]));
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.divergence_index).toBe(0);
  });

  it("a modified historical message is NOT continuity, even with more messages after it", () => {
    const edited = [{ role: "user", content: "one (edited)" }, A[1], B];
    const r = classifyMessageSequences(recorded(A), incoming(edited));
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
    expect(r.divergence_index).toBe(0);
  });

  it("a changed tools layer is a discontinuity of the tools layer", () => {
    const prev = computePrefixLayers({ tools: [{ name: "read" }], system: "s", messages: A });
    const next = computePrefixLayers({ tools: [{ name: "write" }], system: "s", messages: [...A, B] });
    const inv = invalidatedLayers(
      { tools_hash: prev.tools.hash, system_hash: prev.system.hash, messages_hash: prev.messages.hash },
      { tools_hash: next.tools.hash, system_hash: next.system.hash, messages_hash: next.messages.hash },
    );
    expect(inv.changed).toContain("tools");
    // §7 ordering: tools invalidate everything after them.
    expect(inv.invalidated).toEqual(["tools", "system", "messages"]);
  });

  it("a changed system layer invalidates system and messages but not tools", () => {
    const prev = computePrefixLayers({ tools: [{ name: "read" }], system: "s", messages: A });
    const next = computePrefixLayers({ tools: [{ name: "read" }], system: "s2", messages: A });
    const inv = invalidatedLayers(
      { tools_hash: prev.tools.hash, system_hash: prev.system.hash, messages_hash: prev.messages.hash },
      { tools_hash: next.tools.hash, system_hash: next.system.hash, messages_hash: next.messages.hash },
    );
    expect(inv.changed).toEqual(["system"]);
    expect(inv.invalidated).toEqual(["system", "messages"]);
  });
});

describe("count alone is never the evidence", () => {
  it("a longer sequence that does not extend the recorded prefix is a divergence", () => {
    const r = classifyMessageSequences(recorded(A), incoming([C, B, A[0], A[1]]));
    expect(r.next_count).toBeGreaterThan(r.prev_count);
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
  });

  it("an equal count with a different hash is a divergence, not identity", () => {
    const r = classifyMessageSequences(recorded(A), incoming([A[0], C]));
    expect(r.next_count).toBe(r.prev_count);
    expect(r.relation).toBe(MESSAGE_RELATION.DIVERGENCE);
  });
});

describe("undecidable is a distinct answer", () => {
  it("no recorded prefix state is indeterminate, not divergence", () => {
    const r = classifyMessageSequences(null, incoming(A));
    expect(r.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(r.reason).toBe("no_recorded_prefix_state");
    expect(isPrefixContinuation(r.relation)).toBe(false);
  });

  it("a request with no messages layer is indeterminate", () => {
    const r = classifyMessageSequences(recorded(A), { hash: null, count: null });
    expect(r.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(r.reason).toBe("request_has_no_messages_layer");
  });

  it("a missing chain cannot prove an extension", () => {
    const layer = incoming([...A, B]);
    const r = classifyMessageSequences(recorded(A), { hash: layer.hash, count: layer.count, digests: layer.digests });
    expect(r.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(r.reason).toBe("no_chain_available");
  });
});
