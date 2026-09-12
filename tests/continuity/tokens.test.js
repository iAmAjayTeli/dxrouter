/**
 * Group D — token counts and provenance (§14 D, §6).
 *
 * The rule the milestone cares about is not accuracy, it is honesty: a number must
 * always arrive with the story of where it came from. `measured` only when a real
 * tokenizer answered, `estimated` for the built-in deterministic estimator (labelled
 * with its version), `unavailable` when there is nothing to count — and never a
 * silently-invented zero.
 *
 * No cache economics anywhere: these counts feed nothing but the `turns` row in M1.
 */

import { describe, it, expect } from "vitest";

import {
  ESTIMATOR_VERSION,
  TOKEN_PROVENANCE,
  countLayerTokens,
  estimateTokens,
  estimateTokensForBytes,
  intOrNull,
  isTokenProvenance,
} from "../../continuity/prefix/tokens.js";
import { computePrefixLayers, prefixLayerSummary } from "../../continuity/prefix/hasher.js";

const MESSAGES = [{ role: "user", content: "hello world" }];

describe("provenance vocabulary", () => {
  it("is exactly the three §6 values", () => {
    expect(Object.values(TOKEN_PROVENANCE).sort()).toEqual(["estimated", "measured", "unavailable"]);
    for (const v of Object.values(TOKEN_PROVENANCE)) expect(isTokenProvenance(v)).toBe(true);
    expect(isTokenProvenance("guessed")).toBe(false);
  });
});

describe("estimated is the default and says so", () => {
  it("labels the estimator version, not just the number", () => {
    const r = countLayerTokens(MESSAGES);
    expect(r.provenance).toBe(TOKEN_PROVENANCE.ESTIMATED);
    expect(r.estimator).toBe(ESTIMATOR_VERSION);
    expect(r.tokens).toBeGreaterThan(0);
  });

  it("is deterministic and monotone in content length", () => {
    const short = countLayerTokens([{ role: "user", content: "a" }]).tokens;
    const long = countLayerTokens([{ role: "user", content: "a".repeat(400) }]).tokens;
    expect(long).toBeGreaterThan(short);
    expect(countLayerTokens(MESSAGES).tokens).toBe(countLayerTokens(MESSAGES).tokens);
  });

  it("counts canonical bytes, which is why it is an estimate", () => {
    // Documented limitation: no tokenizer, no vocabulary, no model awareness. The
    // number is bytes/4 over the canonical form and is only ever compared with
    // another number produced the same way.
    expect(estimateTokensForBytes(4)).toBe(1);
    expect(estimateTokensForBytes(5)).toBe(2);
    expect(estimateTokensForBytes(0)).toBe(0);
    expect(estimateTokens("abcd")).toBe(estimateTokensForBytes(Buffer.byteLength(JSON.stringify("abcd"), "utf8")));
  });
});

describe("measured requires a tokenizer that actually answered", () => {
  it("takes a real count when the tokenizer returns one", () => {
    const r = countLayerTokens(MESSAGES, { tokenizer: () => 42 });
    expect(r).toEqual({ tokens: 42, provenance: TOKEN_PROVENANCE.MEASURED, estimator: null });
  });

  it("falls back to estimated when the tokenizer declines", () => {
    const r = countLayerTokens(MESSAGES, { tokenizer: () => null });
    expect(r.provenance).toBe(TOKEN_PROVENANCE.ESTIMATED);
  });

  it("falls back to estimated when the tokenizer throws", () => {
    const r = countLayerTokens(MESSAGES, {
      tokenizer: () => {
        throw new Error("no vocabulary loaded");
      },
    });
    expect(r.provenance).toBe(TOKEN_PROVENANCE.ESTIMATED);
    expect(r.tokens).toBeGreaterThan(0);
  });

  it("rejects a nonsense count rather than trusting it", () => {
    for (const bad of [-1, 1.5, Number.NaN, "12", Infinity]) {
      const r = countLayerTokens(MESSAGES, { tokenizer: () => bad });
      expect(r.provenance, String(bad)).toBe(TOKEN_PROVENANCE.ESTIMATED);
    }
  });
});

describe("unavailable is used, not faked", () => {
  it("reports unavailable with a null count for a layer that is not there", () => {
    for (const missing of [null, undefined]) {
      const r = countLayerTokens(missing);
      expect(r).toEqual({ tokens: null, provenance: TOKEN_PROVENANCE.UNAVAILABLE, estimator: null });
    }
  });

  it("reports unavailable for a value that cannot be canonicalized", () => {
    const cyclic = { name: "loop" };
    cyclic.self = cyclic;
    const r = countLayerTokens(cyclic);
    expect(r.tokens).toBeNull();
    expect(r.provenance).toBe(TOKEN_PROVENANCE.UNAVAILABLE);
  });
});

describe("per-layer counts travel with the layer set", () => {
  it("gives every layer its own count and provenance", () => {
    const layers = computePrefixLayers({ tools: [{ name: "read" }], system: "sys", messages: MESSAGES });
    const summary = prefixLayerSummary(layers);
    expect(summary.tools_tokens).toBeGreaterThan(0);
    expect(summary.system_tokens).toBeGreaterThan(0);
    expect(summary.messages_tokens).toBeGreaterThan(0);
    expect([
      summary.tools_tokens_provenance,
      summary.system_tokens_provenance,
      summary.messages_tokens_provenance,
    ]).toEqual(["estimated", "estimated", "estimated"]);
  });

  it("marks only the missing layer unavailable", () => {
    const layers = computePrefixLayers({ system: "sys", messages: MESSAGES });
    const summary = prefixLayerSummary(layers);
    expect(summary.tools_tokens).toBeNull();
    expect(summary.tools_tokens_provenance).toBe(TOKEN_PROVENANCE.UNAVAILABLE);
    expect(summary.system_tokens_provenance).toBe(TOKEN_PROVENANCE.ESTIMATED);
  });

  it("uses the injected tokenizer for every layer when it answers", () => {
    const layers = computePrefixLayers(
      { tools: [{ name: "read" }], system: "sys", messages: MESSAGES },
      { tokenizer: () => 7 },
    );
    const summary = prefixLayerSummary(layers);
    expect([summary.tools_tokens, summary.system_tokens, summary.messages_tokens]).toEqual([7, 7, 7]);
    expect(summary.messages_tokens_provenance).toBe(TOKEN_PROVENANCE.MEASURED);
  });
});

/**
 * The coercion the cache and evidence paths share. It is here rather than beside them
 * because it encodes the same distinction the provenance vocabulary above does: `null`
 * is `unavailable`, and `0` is a number somebody measured.
 */
describe("an absent count is not a zero", () => {
  it("keeps null, undefined and blanks absent rather than coercing them to 0", () => {
    // `Number(null)`, `Number("")`, `Number([])` and `Number(false)` are all 0, and 0 is
    // finite — which is how provider silence turns into a reported cache miss.
    for (const absent of [null, undefined, "", "   ", [], false, true, {}, NaN, Infinity, "abc"]) {
      expect(intOrNull(absent)).toBeNull();
    }
  });

  it("truncates a real number toward zero and keeps a reported zero", () => {
    expect(intOrNull(0)).toBe(0);
    expect(intOrNull("0")).toBe(0);
    expect(intOrNull(3000)).toBe(3000);
    expect(intOrNull("3000")).toBe(3000);
    expect(intOrNull(12.7)).toBe(12);
    expect(intOrNull(-12.7)).toBe(-12);
  });
});
