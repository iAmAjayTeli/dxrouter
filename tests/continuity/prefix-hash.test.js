/**
 * Group C — prefix hashing (§14 C).
 *
 * Three layers, three independent hashes, and the properties that make them usable as
 * cache-continuity evidence later: determinism across processes, insensitivity to key
 * and (where semantically irrelevant) ordering, Unicode normalization, and isolation —
 * a change in one layer must not perturb another. Isolation is the load-bearing one:
 * §7 invalidation is only meaningful if the layers really are separable.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_CHAIN_ROOT,
  chainFromDigests,
  computePrefixLayers,
  hashMessagesLayer,
  hashSystemLayer,
  hashToolsLayer,
  messageDigests,
  prefixLayerSummary,
} from "../../continuity/prefix/hasher.js";
import { CANON_VERSION, digest, isDigest } from "../../continuity/canonical/serialize.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const TOOLS = [{ name: "read", parameters: { type: "object", properties: { a: { type: "string" } } } }];
const SYSTEM = "You are a coding agent.";
const MESSAGES = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

describe("layer hashes are digests of the canonical form", () => {
  it("produces c1-tagged sha256 digests", () => {
    const layers = computePrefixLayers({ tools: TOOLS, system: SYSTEM, messages: MESSAGES });
    for (const h of [layers.tools.hash, layers.system.hash, layers.messages.hash]) {
      expect(isDigest(h)).toBe(true);
      expect(h.startsWith(`${CANON_VERSION}:`)).toBe(true);
    }
  });

  it("is deterministic for the same input", () => {
    const a = computePrefixLayers({ tools: TOOLS, system: SYSTEM, messages: MESSAGES });
    const b = computePrefixLayers({ tools: TOOLS, system: SYSTEM, messages: MESSAGES });
    expect(prefixLayerSummary(a)).toEqual(prefixLayerSummary(b));
  });

  it("is stable across processes", () => {
    // A hash that only agrees with itself inside one process is useless as continuity
    // evidence after a restart, so this actually spawns node.
    const script = [
      "import { computePrefixLayers } from './continuity/prefix/hasher.js';",
      "const l = computePrefixLayers({ tools: [{ name: 'read' }], system: 'sys', messages: [{ role: 'user', content: 'hi' }] });",
      "process.stdout.write([l.tools.hash, l.system.hash, l.messages.hash].join('|'));",
    ].join("");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000, // a sync spawn blocks the worker; testTimeout cannot interrupt it
    });
    const local = computePrefixLayers({
      tools: [{ name: "read" }],
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.trim()).toBe([local.tools.hash, local.system.hash, local.messages.hash].join("|"));
  });
});

describe("logically identical inputs hash identically", () => {
  it("ignores object key order", () => {
    const a = hashToolsLayer([{ name: "read", description: "d", parameters: { type: "object" } }]);
    const b = hashToolsLayer([{ parameters: { type: "object" }, description: "d", name: "read" }]);
    expect(a).toBe(b);
  });

  it("normalizes Unicode to NFC", () => {
    const composed = "caf" + String.fromCodePoint(0xe9);
    const decomposed = "cafe" + String.fromCodePoint(0x301);
    expect(composed).not.toBe(decomposed);
    expect(hashSystemLayer(composed)).toBe(hashSystemLayer(decomposed));
  });

  it("does NOT ignore array order, because message order is meaning", () => {
    const forward = hashMessagesLayer(MESSAGES).hash;
    const reversed = hashMessagesLayer([...MESSAGES].reverse()).hash;
    expect(forward).not.toBe(reversed);
  });

  it("distinguishes an absent field from a null one inside a layer", () => {
    // §10.3: absent is not null. A tool whose `description` key is missing and one
    // whose description is explicitly null are different tools, and a hash that
    // conflated them would report continuity across a real change.
    expect(hashToolsLayer([{ name: "read" }])).not.toBe(hashToolsLayer([{ name: "read", description: null }]));
  });

  it("treats a null layer and a missing layer alike, because both mean no layer", () => {
    // The layer level is the one place where null and absent agree: a request with
    // `tools: null` carries no tools, and the hash is null rather than a digest of
    // nothing. Recorded here so the asymmetry above is read as deliberate.
    expect(hashToolsLayer(undefined)).toBeNull();
    expect(hashToolsLayer(null)).toBeNull();
    expect(hashSystemLayer(null)).toBeNull();
  });
});

describe("layer isolation", () => {
  const base = computePrefixLayers({ tools: TOOLS, system: SYSTEM, messages: MESSAGES });

  it("changing tools leaves system and messages untouched", () => {
    const next = computePrefixLayers({ tools: [{ name: "write" }], system: SYSTEM, messages: MESSAGES });
    expect(next.tools.hash).not.toBe(base.tools.hash);
    expect(next.system.hash).toBe(base.system.hash);
    expect(next.messages.hash).toBe(base.messages.hash);
  });

  it("changing the system prompt leaves tools and messages untouched", () => {
    const next = computePrefixLayers({ tools: TOOLS, system: "different", messages: MESSAGES });
    expect(next.system.hash).not.toBe(base.system.hash);
    expect(next.tools.hash).toBe(base.tools.hash);
    expect(next.messages.hash).toBe(base.messages.hash);
  });

  it("appending a message leaves tools and system untouched", () => {
    const next = computePrefixLayers({
      tools: TOOLS,
      system: SYSTEM,
      messages: [...MESSAGES, { role: "user", content: "more" }],
    });
    expect(next.messages.hash).not.toBe(base.messages.hash);
    expect(next.tools.hash).toBe(base.tools.hash);
    expect(next.system.hash).toBe(base.system.hash);
  });
});

describe("the messages chain", () => {
  it("starts at the empty-list digest and grows one entry per message", () => {
    const layer = hashMessagesLayer(MESSAGES);
    expect(layer.chain[0]).toBe(EMPTY_CHAIN_ROOT);
    expect(layer.chain.length).toBe(MESSAGES.length + 1);
    expect(layer.chain[layer.chain.length - 1]).toBe(layer.hash);
    expect(layer.count).toBe(MESSAGES.length);
  });

  it("chain[k] is the hash of exactly the first k messages", () => {
    const layer = hashMessagesLayer(MESSAGES);
    for (let k = 0; k <= MESSAGES.length; k += 1) {
      expect(layer.chain[k]).toBe(hashMessagesLayer(MESSAGES.slice(0, k)).hash);
    }
  });

  it("is rebuildable from the per-message digests alone", () => {
    const digests = messageDigests(MESSAGES);
    expect(chainFromDigests(digests)).toEqual(hashMessagesLayer(MESSAGES).chain);
    expect(digests[0]).toBe(digest(MESSAGES[0]));
  });
});
