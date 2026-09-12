/**
 * I-3 — provider cache fields, through the real extraction chain.
 *
 * Every Q1 number rests on one claim: that when a provider reports a cache read, the number
 * survives the walk from the provider's bytes to the engine's `{cache_read}`. Until this
 * file existed the claim was tested only where it was easiest to test — by handing
 * `toEngineUsage` an object a test wrote by hand. That proves the field table, and nothing
 * about the chain. A field dropped or zeroed one layer earlier would leave every unit test
 * green and every measurement wrong, which is the failure this file exists to catch.
 *
 * So the fixtures here are **provider payloads**, and the functions under test are the ones
 * the request path actually calls:
 *
 *  - non-streaming: `extractUsageFromResponse` (what `nonStreamingHandler` calls) →
 *    `toEngineUsage` → `classifyCacheResult`
 *  - streaming: the real `createSSEStream` transform, fed raw SSE bytes, with the real
 *    `buildOnStreamComplete` → the real `saveUsageStats` → the `onProviderResult` side
 *    channel M2 observes → `toEngineUsage`
 *
 * One thing is mocked and it is deliberate: `@/lib/usageDb.js`, the persistence sink. It is
 * downstream of everything asserted here and importing it for real would write rows into a
 * database this test has no business creating. Nothing on the extraction path is stubbed —
 * `extractUsage`, `mergeUsage`, `normalizeUsage`, `canonicalizeUsage`, the SSE parser and
 * the translator all run as shipped.
 *
 * The rule under test throughout is I4: **absent stays null, never zero.** A reported zero
 * is a measurement ("the provider looked and found no cache read"); a fabricated zero is
 * not, and the two must not arrive at the engine looking alike.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(() => {}),
}));

const { extractUsageFromResponse, saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { extractUsage, mergeUsage, estimateUsage } = await import("../../open-sse/utils/usageTracking.js");
const { createSSEStream } = await import("../../open-sse/utils/stream.js");
const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { toEngineUsage } = await import("../../adapters/ninerouter/cacheObserver.js");
const { classifyCacheResult } = await import("../../continuity/cache/observer.js");
const { CACHE_EVIDENCE, CACHE_CONFIDENCE } = await import("../../continuity/cache/confidence.js");

/** The engine's own shape, so a diff reads as `{input, output, cache_read, cache_write}`. */
const engineUsage = (raw) => toEngineUsage(raw);

