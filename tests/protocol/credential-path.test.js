/**
 * The credential still reaches upstream after M0 encrypted it at rest.
 *
 * This is the one protocol regression M0 could plausibly have caused: encryption
 * sits between the row and the request, and redaction sits next to the same
 * fields. If either leaked into the outbound path, every provider call would fail
 * with 401 while the dashboard still looked healthy. So the test walks the real
 * path — real SQLite row, real account selection, real header builder — and checks
 * the plaintext arrives, then checks that the *diagnostic* copy of those same
 * headers does not carry it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const API_KEY = "sk-outbound-plaintext-key-0007";
const KEY_HEX = "ef".repeat(32);

const savedEnv = {};
let tmpDir;
let db;
let adapter;
let auth;
let DefaultExecutor;
let redactHeaders;
let connectionId;

function stashEnv(name, value) {
  savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-outbound-"));
  stashEnv("DXR_DATA_DIR", tmpDir);
  stashEnv("DXR_MASTER_KEY", KEY_HEX);

  global._dbAdapter = null;
  global._dxrMasterKey = null;
  vi.resetModules();

  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  auth = await import("@/sse/services/auth.js");
  ({ DefaultExecutor } = await import("../../open-sse/executors/default.js"));
  ({ redactHeaders } = await import("@/lib/security/redact.js"));

  const created = await db.createProviderConnection({
    provider: "openai",
    authType: "api-key",
    name: "outbound",
    email: "outbound@example.test",
    apiKey: API_KEY,
    priority: 1,
  });
  connectionId = created.id;
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    adapter?.close?.();
  } catch {
    /* best effort */
  }
  global._dbAdapter = null;
  global._dxrMasterKey = null;
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows keeps SQLite handles; the temp dir is disposable either way. */
  }
});

describe("store → selection → upstream headers", () => {
  it("stored the key as an envelope, not as text", () => {
    const raw = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [connectionId]).data;
    expect(raw).not.toContain(API_KEY);
    expect(raw).toContain("dxr1:");
  });

  it("hands account selection the decrypted credential", async () => {
    const cred = await auth.getProviderCredentials("openai");
    expect(cred).toBeTruthy();
    expect(cred.connectionId).toBe(connectionId);
    expect(cred.apiKey).toBe(API_KEY);
  });

  it("puts the real key on the outbound request", async () => {
    const cred = await auth.getProviderCredentials("openai");
    const headers = new DefaultExecutor("openai").buildHeaders(cred, true);
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    // Redaction is a property of diagnostics, not of the request. Asserting both
    // on the same header object is the only way to show they are separate paths.
    expect(JSON.stringify(redactHeaders(headers))).not.toContain(API_KEY);
    expect(redactHeaders(headers).Authorization).toBe("[REDACTED]");
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("still builds the provider URL from a stored connection", async () => {
    const cred = await auth.getProviderCredentials("openai");
    expect(new DefaultExecutor("openai").buildUrl("gpt-5", true, 0, cred)).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
  });

  it("returns null for a provider with no connection rather than inventing one", async () => {
    expect(await auth.getProviderCredentials("anthropic")).toBeNull();
  });
});
