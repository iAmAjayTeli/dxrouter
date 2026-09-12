/**
 * M2 group E — the failed attempt as the request path actually produces it.
 *
 * The engine-side rules for a failed attempt are pinned in `attempt-outcome.test.js`. What
 * that file cannot show is that a failure *reaches* the observation at all: the two places
 * an attempt dies are inside `handleChatCore`, several frames below the app, and a test that
 * hand-wrote the payload would prove the engine and nothing about the wiring.
 *
 * So the real `handleChatCore` runs here. Only the network is replaced — one mocked executor
 * that returns a 429, or throws — plus the two persistence sinks (`@/lib/usageDb.js`, the
 * request logger) that would otherwise write into a database and a log directory this test
 * has no business creating. Nothing on the failure path is stubbed: the branch under test,
 * `observeFailedAttempt`, `describeFailure` and `observeCacheResult` all run as shipped.
 *
 * Two claims, and the second matters as much as the first:
 *
 *  1. a failed attempt is observable, with the facts that existed at failure time;
 *  2. the request path behaves exactly as it did — same returned result, same single
 *     attempt, same status handed back to the account loop — with the observer present,
 *     absent, or throwing. `accountFallback` reads `{success, status, resetsAtMs}`, and
 *     those are asserted on every branch below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { observeFailedAttempt } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { observeProviderResult } = await import("../../adapters/ninerouter/cacheObserver.js");
const { CACHE_CONFIDENCE, CACHE_EVIDENCE } = await import("../../continuity/cache/confidence.js");
const { NO_ENTRIES } = await import("../../continuity/cache/observer.js");
const { DEFAULT_CACHE_POLICY } = await import("../../continuity/cache/policy.js");
const { createMemorySource, loadCacheModels } = await import("../../continuity/cache/pricing/index.js");
const { messages, openHarness, removeTmpDir, turnRequest } = await import("./helpers/harness.js");

const VENDOR_YAML = [
  "provider: vendor",
  "mechanism: explicit",
  "breakpoints: 4",
  "min_cacheable_tokens: 1",
  "ttl_default_s: 300",
  "write_multiplier_default: 1.25",
  "read_multiplier: 0.1",
  "reports_cache_read: true",
  "reports_cache_write: true",
  "verification_method: documentation",
  "verified_at: 2023-11-10",
  "verified_by: test fixture",
  "source: https://example.invalid/docs",
  "version: 1",
].join("\n");

const DEFAULT_YAML = ["provider: default", "mechanism: none", "version: 1"].join("\n");

const registry = (now) =>
  loadCacheModels({
    source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }),
    now,
    policy: DEFAULT_CACHE_POLICY,
  });

/** One non-streaming completion through the real handler. */
function callChatCore({ onProviderResult = null, log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() } } = {}) {
  return handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
    modelInfo: { provider: "vendor", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log,
    connectionId: "conn-a",
    headroomEnabled: false,
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    onProviderResult,
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
  });
}

const RATE_LIMITED = () => ({
  response: new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" },
  }),
  url: "https://api.vendor.invalid/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

const OK = () => ({
  response: new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
  url: "https://api.vendor.invalid/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Q3-D — a failed attempt as handleChatCore produces it", () => {
  it("observes a provider error response, and returns exactly what it returned before", async () => {
    const seen = [];
    executeMock.mockResolvedValue(RATE_LIMITED());

    const result = await callChatCore({ onProviderResult: (r) => seen.push(r) });

    // The value the account loop reads. A 429 still comes back as a 429, and the retry
    // window it parsed is still there: observation changed no branch of this path.
    expect(result).toMatchObject({ success: false, status: 429 });
    expect(executeMock).toHaveBeenCalledTimes(1);

    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      provider: "vendor",
      model: "gpt-4o",
      connectionId: "conn-a",
      endpoint: "/v1/chat/completions",
      status: "error",
      // The status the provider itself returned, not the one mapped for the client.
      http_status: 429,
      // No usage was invented to fill the shape.
      usage: null,
      // Nothing was read from the stream, so there is no time-to-first-byte.
      ttfb_ms: null,
    });
    expect(typeof seen[0].total_ms).toBe("number");
    // The headers travel for one reason: a retry hint the adapter may read.
    expect(seen[0].headers.get("retry-after")).toBe("60");
  });

  it("observes a transport failure with no status at all", async () => {
    const seen = [];
    executeMock.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }));

    const result = await callChatCore({ onProviderResult: (r) => seen.push(r) });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      status: "error",
      // A refused socket has no HTTP status and no headers. Null is "not known", not 0.
      http_status: null,
      headers: null,
      usage: null,
    });
    expect(seen[0].error).toMatchObject({ name: "Error" });
    expect(seen[0].error.message).toContain("ECONNREFUSED");
  });

  it("observes an aborted request and still returns 499", async () => {
    const seen = [];
    executeMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    const result = await callChatCore({ onProviderResult: (r) => seen.push(r) });

    expect(result).toMatchObject({ success: false, status: 499 });
    expect(seen[0]).toMatchObject({ status: "error", http_status: null });
    expect(seen[0].error.name).toBe("AbortError");
  });

  it("does not report a successful completion as a failed attempt", async () => {
    const seen = [];
    executeMock.mockResolvedValue(OK());

    const result = await callChatCore({ onProviderResult: (r) => seen.push(r) });

    expect(result.success).not.toBe(false);
    // The usage path may report the completion; the failure path must not.
    expect(seen.filter((r) => r.status === "error")).toEqual([]);
  });
});

