/**
 * `adapters/ninerouter` — the bilingual layer.
 *
 * These tests pin the translation in both directions. They matter more than most
 * unit tests here because this is the only file set allowed to know both
 * vocabularies: a mistake in it looks like an engine bug forever after.
 *
 * Nothing here touches the live request path — that is the M0 rule, and the
 * boundary test is what proves it structurally.
 */

import { describe, it, expect, vi } from "vitest";

import {
  normalizeRequest,
  toProtocol,
  PROTOCOL_BY_FORMAT,
  NormalizeAdapterError,
} from "../../adapters/ninerouter/normalizeAdapter.js";
import {
  createExecutorAdapter,
  attachHostRequest,
  classifyStatus,
  classifyThrown,
  parseRetryAfter,
  normalizeUsage,
  extractReportedModel,
  ExecutorAdapterError,
} from "../../adapters/ninerouter/executorAdapter.js";
import {
  createCredentialAdapter,
  loadConnectionSnapshot,
  toDescriptor,
  toCredentials,
  toEpochMs,
} from "../../adapters/ninerouter/credentialAdapter.js";
import {
  createCatalogAdapter,
  buildModelDescriptors,
  catalogVersionOf,
} from "../../adapters/ninerouter/catalogAdapter.js";
import { createClockAdapter, createOffsetClock } from "../../adapters/ninerouter/clockAdapter.js";
import {
  createLegacySelectionRecorder,
  classifyLegacyFailure,
  describeLegacyStep,
} from "../../adapters/ninerouter/legacySelectionAdapter.js";
import { createRoute } from "../../continuity/ports/routeExecutor.js";
import { fixedClock } from "../../continuity/ports/clock.js";
import { ERROR_CLASSES } from "../../continuity/ports/routeExecutor.js";

const AT = 1_700_000_000_000;

describe("normalizeAdapter — protocol mapping", () => {
  it("collapses 9Router's format space onto the five port protocols", () => {
    expect(toProtocol("openai")).toBe("openai");
    expect(toProtocol("claude")).toBe("anthropic");
    expect(toProtocol("gemini")).toBe("gemini");
    expect(toProtocol("gemini-cli")).toBe("gemini");
    expect(toProtocol("vertex")).toBe("gemini");
    expect(toProtocol("antigravity")).toBe("gemini");
    expect(toProtocol("openai-responses")).toBe("responses");
    expect(toProtocol("codex")).toBe("responses");
    expect(toProtocol("ollama")).toBe("ollama");
  });

  it("refuses to guess a protocol for a provider-only wire format", () => {
    // kiro / cursor / commandcode are *upstream* formats, never client dialects.
    // Guessing would silently change the prefix hash, which is worse than failing.
    for (const format of ["kiro", "cursor", "commandcode"]) {
      expect(() => toProtocol(format)).toThrow(NormalizeAdapterError);
      expect(PROTOCOL_BY_FORMAT[format]).toBeUndefined();
    }
    try {
      toProtocol("kiro");
    } catch (e) {
      expect(e.code).toBe("UNMAPPED_FORMAT");
      expect(e.format).toBe("kiro");
    }
  });
});

describe("normalizeAdapter — OpenAI", () => {
  const body = {
    model: "gpt-5",
    stream: true,
    temperature: 0.4,
    max_tokens: 512,
    tools: [{ type: "function", function: { name: "ls" } }],
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  };

  it("lifts system out of messages and keeps the rest ordered", () => {
    const req = normalizeRequest({ body, pathname: "/v1/chat/completions", arrivedAt: AT });
    expect(req.protocol).toBe("openai");
    expect(req.requested_model).toBe("gpt-5");
    expect(req.system).toBe("be terse");
    // The system layer is hashed separately from messages; leaving it in both
    // places would defeat layer-wise prefix caching.
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(req.tools).toHaveLength(1);
    expect(req.params).toMatchObject({ temperature: 0.4, max_tokens: 512, stream: true });
    expect(req.arrived_at).toBe(AT);
  });

  it("treats a developer message as system", () => {
    const req = normalizeRequest({
      body: { model: "m", messages: [{ role: "developer", content: "rules" }, { role: "user", content: "q" }] },
      arrivedAt: AT,
    });
    expect(req.system).toBe("rules");
    expect(req.messages).toHaveLength(1);
  });

  it("flattens multi-part system content", () => {
    const req = normalizeRequest({
      body: {
        model: "m",
        messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, { role: "user", content: "q" }],
      },
      arrivedAt: AT,
    });
    expect(req.system).toBe("ab");
  });
});

