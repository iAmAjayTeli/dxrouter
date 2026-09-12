/**
 * §14 group I — M1 changed the observation surface and nothing else.
 *
 * M1 is an observation milestone (§12): the continuity engine may watch traffic and
 * persist what it sees, but "THE CONTINUITY ENGINE MUST NOT CONTROL ROUTING. Legacy
 * 9Router remains authoritative." That is a claim about behaviour, so this file
 * proves it behaviourally rather than by reading the diff:
 *
 *   the same request is routed twice through the REAL `handleChat` — once with
 *   observation on, once with `DXR_SESSIONS=off` — and every argument handed to
 *   `handleChatCore`, every account tried, every fallback taken and the response
 *   object itself must be identical.
 *
 * The comparison would be vacuous if observation never ran, so the on-run also has
 * to leave a session row behind, and the off-run must leave none. Both halves are
 * asserted.
 *
 * The static half of the claim (nothing under `open-sse/` learned about continuity,
 * no `decide()` anywhere on the live path, the one call site is a dead end) is
 * checked by reading the shipped source, because an import that cannot be seen in a
 * mocked test is exactly the kind of coupling that would break this invariant later.
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

const BODY = Object.freeze({
  model: "openai/gpt-x",
  stream: false,
  tools: [{ type: "function", function: { name: "read_file" } }],
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "list the files" },
  ],
});

const savedEnv = {};
let tmpDir;
let handleChat;
let sessions;
let continuityDb;

function stashEnv(name, value) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeRequest() {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
      "User-Agent": "claude-cli/1.0.0",
      "X-DXR-Session": "regression-session",
    },
    body: JSON.stringify(BODY),
  });
}

/** Functions are not comparable; what matters is the data the router computed. */
function comparableCall(args) {
  return JSON.parse(
    JSON.stringify(args, (key, value) => (typeof value === "function" ? `[fn ${key}]` : value)),
  );
}

/** Two accounts: the first fails with 429, the second succeeds. */
function primeRouting(response) {
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
    .mockResolvedValueOnce({ success: false, status: 429, error: "rate limited" })
    .mockResolvedValueOnce({ success: true, response });
  return tried;
}

/** Poll for the fire-and-forget write; observation is deliberately off the hot path. */
async function waitForSessions(expected, timeoutMs = 4000) {
  const store = await continuityDb.getContinuityStore();
  const started = Date.now();
  for (;;) {
    const n = store.db.get("SELECT COUNT(*) AS n FROM sessions").n;
    if (n >= expected || Date.now() - started > timeoutMs) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-m1-regress-"));
  stashEnv("DXR_DATA_DIR", tmpDir);
  stashEnv("DXR_MASTER_KEY", "ab".repeat(32));
  stashEnv("DXR_SESSIONS", undefined);
  stashEnv("DXR_ENGINE", undefined);
  stashEnv("DXR_PROJECT_ROOT", "/repo/regression");

  global._dxrFlags = null;
  global._dxrContinuityDb = null;
  vi.resetModules();

  ({ handleChat } = await import("@/sse/handlers/chat.js"));
  sessions = await import("@/lib/dxr/sessions.js");
  continuityDb = await import("../../adapters/ninerouter/continuityDb.js");
  // Generous: importing the real `handleChat` pulls the whole inherited graph in, which
  // exceeds vitest's 10s default hook budget when this file shares workers with the M2
  // protocol suite doing the same thing.
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
});

