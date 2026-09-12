/**
 * §14 group J — M2 added an observation channel and nothing else.
 *
 * M2's boundary is stated twice in the brief: "M2 is NOT authoritative routing. Legacy
 * 9Router routing remains authoritative", and "a failure in M2 observation must never
 * break a user request". Both are claims about behaviour, so this file proves them by
 * routing the same request through the REAL `handleChat` twice — once with cache
 * observation on, once with `DXR_CACHE_TRACKING=off` — and comparing everything the
 * router computed.
 *
 * Unlike M1, M2 does add one argument to the call: `onProviderResult`, the side channel
 * `saveUsageStats` invokes when the upstream usage is known. The claim is therefore not
 * "byte-identical arguments" but the sharper one this file actually asserts: **that field
 * is the only difference**, computed by diffing the two argument sets key by key rather
 * than by inspecting the diff by hand.
 *
 * The fail-open half is behavioural too: the observation is made to fail in three
 * different ways (a rejected M1 observation, a garbage result, a closed database) while
 * the client's response is asserted to arrive unchanged each time.
 *
 * The structural half reads the shipped source, because a mocked test cannot see an
 * import added to a file it stubbed out. The invariant M2 must not break is that the
 * belief is *write-only* on the request path: `cache_entries` rows are produced by a
 * response-side observer and read by nothing that could route on them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");

const mocks = vi.hoisted(() => ({
  handleChatCore: vi.fn(),
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  isValidApiKey: vi.fn(),
  extractApiKey: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  getProjectIdForConnection: vi.fn(),
  handleAntigravityQuotaError: vi.fn(),
  getPxpipeTransform: vi.fn(),
  appendPxpipeEvent: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  isValidApiKey: mocks.isValidApiKey,
  extractApiKey: mocks.extractApiKey,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.handleAntigravityQuotaError,
}));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
}));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: mocks.getPxpipeTransform }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: mocks.appendPxpipeEvent }));

const ACCOUNTS = [
  { connectionId: "conn-a", connectionName: "acct-a", accessToken: "tok-a", providerSpecificData: {} },
  { connectionId: "conn-b", connectionName: "acct-b", accessToken: "tok-b", providerSpecificData: {} },
];

const SETTINGS = Object.freeze({
  requireApiKey: false,
  ccFilterNaming: false,
  rtkEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  pxpipeEnabled: false,
  comboStrategy: "fallback",
  providerThinking: {},
});

/**
 * Deliberately large. `openai` documents `min_cacheable_tokens: 1024`, so a toy body is
 * correctly below the provider's own minimum and produces no belief at all — which would
 * make the `cache_entries` assertions below vacuous. Padding the prefix past the
 * documented minimum is what lets this file assert what M2 actually wrote.
 */
const PAD = " Follow the repository conventions and keep the diff minimal.".repeat(90);

const BODY = Object.freeze({
  model: "openai/gpt-x",
  stream: false,
  tools: [{ type: "function", function: { name: "read_file", description: `Read a file.${PAD}` } }],
  messages: [
    { role: "system", content: `You are a coding agent.${PAD}` },
    { role: "user", content: `PLEASE-DO-NOT-PERSIST-ME list the files.${PAD}` },
  ],
});

/** What an OpenAI-shaped provider reports when it served part of the prefix from cache. */
const USAGE = Object.freeze({
  prompt_tokens: 5000,
  completion_tokens: 12,
  prompt_tokens_details: { cached_tokens: 3000 },
});

const savedEnv = {};
let tmpDir;
let handleChat;
let sessions;
let cache;
let continuityDb;

function stashEnv(name, value) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeRequest(sessionKey = "m2-regression-session") {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
      "User-Agent": "claude-cli/1.0.0",
      "X-DXR-Session": sessionKey,
    },
    body: JSON.stringify(BODY),
  });
}

function comparableCall(args) {
  return JSON.parse(JSON.stringify(args, (key, value) => (typeof value === "function" ? `[fn ${key}]` : value)));
}

/**
 * Two accounts: the first fails with 429, the second succeeds — and, on the successful
 * attempt, invokes the `onProviderResult` callback the way `saveUsageStats` does.
 */