describe("normalizeAdapter — Anthropic", () => {
  it("reads the top-level system field, string or blocks", () => {
    const asString = normalizeRequest({
      body: { model: "claude-opus-4.7", system: "terse", messages: [{ role: "user", content: "hi" }] },
      pathname: "/v1/messages",
      arrivedAt: AT,
    });
    expect(asString.protocol).toBe("anthropic");
    expect(asString.system).toBe("terse");

    const asBlocks = normalizeRequest({
      body: {
        model: "claude-opus-4.7",
        system: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
        messages: [{ role: "user", content: "hi" }],
      },
      pathname: "/v1/messages",
      arrivedAt: AT,
    });
    expect(asBlocks.system).toBe("one\ntwo");
  });
});

describe("normalizeAdapter — Gemini", () => {
  it("reads contents/systemInstruction and treats the request as streaming", () => {
    const req = normalizeRequest({
      body: {
        model: "gemini-3-pro",
        systemInstruction: { parts: [{ text: "be brief" }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 100 },
      },
      format: "gemini",
      arrivedAt: AT,
    });
    expect(req.protocol).toBe("gemini");
    expect(req.system).toBe("be brief");
    expect(req.messages).toHaveLength(1);
    expect(req.params).toMatchObject({ temperature: 0.2, max_tokens: 100, stream: true });
  });

  it("unwraps a Vertex-style request envelope", () => {
    const req = normalizeRequest({
      body: { request: { model: "gemini-3-pro", contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      format: "vertex",
      arrivedAt: AT,
    });
    expect(req.requested_model).toBe("gemini-3-pro");
    expect(req.messages).toHaveLength(1);
  });
});

describe("normalizeAdapter — Responses", () => {
  it("maps instructions to system and input to messages", () => {
    const req = normalizeRequest({
      body: { model: "gpt-5-codex", instructions: "be exact", input: [{ role: "user", content: "hi" }] },
      pathname: "/v1/responses",
      arrivedAt: AT,
    });
    expect(req.protocol).toBe("responses");
    expect(req.system).toBe("be exact");
    expect(req.messages).toHaveLength(1);
  });

  it("wraps a bare string input", () => {
    const req = normalizeRequest({
      body: { model: "gpt-5-codex", input: "hello" },
      pathname: "/v1/responses",
      arrivedAt: AT,
    });
    expect(req.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("normalizeAdapter — client hints", () => {
  it("takes a session id from the first matching header, Headers or plain object", () => {
    const headers = new Headers({ "x-session-id": "sess-1", "user-agent": "claude-cli/1.0" });
    const fromHeaders = normalizeRequest({
      body: { model: "m", messages: [] },
      headers,
      arrivedAt: AT,
    });
    expect(fromHeaders.client_hint.session_header).toBe("sess-1");
    expect(fromHeaders.client_hint.user_agent).toBe("claude-cli/1.0");

    const fromObject = normalizeRequest({
      body: { model: "m", messages: [] },
      headers: { "X-Conversation-Id": "conv-9" },
      arrivedAt: AT,
    });
    expect(fromObject.client_hint.session_header).toBe("conv-9");
  });

  it("prefers x-dxr-session over a client's own session header", () => {
    const req = normalizeRequest({
      body: { model: "m", messages: [] },
      headers: { "x-session-id": "client-sdk-id", "x-dxr-session": "cc-explicit" },
      arrivedAt: AT,
    });
    expect(req.client_hint.session_header).toBe("cc-explicit");
  });

  it("takes the project root from a header, else the host-configured value", () => {
    const fromHeader = normalizeRequest({
      body: { model: "m", messages: [] },
      headers: { "x-dxr-project-root": "/repo/a" },
      projectRoot: "/repo/fallback",
      arrivedAt: AT,
    });
    expect(fromHeader.client_hint.project_root).toBe("/repo/a");

    const fromHost = normalizeRequest({
      body: { model: "m", messages: [] },
      headers: {},
      projectRoot: "/repo/fallback",
      arrivedAt: AT,
    });
    expect(fromHost.client_hint.project_root).toBe("/repo/fallback");

    const neither = normalizeRequest({ body: { model: "m", messages: [] }, arrivedAt: AT });
    expect(neither.client_hint.project_root).toBeUndefined();
  });

  it("carries no header bag into the port", () => {
    const req = normalizeRequest({
      body: { model: "m", messages: [] },
      headers: { authorization: "Bearer sk-secret-value" },
      arrivedAt: AT,
    });
    // The engine must never receive a credential; only three named hints cross.
    // M1 widened this from two by adding `project_root` (see the port's header
    // comment): the list is asserted exactly so a future header bag cannot arrive
    // by accident.
    expect(JSON.stringify(req)).not.toContain("sk-secret-value");
    expect(Object.keys(req.client_hint)).toEqual(["session_header", "user_agent", "project_root"]);
  });

  it("requires a parsed body", () => {
    expect(() => normalizeRequest({ body: null })).toThrow(NormalizeAdapterError);
  });
});

describe("executorAdapter — classification", () => {
  it("maps statuses into the closed taxonomy and nothing else", () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(429)).toBe("rate_limit");
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(402)).toBe("quota");
    expect(classifyStatus(408)).toBe("timeout");
    expect(classifyStatus(504)).toBe("timeout");
    expect(classifyStatus(422)).toBe("schema");
    expect(classifyStatus(500)).toBe("server");
    expect(classifyStatus(302)).toBe("unknown");
    for (const status of [200, 400, 401, 402, 403, 408, 418, 422, 429, 500, 503, 504]) {
      const cls = classifyStatus(status);
      if (cls !== null) expect(ERROR_CLASSES).toContain(cls);
    }
  });

  it("classifies thrown transport errors by shape", () => {
    expect(classifyThrown({ name: "AbortError" })).toBe("timeout");
    expect(classifyThrown(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("timeout");
    expect(classifyThrown(new Error("fetch failed"))).toBe("server");
    expect(classifyThrown(new Error("something odd"))).toBe("unknown");
  });

  it("reads Retry-After as seconds or as a date", () => {
    const seconds = new Headers({ "retry-after": "30" });
    expect(parseRetryAfter(seconds)).toBe(30);
    const asDate = new Headers({ "retry-after": new Date(AT + 60_000).toUTCString() });
    expect(parseRetryAfter(asDate, { now: AT })).toBe(60);
    expect(parseRetryAfter(new Headers({}))).toBeNull();
  });

  it("folds provider usage shapes into one, leaving unknown fields null", () => {
    expect(normalizeUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      // Never 0: an unmeasured cache read must not read as a confirmed miss.
      cache_read_tokens: null,
      cache_write_tokens: null,
    });
    expect(
      normalizeUsage({ usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } })
    ).toMatchObject({ input_tokens: 8, cache_read_tokens: 4, cache_write_tokens: 1 });
    expect(
      normalizeUsage({ usageMetadata: { promptTokenCount: 3 }, usage: { promptTokenCount: 3, candidatesTokenCount: 7 } })
    ).toMatchObject({ input_tokens: 3, output_tokens: 7 });
    expect(normalizeUsage({ usage: { prompt_tokens_details: { cached_tokens: 12 }, prompt_tokens: 20 } })).toMatchObject({
      cache_read_tokens: 12,
    });
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({ usage: {} })).toBeNull();
  });

  it("finds the reported model in each dialect", () => {
    expect(extractReportedModel({ model: "gpt-5" })).toBe("gpt-5");
    expect(extractReportedModel({ modelVersion: "gemini-3-pro-001" })).toBe("gemini-3-pro-001");
    expect(extractReportedModel({})).toBeNull();
  });
});

describe("executorAdapter — execution", () => {
  const req = { protocol: "openai", requested_model: "gpt-5" };
  const store = { list: () => [], get: async (id) => ({ id, accessToken: "sk-live" }) };

  function adapterWith(executeImpl, clock = fixedClock(AT)) {
    return createExecutorAdapter({
      credentialStore: store,
      resolveExecutor: () => ({ execute: executeImpl }),
      clock,
    });
  }

  it("passes the attached provider body through and reports usage", async () => {
    const seen = [];
    const adapter = adapterWith(async (args) => {
      seen.push(args);
      return {
        response: new Response(JSON.stringify({ model: "gpt-5-2026", usage: { prompt_tokens: 11, completion_tokens: 3 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      };
    });

    const request = attachHostRequest({ ...req }, { body: { model: "upstream-name", messages: [] }, stream: false });
    const result = await adapter.execute(createRoute({ provider: "openai", model: "gpt-5", connection_id: "c1" }), request);

    expect(seen[0].model).toBe("gpt-5");
    expect(seen[0].body).toEqual({ model: "upstream-name", messages: [] });
    expect(seen[0].credentials).toMatchObject({ id: "c1", accessToken: "sk-live" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error_class).toBeNull();
    expect(result.reported_model).toBe("gpt-5-2026");
    expect(result.usage).toMatchObject({ input_tokens: 11, output_tokens: 3 });
  });

  it("refuses to execute without an attached provider body", async () => {
    const adapter = adapterWith(async () => ({ response: new Response("{}") }));
    await expect(adapter.execute(createRoute({ provider: "openai", model: "m" }), { ...req })).rejects.toThrow(
      ExecutorAdapterError
    );
  });

  it("hands a stream back unread", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {}\n\n"));
        c.close();
      },
    });
    const adapter = adapterWith(async () => ({
      response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    }));
    const request = attachHostRequest({ ...req }, { body: {}, stream: true });
    const result = await adapter.execute(createRoute({ provider: "openai", model: "m" }), request);

    // Consuming it here would destroy the response the caller has to forward;
    // in-stream usage is M1 work, so it is honestly reported as unknown.
    expect(result.stream).not.toBeNull();
    expect(result.usage).toBeNull();
    expect(result.reported_model).toBeNull();
  });

  it("turns an error status into a classified result, not an exception", async () => {
    const adapter = adapterWith(async () => ({
      response: new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "17" },
      }),
    }));
    const request = attachHostRequest({ ...req }, { body: {}, stream: false });
    const result = await adapter.execute(createRoute({ provider: "openai", model: "m" }), request);

    expect(result.ok).toBe(false);
    expect(result.error_class).toBe("rate_limit");
    expect(result.retry_after_s).toBe(17);
    expect(result.error_message).toBe("slow down");
    expect(result.usage).toBeNull();
  });

  it("turns a thrown transport error into a result the engine can record", async () => {
    const adapter = adapterWith(async () => {
      throw new Error("fetch failed");
    });
    const request = attachHostRequest({ ...req }, { body: {}, stream: false });
    const result = await adapter.execute(createRoute({ provider: "openai", model: "m" }), request);

    expect(result.status).toBe(0);
    expect(result.error_class).toBe("server");
    expect(result.reported_model).toBeNull();
  });

  it("measures latency from the injected clock, never the wall clock", async () => {
    const clock = fixedClock(AT);
    const adapter = adapterWith(async () => {
      clock.advance(250);
      return { response: new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) };
    }, clock);
    const request = attachHostRequest({ ...req }, { body: {}, stream: false });
    const result = await adapter.execute(createRoute({ provider: "openai", model: "m" }), request);
    expect(result.latency_ms).toBe(250);
  });

  it("makes no selection decisions — one attempt per call", async () => {
    const calls = [];
    const adapter = adapterWith(async () => {
      calls.push(1);
      return { response: new Response("{}", { status: 500 }) };
    });
    const request = attachHostRequest({ ...req }, { body: {}, stream: false });
    await adapter.execute(createRoute({ provider: "openai", model: "m", connection_id: "c1" }), request);
    expect(calls).toHaveLength(1);
  });

  it("requires a CredentialStore at construction", () => {
    expect(() => createExecutorAdapter({})).toThrow(/CredentialStore/);
  });
});

describe("credentialAdapter", () => {
  const row = {
    id: "c1",
    provider: "anthropic",
    authType: "oauth",
    displayName: "work account",
    isActive: true,
    priority: 2,
    rateLimitedUntil: new Date(AT).toISOString(),
    accessToken: "sk-secret-access",
    refreshToken: "sk-secret-refresh",
    apiKey: "sk-secret-api",
    projectId: "proj-1",
  };

  it("strips every secret from the descriptor", () => {
    const d = toDescriptor(row);
    const json = JSON.stringify(d);
    for (const secret of ["sk-secret-access", "sk-secret-refresh", "sk-secret-api"]) {
      expect(json).not.toContain(secret);
    }
    expect(d).toMatchObject({ id: "c1", provider: "anthropic", auth_type: "oauth", label: "work account", priority: 2 });
    expect(d.rate_limited_until).toBe(AT);
  });

  it("normalises a rate-limit window to epoch ms, or to null when unparseable", () => {
    expect(toEpochMs(AT)).toBe(AT);
    expect(toEpochMs(new Date(AT).toISOString())).toBe(AT);
    // Not 0 — "limited until 1970" would silently read as "not limited".
    expect(toEpochMs("not a date")).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs("")).toBeNull();
  });

  it("keeps secrets on the get() path only", async () => {
    const store = createCredentialAdapter({
      connections: [toDescriptor(row)],
      getConnectionById: async () => row,
    });
    expect(JSON.stringify(store.list())).not.toContain("sk-secret-access");
    const creds = await store.get("c1");
    expect(creds.accessToken).toBe("sk-secret-access");
    expect(creds.projectId).toBe("proj-1");
  });

  it("returns null when no lookup was wired, rather than an empty credential", async () => {
    const store = createCredentialAdapter({ connections: [] });
    expect(await store.get("c1")).toBeNull();
  });

  it("loads a snapshot through the host repo function", async () => {
    const snapshot = await loadConnectionSnapshot(async () => [row, { ...row, id: "c2" }]);
    expect(snapshot.map((d) => d.id)).toEqual(["c1", "c2"]);
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
  });

  it("shapes credentials the way the executor expects", () => {
    const creds = toCredentials(row);
    expect(creds).toMatchObject({ id: "c1", provider: "anthropic", authType: "oauth", accessToken: "sk-secret-access" });
    expect(toCredentials(null)).toBeNull();
  });
});