/** Provider bytes → the stream's final usage, through the transform the router installs. */
async function runStream({ sse, mode = "passthrough", sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI, provider = "test", body = null }) {
  const seen = [];
  const { onStreamComplete } = buildOnStreamComplete({
    provider,
    model: "m",
    connectionId: "c",
    apiKey: "k",
    requestStartTime: Date.now(),
    body: body ?? { model: "m", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    // The M2 side channel, unmodified: this is the exact callback `src/lib/dxr/cache.js`
    // registers, and `result.usage` is what reaches `observeProviderResult`.
    onProviderResult: (result) => seen.push(result),
  });

  const stream = createSSEStream({
    mode,
    sourceFormat,
    targetFormat,
    provider,
    model: "m",
    connectionId: "c",
    body: body ?? { model: "m", messages: [{ role: "user", content: "hi" }] },
    onStreamComplete,
  });

  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const drain = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
  await writer.write(new TextEncoder().encode(sse));
  await writer.close();
  await drain;
  return { results: seen, usage: seen[seen.length - 1]?.usage ?? null };
}

describe("I-3 non-streaming: a provider's own response body, through `extractUsageFromResponse`", () => {
  it("Claude: cache_read_input_tokens survives as a confirmed read", () => {
    const extracted = extractUsageFromResponse({
      id: "msg_1",
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 8192, cache_creation_input_tokens: 256 },
    });
    const usage = engineUsage(extracted);
    expect(usage).toMatchObject({ input: 120, output: 40, cache_read: 8192, cache_write: 256, estimated: false });
    expect(classifyCacheResult({ usage, mechanism: "explicit_breakpoint" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
      reported: true,
    });
  });

  it("OpenAI chat: prompt_tokens_details.cached_tokens survives the flattening step", () => {
    const extracted = extractUsageFromResponse({
      usage: {
        prompt_tokens: 4096,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 3072 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
    // `requestDetail.js` flattens it to `cached_tokens`; the field table has to know both.
    expect(extracted.cached_tokens).toBe(3072);
    expect(engineUsage(extracted)).toMatchObject({ input: 4096, output: 12, cache_read: 3072, cache_write: null });
  });

  it("DeepSeek: prompt_cache_hit_tokens is a read; prompt_cache_miss_tokens is NOT a write", () => {
    const body = {
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 },
    };
    // The non-streaming extractor keeps only OpenAI's own spelling, so the vendor field
    // reaches the observer on the raw usage object — which is why the field table lists it.
    const viaRaw = engineUsage(body.usage);
    expect(viaRaw).toMatchObject({ input: 1000, cache_read: 640 });
    // The miss count is the *uncached remainder*. Reading it as a cache write would put
    // "we paid full price" into the column that means "we cached this".
    expect(viaRaw.cache_write).toBe(null);
  });

  it("Gemini: an omitted cachedContentTokenCount stays null, and a reported 0 stays 0", () => {
    const silent = extractUsageFromResponse({
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, totalTokenCount: 930 },
    });
    // The `?? null` in requestDetail.js is the whole point: `|| 0` here would manufacture
    // a measured cache miss out of a field the provider never sent.
    expect(silent.cached_tokens).toBe(null);
    const silentUsage = engineUsage(silent);
    expect(silentUsage.cache_read).toBe(null);
    expect(classifyCacheResult({ usage: silentUsage, mechanism: "implicit" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.ASSUMED,
      evidence: CACHE_EVIDENCE.PROVIDER_SILENT,
      reported: false,
    });

    const zero = extractUsageFromResponse({
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, cachedContentTokenCount: 0 },
    });
    const zeroUsage = engineUsage(zero);
    expect(zeroUsage.cache_read).toBe(0);
    // A reported zero IS a report: the provider looked and said none. Different finding.
    expect(classifyCacheResult({ usage: zeroUsage, mechanism: "implicit" })).toMatchObject({
      evidence: CACHE_EVIDENCE.ASSUMED_WRITE,
      reported: true,
    });
  });

  it("Gemini wrapped in `{response: …}` (antigravity, gemini-cli) takes the same path", () => {
    const extracted = extractUsageFromResponse({
      response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, cachedContentTokenCount: 4 } },
    });
    expect(engineUsage(extracted)).toMatchObject({ input: 10, output: 2, cache_read: 4 });
  });

  it("Responses API: input_tokens_details.cached_tokens reaches the engine off the raw body", () => {
    const raw = {
      usage: { input_tokens: 2048, output_tokens: 16, input_tokens_details: { cached_tokens: 1024 } },
    };
    // `extractUsageFromResponse` reads the Claude branch here (input_tokens is present),
    // which does not carry the nested Responses field — so the observer sees the raw usage.
    expect(engineUsage(raw.usage)).toMatchObject({ input: 2048, output: 16, cache_read: 1024 });
  });

  it("a response with no usage at all yields null everywhere, not zeros", () => {
    expect(extractUsageFromResponse({ choices: [] })).toBe(null);
    expect(engineUsage(null)).toEqual({ input: null, output: null, cache_read: null, cache_write: null, estimated: false });
  });
});

describe("I-3 streaming: the same fields through `extractUsage` + `mergeUsage`", () => {
  it("Claude splits usage across message_start and message_delta; the merge keeps the cache counts", () => {
    const start = extractUsage({
      type: "message_start",
      message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 8192, cache_creation_input_tokens: 0 } },
    });
    const delta = extractUsage({ type: "message_delta", usage: { output_tokens: 77 } });
    const merged = mergeUsage(start, delta);
    // The failure this guards: overwriting instead of merging drops the cache read, and
    // the turn is then filed as provider-silent.
    expect(engineUsage(merged)).toMatchObject({ input: 120, output: 77, cache_read: 8192, cache_write: 0 });
  });

  it("Gemini streaming: absent cachedContentTokenCount is absent after normalization", () => {
    const merged = mergeUsage(
      extractUsage({ usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 10 } }),
      extractUsage({ usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 25, totalTokenCount: 525 } }),
    );
    expect("cached_tokens" in merged).toBe(false);
    expect(engineUsage(merged).cache_read).toBe(null);
  });

  it("DeepSeek streaming: prompt_cache_hit_tokens is folded into cached_tokens by extractUsage", () => {
    const chunk = extractUsage({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 },
    });
    expect(chunk.cached_tokens).toBe(640);
    expect(engineUsage(chunk)).toMatchObject({ input: 1000, output: 20, cache_read: 640, cache_write: null });
  });

  it("Responses API streaming: response.completed carries the nested cached_tokens", () => {
    const chunk = extractUsage({
      type: "response.completed",
      response: { usage: { input_tokens: 2048, output_tokens: 16, input_tokens_details: { cached_tokens: 1024 } } },
    });
    expect(engineUsage(chunk)).toMatchObject({ input: 2048, output: 16, cache_read: 1024 });
  });

  it("mergeUsage never lets one malformed chunk poison the accumulation", () => {
    const merged = mergeUsage({ prompt_tokens: 10, cached_tokens: 4 }, { prompt_tokens: Number.NaN });
    expect(engineUsage(merged)).toMatchObject({ input: 10, cache_read: 4 });
  });
});