function primeRouting(response, { usage = USAGE, extraResults = [] } = {}) {
  const tried = [];
  mocks.getSettings.mockResolvedValue({ ...SETTINGS });
  mocks.extractApiKey.mockReturnValue("router-client-key");
  mocks.isValidApiKey.mockResolvedValue(true);
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-x" });
  mocks.getProviderCredentials.mockImplementation(async (provider, exclude) => {
    const next = ACCOUNTS.find((a) => !exclude.has(a.connectionId));
    if (!next) return null;
    tried.push(next.connectionId);
    return next;
  });
  mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  mocks.clearAccountError.mockResolvedValue(undefined);
  mocks.handleChatCore
    .mockImplementationOnce(async () => ({ success: false, status: 429, error: "rate limited" }))
    .mockImplementationOnce(async (args) => {
      // Exactly what `open-sse/handlers/chatCore/requestDetail.js#saveUsageStats` does
      // with the callback: hand it the provider's usage and ignore what comes back.
      for (const bad of extraResults) args.onProviderResult?.(bad);
      args.onProviderResult?.({ provider: "openai", model: "gpt-x", usage, connectionId: "conn-b" });
      return { success: true, response };
    });
  return tried;
}

/** Poll for the fire-and-forget write; observation is deliberately off the hot path. */
async function waitForRows(table, expected, timeoutMs = 4000) {
  const store = await continuityDb.getContinuityStore();
  const started = Date.now();
  for (;;) {
    const n = store.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
    if (n >= expected || Date.now() - started > timeoutMs) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const countRows = async (table) => (await continuityDb.getContinuityStore()).db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-m2-regress-"));
  stashEnv("DXR_DATA_DIR", tmpDir);
  stashEnv("DXR_MASTER_KEY", "ab".repeat(32));
  stashEnv("DXR_SESSIONS", undefined);
  stashEnv("DXR_CACHE_TRACKING", undefined);
  stashEnv("DXR_ENGINE", undefined);
  stashEnv("DXR_PROJECT_ROOT", "/repo/m2-regression");

  global._dxrFlags = null;
  global._dxrContinuityDb = null;
  vi.resetModules();

  ({ handleChat } = await import("@/sse/handlers/chat.js"));
  sessions = await import("@/lib/dxr/sessions.js");
  cache = await import("@/lib/dxr/cache.js");
  continuityDb = await import("../../adapters/ninerouter/continuityDb.js");
  // Generous: this pulls the real `handleChat` and its whole inherited import graph in,
  // which is slower than vitest's 10s default hook budget on a cold cache.
}, 60_000);

afterAll(async () => {
  try {
    const store = global._dxrContinuityDb?.store;
    if (store) store.db.close();
  } catch {}
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global._dxrFlags = null;
  global._dxrContinuityDb = null;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  vi.clearAllMocks();
  sessions.__resetSessionObservation();
  cache.__resetCacheObservation();
});