describe("catalogAdapter", () => {
  // A resolver that mimics the real one: it always answers, defaulting to a floor.
  const FLOOR = { contextWindow: 200000, maxOutput: 64000, tools: true };
  const resolve = (provider, model) => {
    if (model === "known-big") return { contextWindow: 1_000_000, maxOutput: 128_000, tools: true };
    if (model === "no-tools") return { ...FLOOR, tools: false };
    return { ...FLOOR };
  };

  it("reports a defaulted capability as unknown, not as the default value", () => {
    const models = buildModelDescriptors({ providerModels: { p: ["unknown-model"] }, resolve });
    // The real resolver returns 200000 for anything it does not recognise. Passing
    // that on as fact is how a router overflows a context window it never measured.
    expect(models[0].context_window).toBeNull();
    expect(models[0].max_output).toBeNull();
    expect(models[0].supports_tools).toBeNull();
  });

  it("keeps a genuinely declared capability", () => {
    const models = buildModelDescriptors({ providerModels: { p: ["known-big", "no-tools"] }, resolve });
    const big = models.find((m) => m.model === "known-big");
    const noTools = models.find((m) => m.model === "no-tools");
    expect(big.context_window).toBe(1_000_000);
    expect(big.max_output).toBe(128_000);
    expect(noTools.supports_tools).toBe(false);
  });

  it("never claims cache semantics in M0", () => {
    const models = buildModelDescriptors({ providerModels: { p: ["known-big"] }, resolve });
    // Nothing in 9Router declares them, and inventing them is exactly what I4
    // forbids. Confirming them is M2 probe work.
    expect(models[0].supports_caching).toBeNull();
    expect(models[0].cache_ttl_s).toBeNull();
  });

  it("accepts both terse string entries and objects", () => {
    const models = buildModelDescriptors({ providerModels: { p: ["a", { id: "b" }, { name: "no id" }] }, resolve });
    expect(models.map((m) => m.model)).toEqual(["a", "b"]);
  });

  it("versions the catalog by content, so the same catalog hashes the same", () => {
    const a = buildModelDescriptors({ providerModels: { p: ["known-big"] }, resolve });
    const b = buildModelDescriptors({ providerModels: { p: ["known-big"] }, resolve });
    expect(catalogVersionOf(a)).toBe(catalogVersionOf(b));
    const c = buildModelDescriptors({ providerModels: { p: ["known-big", "no-tools"] }, resolve });
    expect(catalogVersionOf(c)).not.toBe(catalogVersionOf(a));
  });

  it("builds from the real registry and reports a stable version", () => {
    const catalog = createCatalogAdapter();
    const models = catalog.models();
    expect(models.length).toBeGreaterThan(0);
    expect(catalog.version()).toMatch(/^reg-1:\d+:[0-9a-f]{16}$/);
    expect(catalog.version()).toBe(catalog.version());
    for (const m of models.slice(0, 50)) {
      expect(typeof m.provider).toBe("string");
      expect(typeof m.model).toBe("string");
      expect(m.supports_caching).toBeNull();
    }
  });
});

