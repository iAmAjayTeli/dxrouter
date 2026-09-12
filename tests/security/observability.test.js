/**
 * Diagnostics: request bodies OFF by default, secrets redacted always (M0 section 2).
 *
 * These two are separate axes and the tests keep them separate:
 *   - whether a diagnostic row is written at all  -> settings.enableObservability
 *   - whether prompts/completions go inside it    -> settings.persistRequestBodies
 *
 * The important assertions run against the row SQLite actually holds, because
 * that is the artefact that leaks. Asserting on the value handed to the writer
 * would pass even if the writer stored something else.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const PROMPT = "my-private-prompt-text-do-not-persist";
const COMPLETION = "the-model-reply-do-not-persist";
const API_KEY = "sk-live-abcdefghijklmnopqrstuvwxyz";

const savedEnv = {};
let tmpDir;
let db;
let adapter;

function stashEnv(name, value) {
  savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The writer flushes on a timer/threshold and does not return a promise. */
async function waitForRow(id, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = adapter.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
    if (row) return row.data;
    if (Date.now() > deadline) throw new Error(`row ${id} never landed`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function detail(id) {
  return {
    id,
    provider: "openai",
    model: "gpt-5",
    connectionId: "conn-1",
    status: 200,
    tokens: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 },
    request: {
      model: "gpt-5",
      stream: false,
      messages: [{ role: "user", content: PROMPT }],
      tools: [{ type: "function", function: { name: "t" } }],
      headers: { authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY, "user-agent": "vitest" },
    },
    providerRequest: { messages: [{ role: "user", content: PROMPT }] },
    providerResponse: { choices: [{ message: { content: COMPLETION } }] },
    response: { finish_reason: "stop", choices: [{ message: { content: COMPLETION } }] },
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-obs-"));
  stashEnv("DXR_DATA_DIR", tmpDir);
  stashEnv("DXR_MASTER_KEY", "11".repeat(32));
  stashEnv("ENABLE_REQUEST_LOGS", undefined);
  stashEnv("OBSERVABILITY_ENABLED", undefined);
  stashEnv("DXR_PERSIST_REQUEST_BODIES", undefined);

  global._dbAdapter = null;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();

  // Diagnostics on, bodies left at their default. Batch size 1 so a single save
  // flushes without waiting out the interval.
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
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
  try {
    // Windows keeps the SQLite handle open until the driver is GC'd, so removal
    // is best effort; the OS reclaims the temp directory either way.
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("the persisted row, with bodies at their default", () => {
  let raw;

  beforeAll(async () => {
    const { saveRequestDetail } = await import("@/lib/db/repos/requestDetailsRepo.js");
    await saveRequestDetail(detail("off-1"));
    raw = await waitForRow("off-1");
  });

  it("does not contain the prompt", () => {
    expect(raw).not.toContain(PROMPT);
  });

  it("does not contain the completion", () => {
    expect(raw).not.toContain(COMPLETION);
  });

  it("does not contain the API key, in any field", () => {
    expect(raw).not.toContain(API_KEY);
  });

  it("does not even record that an authorization header was present", () => {
    expect(raw.toLowerCase()).not.toContain("authorization");
    expect(raw.toLowerCase()).not.toContain("x-api-key");
  });

  it("keeps the shape of the exchange, which is what the charts need", () => {
    const record = JSON.parse(raw);
    expect(record.request._bodyOmitted).toBe(true);
    expect(record.request.model).toBe("gpt-5");
    expect(record.request.messageCount).toBe(1);
    expect(record.request.toolCount).toBe(1);
    expect(record.request.headers["user-agent"]).toBe("vitest");
    expect(record.response._bodyOmitted).toBe(true);
    expect(record.response.finish_reason).toBe("stop");
    expect(record.tokens).toEqual({ prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 });
  });
});

describe("the persisted row, with bodies explicitly opted in", () => {
  let raw;

  beforeAll(async () => {
    // A fresh module instance so the 5s settings cache is not consulted; the
    // database itself is shared through global._dbAdapter.
    process.env.DXR_PERSIST_REQUEST_BODIES = "1";
    vi.resetModules();
    const { saveRequestDetail } = await import("@/lib/db/repos/requestDetailsRepo.js");
    await saveRequestDetail(detail("on-1"));
    raw = await waitForRow("on-1");
    delete process.env.DXR_PERSIST_REQUEST_BODIES;
  });

  it("stores the prompt, because the operator asked for it", () => {
    expect(raw).toContain(PROMPT);
  });

  it("still drops the credential — redaction has no off switch", () => {
    expect(raw).not.toContain(API_KEY);
    expect(raw.toLowerCase()).not.toContain("authorization");
  });
});

describe("the body-persistence switch itself", () => {
  let helpers;

  beforeAll(async () => {
    vi.resetModules();
    ({ __test__: helpers } = await import("@/lib/db/repos/requestDetailsRepo.js"));
  });

  it("defaults to off when neither the env nor the settings say anything", () => {
    delete process.env.DXR_PERSIST_REQUEST_BODIES;
    expect(helpers.resolvePersistBodies(undefined)).toBe(false);
    expect(helpers.resolvePersistBodies({})).toBe(false);
  });

  it("honours the settings flag", () => {
    expect(helpers.resolvePersistBodies({ persistRequestBodies: true })).toBe(true);
    expect(helpers.resolvePersistBodies({ persistRequestBodies: false })).toBe(false);
  });

  it("lets the environment override the settings in both directions", () => {
    process.env.DXR_PERSIST_REQUEST_BODIES = "1";
    expect(helpers.resolvePersistBodies({ persistRequestBodies: false })).toBe(true);
    process.env.DXR_PERSIST_REQUEST_BODIES = "0";
    expect(helpers.resolvePersistBodies({ persistRequestBodies: true })).toBe(false);
    delete process.env.DXR_PERSIST_REQUEST_BODIES;
  });

  it("summarises a request without carrying any content", () => {
    const summary = helpers.summarizeRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: PROMPT }],
      headers: { authorization: "Bearer x", accept: "*/*" },
    });
    expect(JSON.stringify(summary)).not.toContain(PROMPT);
    expect(summary.headers).toEqual({ accept: "*/*" });
  });

  it("truncates by size alone, with no content preview", () => {
    const out = helpers.truncateField({ blob: "x".repeat(500) }, 100);
    // Upstream kept the first 200 characters of an oversized payload, which is
    // exactly where a pasted key or an echoed header tends to sit.
    expect(out).toEqual({ _truncated: true, _originalSize: expect.any(Number) });
    expect(Object.keys(out)).not.toContain("_preview");
  });
});