describe("J1 — the routing walk is the same with cache observation on and off", () => {
  it("differs from the off-run in exactly one argument: the observation callback", async () => {
    delete process.env.DXR_CACHE_TRACKING;
    global._dxrFlags = null;
    expect(cache.cacheTrackingEnabled()).toBe(true);

    const onResponse = new Response("on", { status: 200 });
    const onTried = primeRouting(onResponse);
    const onResult = await handleChat(makeRequest());
    const onCalls = mocks.handleChatCore.mock.calls.map(([a]) => comparableCall(a));
    const onFallback = mocks.markAccountUnavailable.mock.calls.map((c) => c.slice(0, 4));
    expect(await waitForRows("turn_results", 1)).toBe(1);

    vi.clearAllMocks();
    sessions.__resetSessionObservation();
    cache.__resetCacheObservation();
    process.env.DXR_CACHE_TRACKING = "off";
    global._dxrFlags = null;
    expect(cache.cacheTrackingEnabled()).toBe(false);

    const offResponse = new Response("off", { status: 200 });
    const offTried = primeRouting(offResponse);
    const offResult = await handleChat(makeRequest());
    const offCalls = mocks.handleChatCore.mock.calls.map(([a]) => comparableCall(a));
    const offFallback = mocks.markAccountUnavailable.mock.calls.map((c) => c.slice(0, 4));

    expect(onCalls).toHaveLength(2);
    expect(offCalls).toHaveLength(2);
    // The whole claim, computed rather than eyeballed: every key whose value differs
    // between the two runs. A second entry here would mean M2 had reached into routing.
    const differing = new Set();
    for (const [i, on] of onCalls.entries()) {
      for (const key of new Set([...Object.keys(on), ...Object.keys(offCalls[i])])) {
        if (JSON.stringify(on[key]) !== JSON.stringify(offCalls[i][key])) differing.add(key);
      }
    }
    expect([...differing]).toEqual(["onProviderResult"]);
    expect(onCalls[1].onProviderResult).toBe("[fn onProviderResult]");
    // Off is `null`, the exact value every inherited call site saw before M2, so the
    // branch taken in `saveUsageStats` is the pre-M2 branch.
    expect(offCalls[1].onProviderResult).toBe(null);

    // Same accounts, same order, same fallback, same Response object.
    expect(onTried).toEqual(["conn-a", "conn-b"]);
    expect(offTried).toEqual(onTried);
    expect(onFallback).toEqual([["conn-a", 429, "rate limited", "openai"]]);
    expect(offFallback).toEqual(onFallback);
    expect(onResult).toBe(onResponse);
    expect(offResult).toBe(offResponse);
    expect(await offResult.text()).toBe("off");
  });

  it("recorded the provider's report in the on-run and nothing in the off-run", async () => {
    const store = await continuityDb.getContinuityStore();
    const before = store.db.get("SELECT COUNT(*) AS n FROM turn_results").n;
    expect(before).toBe(1); // written by the previous test, so the comparison was not vacuous

    const row = store.db.get("SELECT * FROM turn_results ORDER BY at DESC LIMIT 1");
    expect(row).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      status: "ok",
      usage_in: 5000,
      usage_out: 12,
      usage_cache_read: 3000,
      // M1's `TOKEN_PROVENANCE` vocabulary, reused rather than duplicated: the provider
      // sent counts, so they are `measured`. `estimated` is not a legal value here.
      usage_provenance: "measured",
      cache_confidence: "confirmed",
      // The forward link to M3's `attempts` row, unused in M2.
      attempt_id: null,
    });
    // `openai` is one of the ten §9.2 keys, so the alias resolved to a real record.
    expect(row.pricing_key).toBe("openai");
    expect(row.mechanism).toBe("implicit");
    expect(JSON.stringify(row)).not.toContain("PLEASE-DO-NOT-PERSIST-ME");

    // The provider reported a 3000-token read over a prefix longer than that, so the
    // belief splits: the layers inside the reported region are `confirmed` on provider
    // evidence — the only route to that value (I3) — and the layer past the boundary is
    // `assumed`, never confirmed by association with its neighbours.
    const entries = store.db.all("SELECT * FROM cache_entries") || [];
    expect(entries.length).toBeGreaterThan(1);
    const confirmed = entries.filter((e) => e.confidence === "confirmed");
    expect(confirmed.length).toBeGreaterThan(0);
    expect(confirmed.length).toBeLessThan(entries.length);
    for (const e of entries) {
      expect(e.prefix_hash).toMatch(/^c1:[0-9a-f]{64}$/);
      // Estimated, and labelled so: M1 ships no tokenizer, and the count that decided
      // this layer was eligible is not a measurement.
      expect(e.tokens_provenance).toBe("estimated");
      expect(e.ttl_s).toBe(300);
      if (e.confidence === "confirmed") expect(e.evidence).toBe("provider_reported_read");
      else expect([e.confidence, e.evidence]).toEqual(["assumed", "assumed_write"]);
    }

    // Off-run: routing still works and the tables stay exactly as they were.
    process.env.DXR_CACHE_TRACKING = "off";
    global._dxrFlags = null;
    const entriesBefore = entries.length;
    const tried = primeRouting(new Response("off2", { status: 200 }));
    await handleChat(makeRequest("m2-off-session"));
    await new Promise((r) => setTimeout(r, 200));
    expect(tried).toEqual(["conn-a", "conn-b"]);
    expect(await countRows("turn_results")).toBe(before);
    expect(await countRows("cache_entries")).toBe(entriesBefore);
    // And M1 still observed: the M2 rollback rolls back M2 only.
    expect(await countRows("turns")).toBeGreaterThan(1);
  });

  it("records an attempt that reported no usage without inventing zeros for it", async () => {
    delete process.env.DXR_CACHE_TRACKING;
    global._dxrFlags = null;
    const before = await countRows("turn_results");

    // Both attempts fail: `accountFallback` exhausts the accounts and the client gets the
    // router's own error, exactly as before M2.
    mocks.getSettings.mockResolvedValue({ ...SETTINGS });
    mocks.extractApiKey.mockReturnValue("router-client-key");
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-x" });
    const tried = [];
    mocks.getProviderCredentials.mockImplementation(async (provider, exclude) => {
      const next = ACCOUNTS.find((a) => !exclude.has(a.connectionId));
      if (!next) return null;
      tried.push(next.connectionId);
      return next;
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore.mockImplementation(async (args) => {
      args.onProviderResult?.({ provider: "openai", model: "gpt-x", usage: null, connectionId: "conn-x" });
      return { success: false, status: 500, error: "upstream exploded" };
    });

    const res = await handleChat(makeRequest("m2-failure-session"));
    expect(tried).toEqual(["conn-a", "conn-b"]);
    expect(res.status).toBe(500);
    expect(await waitForRows("turn_results", before + 2)).toBe(before + 2);

    // Scoped to the turn these attempts belong to: `seq` restarts per turn, so a global
    // ordering would mix in rows from the tests above.
    const db = (await continuityDb.getContinuityStore()).db;
    const last = db.get("SELECT session_id, turn_idx FROM turn_results ORDER BY at DESC, seq DESC LIMIT 1");
    const rows = db.all("SELECT * FROM turn_results WHERE session_id = ? AND turn_idx = ? ORDER BY seq", [
      last.session_id,
      last.turn_idx,
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // No usage at all: `unavailable`, never a zero.
      expect(row.usage_provenance).toBe("unavailable");
      expect(row.usage_in).toBe(null);
      expect(row.usage_cache_read).toBe(null);
      // Silence from a provider with a verified cache mechanism is `assumed` — the bytes
      // went out, so a window plausibly exists — and never `confirmed`, which only a
      // provider report can buy (I3).
      expect(row.cache_confidence).toBe("assumed");
    }
    // Two results against one turn, numbered — the shape §12.1 gives attempts.
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
  });
});

describe("J2 — a broken observation is a missing row, never a failed request", () => {
  beforeEach(() => {
    delete process.env.DXR_CACHE_TRACKING;
    global._dxrFlags = null;
  });

  it("returns the provider's response even when every observation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await countRows("turn_results");

    const response = new Response("survived", { status: 200 });
    // Three ways for the side channel to fail, all on the same successful attempt: a
    // result that is not an object, one whose provider is nonsense, and one whose usage
    // is a hostile shape.
    const tried = primeRouting(response, { extraResults: [null, "not-an-object", { provider: {}, usage: () => {} }] });
    const result = await handleChat(makeRequest("m2-failopen-session"));

    expect(tried).toEqual(["conn-a", "conn-b"]);
    expect(result).toBe(response);
    expect(await result.text()).toBe("survived");

    // Two rows, not four: the two non-objects were dropped outright, because a
    // `turn_results` row built out of `null` would assert that an attempt happened and
    // reported nothing — a measurement nobody took. The third *is* an object arriving
    // from the response path, so it is recorded as what it is: an attempt whose provider
    // and counts could not be read.
    expect(await waitForRows("turn_results", before + 2)).toBe(before + 2);
    const store = await continuityDb.getContinuityStore();
    const junk = store.db.get("SELECT * FROM turn_results WHERE provider IS NULL ORDER BY at DESC LIMIT 1");
    expect(junk).toMatchObject({
      provider: null,
      model: null,
      usage_in: null,
      usage_cache_read: null,
      usage_provenance: "unavailable",
      // No pricing key means the `default` record (`mechanism: none`), so the row claims
      // no cache economics at all (I4) rather than borrowing a neighbour's ratios.
      cache_confidence: "unknown",
      mechanism: "none",
    });
    warn.mockRestore();
  });

  it("hands back no callback at all when tracking is off", () => {
    process.env.DXR_CACHE_TRACKING = "off";
    global._dxrFlags = null;
    expect(cache.makeProviderResultObserver({})).toBe(null);
    delete process.env.DXR_CACHE_TRACKING;
    global._dxrFlags = null;
    // And never a callback without something to correlate it to.
    expect(cache.makeProviderResultObserver(null)).toBe(null);
    expect(cache.makeProviderResultObserver("a string")).toBe(null);
    expect(typeof cache.makeProviderResultObserver({})).toBe("function");
  });

  it("swallows a rejected M1 observation instead of raising it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = {};
    cache.rememberTurn(key, Promise.reject(new Error("m1 observation blew up")));
    // `recallTurn` resolves to null rather than rethrowing, so the observer no-ops. An
    // unhandled rejection here would take the process down in production.
    expect(await cache.recallTurn(key)).toBe(null);
    const observer = cache.makeProviderResultObserver(key);
    expect(observer({ provider: "openai", usage: USAGE })).toBe(undefined);
    await new Promise((r) => setTimeout(r, 50));
    warn.mockRestore();
  });

  it("returns synchronously — the callback cannot be awaited into the response path", () => {
    const key = {};
    cache.rememberTurn(key, Promise.resolve({ observed: false, reason: "no_observed_turn" }));
    const observer = cache.makeProviderResultObserver(key);
    // No promise comes back, so no caller can accidentally block a completion on a
    // SQLite write. §12: observation is never on the critical path.
    expect(observer({ provider: "openai", usage: USAGE })).toBe(undefined);
  });

  it("ignores a request it was never told about", async () => {
    expect(await cache.recallTurn({})).toBe(null);
    expect(await cache.recallTurn(null)).toBe(null);
    const before = await countRows("turn_results");
    cache.makeProviderResultObserver({})({ provider: "openai", usage: USAGE });
    await new Promise((r) => setTimeout(r, 100));
    // A response with no observed turn writes nothing: continuity state is never
    // manufactured from a response.
    expect(await countRows("turn_results")).toBe(before);
  });
});