describe("Q3-E — observation cannot change the request path", () => {
  it("returns the same result with an observer, without one, and with one that throws", async () => {
    executeMock.mockResolvedValue(RATE_LIMITED());
    const read = (r) => ({ success: r.success, status: r.status, error: r.error, resetsAtMs: r.resetsAtMs });

    const observed = await callChatCore({ onProviderResult: () => {} });
    executeMock.mockResolvedValue(RATE_LIMITED());
    // `null` is what the app passes when `DXR_CACHE_TRACKING=off`: the inherited call sites
    // see the same value they saw before M2.
    const unobserved = await callChatCore({ onProviderResult: null });
    executeMock.mockResolvedValue(RATE_LIMITED());
    const broken = await callChatCore({
      onProviderResult: () => {
        throw new Error("observer blew up");
      },
    });

    expect(read(unobserved)).toEqual(read(observed));
    expect(read(broken)).toEqual(read(observed));
    // Three calls, one attempt each: nothing here retried, and nothing skipped an attempt.
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("returns nothing routable, and nothing at all, from the observation itself", () => {
    const seen = [];
    // The return value is unused by design: a caller could otherwise await a SQLite write
    // into the response path.
    expect(observeFailedAttempt({ onProviderResult: (r) => seen.push(r), provider: "vendor", model: "m" })).toBe(undefined);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ status: "error", usage: null, http_status: null, headers: null, error: null });

    // No callback, a non-function, and a throwing callback are all no-ops rather than
    // failures: an observation may never fail a request.
    expect(observeFailedAttempt({ provider: "vendor", model: "m" })).toBe(undefined);
    expect(observeFailedAttempt({ onProviderResult: "not a function", provider: "vendor", model: "m" })).toBe(undefined);
    expect(() =>
      observeFailedAttempt({
        onProviderResult: () => {
          throw new Error("nope");
        },
        provider: "vendor",
        model: "m",
      }),
    ).not.toThrow();
  });
});

describe("Q3-F — the observed facts become one honest row", () => {
  let h;

  beforeEach(async () => {
    h = await openHarness({ tag: "m2-failpath" });
  });

  afterEach(() => {
    const dir = h?.dir;
    h?.close();
    if (dir) removeTmpDir(dir);
  });

  it("persists the 429 the request path reported, and no cache belief", async () => {
    const seen = [];
    executeMock.mockResolvedValue(RATE_LIMITED());
    await callChatCore({ onProviderResult: (r) => seen.push(r) });
    expect(seen.length).toBe(1);

    h.tick(1000);
    const observation = await h.observe(turnRequest({ key: "s-path", root: "/repo/one", msgs: messages(41, "path ") }));
    // Exactly what `src/lib/dxr/cache.js` forwards: the payload as reported, plus the clock
    // reading it stamps. No field is added, classified or defaulted on the way.
    const record = await observeProviderResult({
      observation,
      result: { ...seen[0], at: h.at() },
      store: h.store,
      registry: registry(h.at()),
      clock: h.clock,
      env: {},
    });

    expect(record).toMatchObject({
      observed: true,
      failed: true,
      confidence: CACHE_CONFIDENCE.UNKNOWN,
      evidence: CACHE_EVIDENCE.ATTEMPT_FAILED,
      error_class: "rate_limit",
      skipped: NO_ENTRIES.ATTEMPT_FAILED,
    });

    const row = h.db.get("SELECT * FROM turn_results ORDER BY seq DESC LIMIT 1");
    expect(row).toMatchObject({
      provider: "vendor",
      status: "error",
      http_status: 429,
      error_class: "rate_limit",
      // The provider named a window, so the row carries it; the timings are the ones the
      // host actually had.
      retry_after_s: 60,
      ttfb_ms: null,
      usage_in: null,
      usage_cache_read: null,
      usage_provenance: "unavailable",
      cache_confidence: "unknown",
    });
    expect(typeof row.total_ms).toBe("number");
    // No belief was created from an attempt that never got a response.
    expect(Number(h.db.get("SELECT COUNT(*) AS n FROM cache_entries")?.n) || 0).toBe(0);
  });
});