describe("I-3 end to end: raw SSE bytes through the transform the router installs", () => {
  it("passthrough (OpenAI-compatible): a reported cache read reaches the M2 side channel", async () => {
    const sse = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4096,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3072}}}',
      "data: [DONE]",
      "",
    ].join("\n");

    const { results, usage } = await runStream({ sse });
    expect(results).toHaveLength(1);
    const engine = engineUsage(usage);
    expect(engine).toMatchObject({ input: 4096, cache_read: 3072, estimated: false });
    expect(classifyCacheResult({ usage: engine, mechanism: "implicit" })).toMatchObject({
      confidence: CACHE_CONFIDENCE.CONFIRMED,
      evidence: CACHE_EVIDENCE.PROVIDER_REPORTED_READ,
    });
  });

  it("passthrough (DeepSeek): the vendor's own spelling survives the whole pipe", async () => {
    const sse = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":3,"prompt_cache_hit_tokens":640,"prompt_cache_miss_tokens":360}}',
      "data: [DONE]",
      "",
    ].join("\n");

    const { usage } = await runStream({ sse, provider: "deepseek" });
    expect(engineUsage(usage)).toMatchObject({ input: 1000, cache_read: 640, cache_write: null });
  });

  it("translate (Claude upstream → OpenAI client): cache counts survive translation", async () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":8192,"cache_creation_input_tokens":256}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":77}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const { usage } = await runStream({
      sse,
      mode: "translate",
      targetFormat: FORMATS.CLAUDE,
      sourceFormat: FORMATS.OPENAI,
      provider: "claude",
    });
    expect(engineUsage(usage)).toMatchObject({ input: 120, output: 77, cache_read: 8192, cache_write: 256 });
  });

  it("a silent provider gets 9Router's byte-length estimate, and it arrives labelled", async () => {
    const sse = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"a fairly long answer with no usage attached"}}]}',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n");

    const { usage } = await runStream({ sse });
    const engine = engineUsage(usage);
    // The number is real arithmetic on bytes, but it is ours, not the provider's. I3 needs
    // that provenance to travel with it: an estimate must never be counted as evidence
    // that a provider reports cache data.
    expect(engine.estimated).toBe(true);
    expect(engine.cache_read).toBe(null);
    expect(classifyCacheResult({ usage: engine, mechanism: "implicit" })).toMatchObject({
      evidence: CACHE_EVIDENCE.PROVIDER_SILENT,
      reported: false,
    });
  });

  it("`estimateUsage` output is labelled in both format spellings", () => {
    const openai = estimateUsage({ model: "m", messages: [{ role: "user", content: "hello" }] }, 400, FORMATS.OPENAI);
    const claude = estimateUsage({ model: "m", messages: [{ role: "user", content: "hello" }] }, 400, FORMATS.CLAUDE);
    expect(engineUsage(openai).estimated).toBe(true);
    expect(engineUsage(claude).estimated).toBe(true);
    expect(engineUsage(openai).cache_read).toBe(null);
    expect(engineUsage(claude).cache_read).toBe(null);
  });

  it("`saveUsageStats` hands the observer the usage object verbatim", () => {
    const seen = [];
    const tokens = { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 0 };
    saveUsageStats({ provider: "p", model: "m", tokens, connectionId: "c", silent: true, onProviderResult: (r) => seen.push(r) });
    expect(seen).toHaveLength(1);
    // Verbatim matters: a reported zero must still be a report by the time it is classified.
    expect(seen[0].usage).toBe(tokens);
    expect(engineUsage(seen[0].usage).cache_read).toBe(0);
  });

  it("an observation that throws cannot break the response path", () => {
    expect(() =>
      saveUsageStats({
        provider: "p",
        model: "m",
        tokens: { prompt_tokens: 1 },
        silent: true,
        onProviderResult: () => {
          throw new Error("observer exploded");
        },
      }),
    ).not.toThrow();
  });
});