describe("I1 — routing is byte-identical with observation on and off", () => {
  it("hands handleChatCore the same arguments, tries the same accounts, returns the same response", async () => {
    // --- observation ON (the M1 default)
    delete process.env.DXR_SESSIONS;
    global._dxrFlags = null;
    expect(sessions.sessionsEnabled()).toBe(true);

    const onResponse = new Response("on", { status: 200 });
    const onTried = primeRouting(onResponse);
    const onResult = await handleChat(makeRequest());
    const onCalls = mocks.handleChatCore.mock.calls.map(([a]) => comparableCall(a));
    const onFallback = mocks.markAccountUnavailable.mock.calls.map((c) => c.slice(0, 4));
    expect(await waitForSessions(1)).toBe(1);

    // --- observation OFF (the §20 M1 rollback)
    vi.clearAllMocks();
    sessions.__resetSessionObservation();
    process.env.DXR_SESSIONS = "off";
    global._dxrFlags = null;
    expect(sessions.sessionsEnabled()).toBe(false);

    const offResponse = new Response("off", { status: 200 });
    const offTried = primeRouting(offResponse);
    const offResult = await handleChat(makeRequest());
    const offCalls = mocks.handleChatCore.mock.calls.map(([a]) => comparableCall(a));
    const offFallback = mocks.markAccountUnavailable.mock.calls.map((c) => c.slice(0, 4));

    // The routing walk itself: two attempts, one fallback, same order both times.
    expect(onCalls).toHaveLength(2);
    expect(offCalls).toEqual(onCalls);
    expect(onTried).toEqual(["conn-a", "conn-b"]);
    expect(offTried).toEqual(onTried);
    expect(onFallback).toEqual([["conn-a", 429, "rate limited", "openai"]]);
    expect(offFallback).toEqual(onFallback);

    // The protocol: the provider's own Response object is returned untouched.
    expect(onResult).toBe(onResponse);
    expect(offResult).toBe(offResponse);
    expect(await onResult.text()).toBe("on");
  });

  it("observed the turn in the on-run and wrote nothing in the off-run", async () => {
    const store = await continuityDb.getContinuityStore();
    const before = store.db.get("SELECT COUNT(*) AS n FROM sessions").n;
    expect(before).toBe(1); // written by the previous test, so the comparison was not vacuous

    // The recorded turn is a real observation: explicit identity from the header,
    // hashes for all three layers, and no request body anywhere.
    const turn = store.db.get("SELECT * FROM turns ORDER BY at DESC LIMIT 1");
    expect(turn.identity_confidence).toBe("explicit");
    expect(turn.identity_source).toBe("header");
    expect(turn.tools_hash).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(turn.system_hash).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(turn.messages_hash).toMatch(/^c1:[0-9a-f]{64}$/);
    expect(JSON.stringify(turn)).not.toContain("list the files");

    // Off-run: routing still works, and the store stays exactly as it was.
    process.env.DXR_SESSIONS = "off";
    global._dxrFlags = null;
    const tried = primeRouting(new Response("off2", { status: 200 }));
    await handleChat(makeRequest());
    await new Promise((r) => setTimeout(r, 150));
    expect(tried).toEqual(["conn-a", "conn-b"]);
    expect(store.db.get("SELECT COUNT(*) AS n FROM sessions").n).toBe(before);
    expect(store.db.get("SELECT COUNT(*) AS n FROM turns").n).toBe(1);
  });

  it("returns the client's own error responses unchanged when the router refuses", async () => {
    delete process.env.DXR_SESSIONS;
    global._dxrFlags = null;
    mocks.getSettings.mockResolvedValue({ ...SETTINGS });
    mocks.extractApiKey.mockReturnValue("router-client-key");
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-x" });
    mocks.getProviderCredentials.mockResolvedValue(null);

    const res = await handleChat(makeRequest());
    expect(res.status).toBe(404);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    const payload = await res.json();
    expect(JSON.stringify(payload)).toContain("No active credentials");
    // Nothing continuity-shaped leaked into the client-visible error.
    expect(JSON.stringify(payload)).not.toMatch(/session|continuity|prefix/i);
  });

  it("a missing model is still rejected before any provider work", async () => {
    mocks.getSettings.mockResolvedValue({ ...SETTINGS });
    mocks.extractApiKey.mockReturnValue("k");
    const res = await handleChat(
      new Request("https://router.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});

/**
 * The structural half. A mocked test cannot see an import that was added to a file it
 * stubbed out, so these read the shipped source: the coupling M1 must not create is
 * "the routing engine knows about continuity", and that is visible in the text.
 */
describe("I2 — the routing engine did not learn about continuity", () => {
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

  it("open-sse/ contains no reference to continuity, sessions glue or the engine", () => {
    const offenders = [];
    for (const file of walk(path.join(REPO, "open-sse"))) {
      const src = fs.readFileSync(file, "utf8");
      if (/continuity\/|lib\/dxr\/|adapters\/ninerouter/.test(src)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it("only the one app-side glue module reaches into continuity", () => {
    const importers = [];
    for (const file of walk(path.join(REPO, "src"))) {
      const src = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*(continuity\/|adapters\/ninerouter)/.test(src)) importers.push(rel(file));
    }
    // src/lib/dxr/* is the whole surface: flags, the sessions side channel, and the
    // engine placeholder M0 left behind. Nothing in the request path but chat.js,
    // which imports the glue rather than the engine.
    expect(importers.every((f) => f.startsWith("src/lib/dxr/"))).toBe(true);
    expect(importers).toContain("src/lib/dxr/sessions.js");
    expect(importers).toContain("src/lib/dxr/flags.js");
  });

  it("nothing on the live path calls decide(), and M1 exports no decide to call", () => {
    const callers = [];
    for (const dir of ["src", "open-sse", "adapters"]) {
      for (const file of walk(path.join(REPO, dir))) {
        const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/\bdecide\s*\(/.test(src)) callers.push(rel(file));
      }
    }
    expect(callers).toEqual([]);

    const engineExports = [];
    for (const file of walk(path.join(REPO, "continuity"))) {
      const src = fs.readFileSync(file, "utf8");
      if (/export\s+(async\s+)?function\s+decide\b/.test(src)) engineExports.push(rel(file));
    }
    expect(engineExports).toEqual([]);
  });

  it("chat.js observes exactly once, discards the result, and cannot await it", () => {
    const src = fs.readFileSync(path.join(REPO, "src/sse/handlers/chat.js"), "utf8");
    const calls = src.match(/observeChatTurn\s*\(/g) || [];
    expect(calls).toHaveLength(1);
    expect(src).not.toMatch(/await\s+observeChatTurn/);
    expect(src).not.toMatch(/=\s*observeChatTurn/);
    expect(src).not.toMatch(/return\s+observeChatTurn/);
    // Nothing else in the handler reads a continuity concept.
    expect(src).not.toMatch(/getSessionStore|resolveSessionIdentity|observeTurn\b/);
  });

  it("accountFallback and the executor dispatch are untouched by M1", () => {
    const fallback = fs.readFileSync(path.join(REPO, "open-sse/services/accountFallback.js"), "utf8");
    expect(fallback).not.toMatch(/session|continuity|prefix_hash/i);
    const core = fs.readFileSync(path.join(REPO, "open-sse/handlers/chatCore.js"), "utf8");
    // `stripContinuityFields` is a pre-existing translator concern about Gemini's
    // cachedContent blob, unrelated to this engine; what must be absent is any reach
    // into continuity/ or the app-side glue.
    expect(core).not.toMatch(/observeChatTurn|continuity\/|lib\/dxr/);
  });
});

describe("I3 — the engine stays off (gate item 14)", () => {
  it("resolves off with an empty environment", async () => {
    const { resolveFlags, isEngineDisabled } = await import("../../continuity/flags.js");
    const flags = resolveFlags({});
    expect(flags.engine).toBe("off");
    expect(flags.engineAuthority).toBe(false);
    expect(isEngineDisabled(flags)).toBe(true);
  });

  it("grants no capability even when an operator asks for the engine", async () => {
    const { resolveFlags, unimplementedRequests, assertEngineOff, MILESTONE_FLAGS } = await import(
      "../../continuity/flags.js"
    );
    const env = { DXR_ENGINE: "on", DXR_ENGINE_AUTHORITY: "1", DXR_SHADOW: "1", DXR_CACHE_ECONOMICS: "1" };
    const flags = resolveFlags(env);
    // `engine` and `engineAuthority` echo what was requested — the flag surface does
    // not lie about the operator's input — but no milestone gate is implemented in M1,
    // so nothing is unlocked, and no code reads authority at all (asserted below).
    expect(flags.engine).toBe("on");
    for (const flag of Object.keys(MILESTONE_FLAGS)) expect(flags[flag]).toBe(false);
    expect(Object.values(MILESTONE_FLAGS).some((s) => s.implemented)).toBe(false);
    // And the misconfiguration is loud rather than silent.
    expect(() => assertEngineOff(flags)).toThrow(/engine must be OFF/);
    expect(unimplementedRequests(env).map((r) => r.flag)).toContain("cacheEconomics");
  });

  it("no shipped module reads the engine authority or shadow switch", () => {
    const readers = [];
    for (const dir of ["src", "open-sse", "adapters"]) {
      const stack = [path.join(REPO, dir)];
      while (stack.length) {
        for (const entry of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
          const full = path.join(entry.parentPath ?? entry.path, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== "node_modules" && !entry.name.startsWith(".")) stack.push(full);
          } else if (/\.m?js$/.test(entry.name)) {
            const src = fs.readFileSync(full, "utf8");
            if (/engineAuthority|flags\.shadow/.test(src)) readers.push(path.relative(REPO, full));
          }
        }
      }
    }
    // Nothing consumes them yet: M1 produces no Decision, so there is nothing to
    // authorise and nothing to shadow.
    expect(readers).toEqual([]);
  });

  it("session observation is the only M1 switch that responds to its environment", async () => {
    const { resolveFlags } = await import("../../continuity/flags.js");
    expect(resolveFlags({}).sessions).toBe(true);
    expect(resolveFlags({ DXR_SESSIONS: "off" }).sessions).toBe(false);
    // …and it does not turn the engine on as a side effect.
    expect(resolveFlags({ DXR_SESSIONS: "1" }).engine).toBe("off");
    expect(resolveFlags({ DXR_SESSIONS: "1" }).sessionInference).toBe(false);
  });
});
