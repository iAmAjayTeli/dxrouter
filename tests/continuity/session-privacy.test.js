/**
 * Group H — privacy (§14 H, §§10, 14.2).
 *
 * The promise is that the continuity database holds no conversation. The strong form
 * of that test is not "the columns look fine" but "take a request stuffed with
 * distinctive strings, observe it, then search every row of every table for any of
 * them". That is what the scan below does, and it is why the request content here is
 * deliberately full of things that would be embarrassing to find: a file path, a
 * prompt sentence, an API key, a tool name.
 */

import { describe, it, expect, afterEach } from "vitest";

import { observeTurn, resolveProjectRoot } from "../../continuity/session/observer.js";
import { UNKNOWN_PROJECT_ROOT, hashProjectRoot, isHashedProjectRoot } from "../../continuity/identity/sessionId.js";
import { messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

/** Every value in every table, as one string. Nothing is exempt from the search. */
function dumpEverything(db) {
  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((r) => r.name);
  const dump = {};
  for (const t of tables) dump[t] = db.all(`SELECT * FROM ${t}`);
  return { tables, text: JSON.stringify(dump) };
}

const SECRETS = [
  "sk-liveKeyDoNotStore",
  "the user asked me to refactor the billing module",
  "C:/Users/someone/secret-project/invoices.ts",
  "read_customer_records",
  "You are a coding agent with access to the payroll database",
  "ssh-rsa AAAAB3NzaC1yc2EA",
];

const loadedRequest = () => ({
  tools: [
    { name: "read_customer_records", description: "reads C:/Users/someone/secret-project/invoices.ts" },
    { name: "run_sql", description: "runs SQL against production" },
  ],
  system: "You are a coding agent with access to the payroll database. Key: sk-liveKeyDoNotStore",
  messages: [
    { role: "user", content: "the user asked me to refactor the billing module" },
    { role: "assistant", content: "ssh-rsa AAAAB3NzaC1yc2EA" },
    { role: "user", content: "C:/Users/someone/secret-project/invoices.ts" },
  ],
  protocol: "openai",
  model: "gpt-test",
  client_hint: { session_key: "cc-priv", project_root: "/repo/one" },
});

describe("H — privacy", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });

  const harness = async () => {
    const h = await openHarness({ tag: "priv" });
    open.push(h);
    return h;
  };

  it("stores none of the request content, in any table, after several turns", async () => {
    const h = await harness();
    const req = loadedRequest();
    await h.observe(req);
    h.tick(1000);
    await h.observe({ ...req, messages: [...req.messages, { role: "assistant", content: "sk-liveKeyDoNotStore" }] });
    h.tick(1000);
    await h.observe({ ...req, messages: [{ role: "user", content: "compacted summary" }] });

    const { tables, text } = dumpEverything(h.db);
    expect(tables).toContain("turns");
    expect(tables).toContain("sessions");
    expect(tables).toContain("session_prefix");
    for (const needle of SECRETS) expect(text, needle).not.toContain(needle);
    expect(text).not.toContain("compacted summary");
    // Belt and braces: no long base64-ish or sentence-shaped payload smuggled in.
    expect(text).not.toMatch(/refactor|payroll|invoices/i);
  });

  it("has no column a body could go in", async () => {
    const h = await harness();
    const columns = (table) => h.db.all(`PRAGMA table_info(${table})`).map((r) => r.name);
    const turnCols = columns("turns");
    for (const banned of ["body", "request_body", "messages_json", "prompt", "content", "text", "payload"]) {
      expect(turnCols, banned).not.toContain(banned);
    }
    // What the messages layer contributes is a hash, a count and a token estimate.
    expect(turnCols).toContain("messages_hash");
    expect(turnCols).toContain("message_count");
    expect(turnCols).toContain("messages_tokens");
    for (const banned of ["digests_json", "messages_json"]) expect(turnCols).not.toContain(banned);

    const prefixCols = columns("session_prefix");
    expect(prefixCols).toContain("digests_json");
    for (const banned of ["body", "content", "messages", "prompt"]) expect(prefixCols).not.toContain(banned);
  });

  it("keeps only digests in session_prefix, never the messages they came from", async () => {
    const h = await harness();
    const r = await h.observe(loadedRequest());
    const row = h.db.get("SELECT digests_json FROM session_prefix WHERE session_id = ?", [r.session_id]);
    const digests = JSON.parse(row.digests_json);
    expect(digests).toHaveLength(3);
    for (const d of digests) expect(d).toMatch(/^c1:[0-9a-f]{64}$/);
  });

  it("records only vocabulary in notes and labels, never a copied value", async () => {
    const h = await harness();
    await h.observe({ ...loadedRequest(), client_hint: { session_key: "sk-liveKeyDoNotStore" } });
    const rows = h.db.all("SELECT notes, labels FROM turns");
    const text = JSON.stringify(rows);
    expect(text).toContain("session_key_rejected:secret_like");
    expect(text).not.toContain("sk-liveKeyDoNotStore");
    for (const row of rows) {
      for (const note of (row.notes ?? "").split(",").filter(Boolean)) {
        expect(note, note).toMatch(/^[a-z0-9_:.-]+$/);
      }
    }
  });

  it("hashes the project root when asked, salted, and stores nothing else", async () => {
    const h = await harness();
    const salt = "test-salt";
    const r = await observeTurn({
      store: h.store,
      request: turnRequest({ msgs: messages(1), root: "C:/Users/someone/secret-project" }),
      clock: h.clock,
      newId: h.newId,
      owner: "1:test",
      sleep: async () => {},
      hashProjectPaths: true,
      projectRootSalt: salt,
    });
    expect(r.project_root_hashed).toBe(true);
    const row = h.db.get("SELECT project_root, project_root_hashed FROM sessions WHERE id = ?", [r.session_id]);
    expect(row.project_root).toBe(hashProjectRoot("C:/Users/someone/secret-project", salt));
    expect(isHashedProjectRoot(row.project_root)).toBe(true);
    expect(row.project_root_hashed).toBe(1);
    expect(dumpEverything(h.db).text).not.toContain("secret-project");
  });

  it("salts the hash, so the same path under two salts is two values", () => {
    const a = hashProjectRoot("/repo/one", "salt-a");
    const b = hashProjectRoot("/repo/one", "salt-b");
    expect(a).not.toBe(b);
    expect(a).toBe(hashProjectRoot("/repo/one", "salt-a"));
    expect(() => hashProjectRoot("/repo/one", "")).toThrow(/salt/);
  });

  it("refuses to store a plain path when hashing was asked for and cannot be done", async () => {
    // Storing the path anyway would break the promise quietly. `unknown` plus a note
    // is the honest outcome.
    expect(resolveProjectRoot({ projectRoot: "/repo/one", hashProjectPaths: true, salt: null })).toEqual({
      project_root: UNKNOWN_PROJECT_ROOT,
      hashed: false,
      note: "project_root_hash_salt_missing",
    });

    const h = await harness();
    const r = await observeTurn({
      store: h.store,
      request: turnRequest({ msgs: messages(1), root: "/repo/secret" }),
      clock: h.clock,
      newId: h.newId,
      owner: "1:test",
      sleep: async () => {},
      hashProjectPaths: true,
      projectRootSalt: null,
    });
    expect(r.notes).toContain("project_root_hash_salt_missing");
    expect(h.db.get("SELECT project_root FROM sessions WHERE id = ?", [r.session_id]).project_root).toBe(
      UNKNOWN_PROJECT_ROOT,
    );
    expect(dumpEverything(h.db).text).not.toContain("/repo/secret");
  });

  it("stores the plain root only when hashing was not requested", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), root: "/repo/one" }));
    const row = h.db.get("SELECT project_root, project_root_hashed FROM sessions WHERE id = ?", [r.session_id]);
    expect(row).toMatchObject({ project_root: "/repo/one", project_root_hashed: 0 });
    expect(resolveProjectRoot({ projectRoot: "/repo/one", hashProjectPaths: false })).toEqual({
      project_root: "/repo/one",
      hashed: false,
      note: null,
    });
  });

  it("stores `unknown` rather than inventing a project root", async () => {
    const h = await harness();
    for (const root of [undefined, null, "   ", 42]) {
      // The hint is built by hand: `turnRequest` would fill in its own default root.
      const r = await h.observe({
        tools: null,
        system: "s",
        messages: messages(1, String(root)),
        client_hint: { session_key: null, project_root: root },
      });
      expect(h.db.get("SELECT project_root FROM sessions WHERE id = ?", [r.session_id]).project_root).toBe(
        UNKNOWN_PROJECT_ROOT,
      );
      h.tick(1);
    }
  });
});