/**
 * The structural half. What M2 must not have created is a *reader*: the belief may be
 * written on the response path and consulted by the CLI, and by nothing that could turn it
 * into a route.
 */
describe("J3 — the belief is write-only on the request path", () => {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(m?js|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const rel = (f) => path.relative(REPO, f).split(path.sep).join("/");
  const sources = (dir) => walk(path.join(REPO, dir)).map((f) => [rel(f), fs.readFileSync(f, "utf8")]);

  it("open-sse/ still knows nothing about continuity, cache pricing or the engine", () => {
    const offenders = [];
    for (const [file, src] of sources("open-sse")) {
      if (/continuity\/|lib\/dxr\/|adapters\/ninerouter|cacheEntry|CacheLedger/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("carries the observation as a plain callback parameter, not as an import", () => {
    const detail = fs.readFileSync(path.join(REPO, "open-sse/handlers/chatCore/requestDetail.js"), "utf8");
    // The engine reaches `saveUsageStats` as a function argument and by no other route:
    // that is what keeps `open-sse` ignorant of what the callback does.
    expect(detail).toMatch(/onProviderResult\s*=\s*null/);
    expect(detail).not.toMatch(/import[^;]*(continuity|dxr|ninerouter)/);
    // Invoked inside a try/catch, so a throwing observer cannot fail a completion.
    expect(detail).toMatch(/try\s*\{\s*\n\s*onProviderResult\(/);
    // Above the early returns: a zero-token or failed attempt is still observed, which is
    // the evidence a later milestone needs most.
    expect(detail.indexOf("onProviderResult(")).toBeLessThan(detail.indexOf("if (!tokens || typeof tokens"));
  });

  it("reads no cache belief anywhere in the request path", () => {
    // The functions that turn stored entries into a claim about warmth. If one of these
    // appeared under src/ or open-sse/, M2 would have grown an input to routing.
    const readers = /describeBelief|createCacheLedger|listCacheEntriesForRoute|listCacheEntriesForHashes|entryState|planCacheWrites/;
    const offenders = [];
    for (const dir of ["src", "open-sse"]) {
      for (const [file, src] of sources(dir)) if (readers.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the whole app-side surface inside src/lib/dxr/", () => {
    const importers = [];
    for (const [file, src] of sources("src")) {
      if (/from\s+["'][^"']*(continuity\/|adapters\/ninerouter)/.test(src)) importers.push(file);
    }
    expect(importers.every((f) => f.startsWith("src/lib/dxr/"))).toBe(true);
    expect(importers).toContain("src/lib/dxr/cache.js");
  });

  it("touches the request handler once, for a callback whose value is discarded", () => {
    const src = fs.readFileSync(path.join(REPO, "src/sse/handlers/chat.js"), "utf8");
    const calls = src.match(/makeProviderResultObserver\s*\(/g) || [];
    expect(calls).toHaveLength(1);
    // Passed straight into the engine's options; never stored, awaited or branched on.
    expect(src).toMatch(/onProviderResult:\s*makeProviderResultObserver\(request\)/);
    expect(src).not.toMatch(/await\s+makeProviderResultObserver/);
    expect(src).not.toMatch(/if\s*\(\s*makeProviderResultObserver/);
    // No cache concept reaches the handler that chooses accounts.
    expect(src).not.toMatch(/observeProviderResult|cache_entries|describeBelief|getPricingRegistry/);
  });

  it("still has no decide() to call, and no shadow of one", () => {
    const callers = [];
    for (const dir of ["src", "open-sse", "adapters"]) {
      for (const [file, raw] of sources(dir)) {
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/\bdecide\s*\(/.test(src)) callers.push(file);
      }
    }
    expect(callers).toEqual([]);
    const engineExports = [];
    for (const [file, src] of sources("continuity")) {
      if (/export\s+(async\s+)?function\s+decide\b/.test(src)) engineExports.push(file);
    }
    expect(engineExports).toEqual([]);
  });

  it("leaves accountFallback and the executor dispatch untouched", () => {
    const fallback = fs.readFileSync(path.join(REPO, "open-sse/services/accountFallback.js"), "utf8");
    expect(fallback).not.toMatch(/cache_read|prefix_hash|continuity|pricing/i);
    const core = fs.readFileSync(path.join(REPO, "open-sse/handlers/chatCore.js"), "utf8");
    expect(core).not.toMatch(/continuity\/|lib\/dxr/);
    // The one M2 mention in the engine is the parameter it forwards, and it is forwarded
    // rather than interpreted.
    expect(core).toMatch(/onProviderResult/);
    expect(core).not.toMatch(/onProviderResult\s*\(/);
  });
});

describe("J4 — the M2 flag is a rollback, and the engine is still off", () => {
  it("defaults observation on and the engine off, with no capability granted", async () => {
    const { resolveFlags, isEngineDisabled, describeFlags, unimplementedRequests } = await import(
      "../../continuity/flags.js"
    );
    const flags = resolveFlags({});
    expect(flags.cacheTracking).toBe(true);
    expect(flags.engine).toBe("off");
    expect(flags.engineAuthority).toBe(false);
    expect(isEngineDisabled(flags)).toBe(true);

    // Asking for cache economics does not grant them in M2, even with the engine and its
    // authority forced on: the gate is `implemented: false`, so it resolves false and the
    // request is *reported* rather than silently read as "on".
    const asked = resolveFlags({ DXR_CACHE_ECONOMICS: "1", DXR_ENGINE: "on", DXR_ENGINE_AUTHORITY: "1" });
    expect(asked.cacheEconomics).toBe(false);
    expect(asked.compatProbes).toBe(false);
    expect(unimplementedRequests({ DXR_CACHE_ECONOMICS: "1" }).map((r) => r.flag)).toEqual(["cacheEconomics"]);
    // And nothing an operator sets for M2 observation can turn the engine on.
    expect(isEngineDisabled(resolveFlags({ DXR_CACHE_TRACKING: "1", DXR_SESSIONS: "1" }))).toBe(true);
    expect(describeFlags(resolveFlags({ DXR_CACHE_TRACKING: "off" }))).toMatch(/cacheTracking=off/);
  });
});