describe("clockAdapter", () => {
  it("returns real epoch ms", () => {
    expect(createClockAdapter().now()).toBeGreaterThan(1_600_000_000_000);
  });

  it("offsets deterministically", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(AT);
    try {
      expect(createOffsetClock(1000).now()).toBe(AT + 1000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("legacySelectionAdapter", () => {
  it("classifies the walk's failures into the engine's taxonomy", () => {
    expect(classifyLegacyFailure({ status: 429 })).toBe("rate_limit");
    expect(classifyLegacyFailure({ status: 401 })).toBe("auth");
    expect(classifyLegacyFailure({ status: 503 })).toBe("server");
    expect(classifyLegacyFailure({ message: "quota exceeded" })).toBe("quota");
    expect(classifyLegacyFailure({ message: "who knows" })).toBe("unknown");
  });

  it("records the walk without being able to change it", () => {
    const clock = fixedClock(AT);
    const recorder = createLegacySelectionRecorder({ clock });
    const excluded = new Set();

    recorder.step({ outcome: "failed", provider: "anthropic", model: "opus", connectionId: "c1", excluded: [...excluded], status: 429 });
    excluded.add("c1");
    clock.advance(10);
    recorder.step({ outcome: "selected", provider: "anthropic", model: "opus", connectionId: "c2", excluded: [...excluded] });

    const steps = recorder.steps();
    expect(steps).toHaveLength(2);
    expect(steps[0].error_class).toBe("rate_limit");
    expect(steps[0].at).toBe(AT);
    expect(steps[1].at).toBe(AT + 10);
    expect(recorder.chosen().connection_id).toBe("c2");
    expect(recorder.burned()).toEqual(["c1"]);
  });

  it("snapshots the exclusion set, which the walk mutates as it goes", () => {
    const excluded = new Set(["c1"]);
    const step = describeLegacyStep({
      outcome: "failed",
      provider: "p",
      model: "m",
      connectionId: "c1",
      excluded: [...excluded],
      at: AT,
    });
    excluded.add("c2");
    expect(step.excluded).toEqual(["c1"]);
    expect(Object.isFrozen(step)).toBe(true);
  });

  it("reports no choice when the walk never got an account", () => {
    const recorder = createLegacySelectionRecorder({ clock: fixedClock(AT) });
    recorder.step({ outcome: "no_credentials", provider: "p", model: "m" });
    expect(recorder.chosen()).toBeNull();
  });

  it("refuses an outcome that is not in the enumerated set", () => {
    expect(() => describeLegacyStep({ outcome: "maybe", provider: "p", model: "m", at: AT })).toThrow(/unknown legacy outcome/);
  });
});
