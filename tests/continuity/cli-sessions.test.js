/**
 * `dxrouter sessions` — the §13 inspection surface.
 *
 * Two properties are worth a test here. First, that the listing shows the ten §13
 * facts and shows the *persisted* ones — an inspection tool that recomputes a grade
 * for display would hide exactly the bug an operator is looking for. Second, that it
 * is inspection only: the module has no way to pin, close, switch or route, and the
 * rendering is pure, so the same database and the same `now` give the same bytes.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import * as cli from "../../continuity/cli/sessions.js";
import {
  SESSION_COLUMNS,
  describeSession,
  formatAge,
  formatInstant,
  formatPin,
  formatProjectRoot,
  renderSessionDetail,
  renderSessionsJson,
  renderSessionsTable,
  renderSessionsView,
} from "../../continuity/cli/sessions.js";
import { hashProjectRoot } from "../../continuity/identity/sessionId.js";
import { sweepSessions } from "../../continuity/session/sweeper.js";
import { DEFAULT_SESSION_POLICY } from "../../continuity/session/policy.js";
import { makeTmpDir, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

describe("§13 formatting is pure and deterministic", () => {
  it("names the ten columns §13 asks for", () => {
    expect(SESSION_COLUMNS).toEqual([
      "SESSION",
      "PROJECT",
      "CONF",
      "SOURCE",
      "OPENED",
      "LAST SEEN",
      "TURNS",
      "STATE",
      "PIN",
      "CLOSE REASON",
    ]);
  });

  it("renders instants as ISO-8601 UTC, and a missing one as a dash", () => {
    expect(formatInstant(1700000000000)).toBe("2023-11-14T22:13:20Z");
    expect(formatInstant(null)).toBe("-");
    expect(formatInstant(undefined)).toBe("-");
  });

  it("renders ages coarsely and never negatively", () => {
    const at = 1700000000000;
    expect(formatAge(at, at + 5000)).toBe("5s");
    expect(formatAge(at, at + 5 * 60000)).toBe("5m");
    expect(formatAge(at, at + 5 * 3600000)).toBe("5h");
    expect(formatAge(at, at + 5 * 86400000)).toBe("5d");
    expect(formatAge(at, at - 1000)).toBe("0s");
    expect(formatAge(null, at)).toBe("-");
  });

  it("marks a hashed project root as a hash and shortens a long path from the front", () => {
    const hash = hashProjectRoot("/repo/one", "salt");
    expect(formatProjectRoot(hash, true)).toBe("pr1:" + hash.slice(4, 14));
    expect(formatProjectRoot(hash, 0)).toMatch(/^pr1:[0-9a-f]{10}$/);
    expect(formatProjectRoot("/repo/one", false)).toBe("/repo/one");
    // The tail is what identifies a checkout, so the front is what gets dropped.
    expect(formatProjectRoot("/very/long/path/to/a/checkout/of/the/repository", false, { width: 20 })).toBe(
      "...of/the/repository",
    );
    expect(formatProjectRoot(null, false)).toBe("unknown");
  });

  it("shows no pin in M1, because M1 sets none", () => {
    expect(formatPin({})).toBe("-");
    expect(formatPin({ pin_provider: "p", pin_model: "m" })).toBe("p/m");
    expect(formatPin({ pin_provider: "p" })).toBe("p/?");
  });

  it("flattens a row without inventing anything", () => {
    const d = describeSession(
      {
        id: "s1",
        project_root: "/repo/one",
        project_root_hashed: 0,
        identity_confidence: "weakly_inferred",
        identity_source: "ambiguous_prefix",
        client_key: null,
        predecessor_id: null,
        opened_at: 1000,
        last_seen_at: 2000,
        turn_count: 3,
        closed_at: null,
        close_reason: null,
      },
      { now: 5000 },
    );
    expect(d).toMatchObject({
      id: "s1",
      state: "open",
      identity_confidence: "weakly_inferred",
      identity_source: "ambiguous_prefix",
      turn_count: 3,
      pin: "-",
      age: "3s",
    });
  });

  it("says so plainly when there is nothing to show", () => {
    expect(renderSessionsTable([])).toBe("no sessions recorded");
    expect(JSON.parse(renderSessionsJson([], { now: 1 }))).toEqual({ generated_at: 1, count: 0, sessions: [] });
  });

  it("exports no way to change anything", () => {
    const names = Object.keys(cli);
    for (const forbidden of ["pin", "unpin", "close", "closeSession", "switch", "route", "decide", "setPolicy"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    for (const [name, value] of Object.entries(cli)) {
      if (typeof value === "function") expect(name, name).toMatch(/^(render|format|describe|default)/);
    }
  });
});

describe("§13 listing against a real store", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });

  const harness = async () => {
    const h = await openHarness({ tag: "cli" });
    open.push(h);
    return h;
  };

  /** Two sessions: one live and explicitly keyed, one closed by the sweeper. */
  const populate = async (h) => {
    const closed = await h.observe(turnRequest({ msgs: messages(1), root: "/repo/old" }));
    h.tick(DEFAULT_SESSION_POLICY.idleTimeoutMs + 1);
    sweepSessions({ store: h.store, clock: h.clock });
    const live = await h.observe(turnRequest({ msgs: messages(3), key: "cc-cli", root: "/repo/one" }));
    h.tick(1000);
    await h.observe(turnRequest({ msgs: messages(5), key: "cc-cli", root: "/repo/one" }));
    return { closed: closed.session_id, live: live.session_id };
  };

  it("shows the persisted grade, turn count, state and close reason", async () => {
    const h = await harness();
    const { closed, live } = await populate(h);
    const view = renderSessionsView({ store: h.store, clock: h.clock });

    expect(view.count).toBe(2);
    const lines = view.text.split("\n");
    expect(lines[0]).toContain("SESSION");
    expect(lines[0]).toContain("CLOSE REASON");

    const liveLine = lines.find((l) => l.startsWith(live));
    expect(liveLine).toContain("explicit");
    expect(liveLine).toContain("header");
    expect(liveLine).toContain("/repo/one");
    expect(liveLine).toContain("open");
    expect(liveLine).toMatch(/\s2\s/);

    const closedLine = lines.find((l) => l.startsWith(closed));
    expect(closedLine).toContain("closed");
    expect(closedLine).toContain("idle_timeout");
    // The listing repeats what is stored, it does not recompute it.
    const row = h.store.sessions.getSession(h.db, live);
    expect(liveLine).toContain(row.identity_confidence);
    expect(liveLine).toContain(String(row.turn_count));
  });

  it("is byte-for-byte stable for the same database and the same now", async () => {
    const h = await harness();
    await populate(h);
    const once = renderSessionsView({ store: h.store, clock: h.clock }).text;
    const twice = renderSessionsView({ store: h.store, clock: h.clock }).text;
    expect(twice).toBe(once);
  });

  it("filters to open sessions and to one project", async () => {
    const h = await harness();
    const { live } = await populate(h);
    const openOnly = renderSessionsView({ store: h.store, clock: h.clock, options: { all: false } });
    expect(openOnly.count).toBe(1);
    expect(openOnly.text).toContain(live);

    const byProject = renderSessionsView({ store: h.store, clock: h.clock, options: { project: "/repo/old" } });
    expect(byProject.count).toBe(1);
    expect(byProject.text).not.toContain(live);

    const limited = renderSessionsView({ store: h.store, clock: h.clock, options: { limit: 1 } });
    expect(limited.count).toBe(1);
  });

  it("renders JSON with the same facts", async () => {
    const h = await harness();
    const { live } = await populate(h);
    const payload = JSON.parse(renderSessionsView({ store: h.store, clock: h.clock, options: { json: true } }).text);
    expect(payload.count).toBe(2);
    const row = payload.sessions.find((s) => s.id === live);
    expect(row).toMatchObject({
      identity_confidence: "explicit",
      identity_source: "header",
      project_root: "/repo/one",
      turn_count: 2,
      state: "open",
      close_reason: null,
      client_key: "cc-cli",
      pin: "-",
    });
  });

  it("shows per-turn detail, including hashes, provenance and boundaries", async () => {
    const h = await harness();
    const { live } = await populate(h);
    const detail = renderSessionsView({ store: h.store, clock: h.clock, options: { id: live } }).text;
    expect(detail).toContain(`session       ${live}`);
    expect(detail).toContain("identity      explicit via header");
    expect(detail).toContain("client key    cc-cli");
    expect(detail).toContain("IDX");
    expect(detail).toContain("estimated");
    expect(detail).toContain("extension");
    expect(detail.split("\n").filter((l) => /^\d+\s/.test(l))).toHaveLength(2);

    const json = JSON.parse(
      renderSessionsView({ store: h.store, clock: h.clock, options: { id: live, json: true } }).text,
    );
    expect(json.session.id).toBe(live);
    expect(json.turns).toHaveLength(2);
    // The JSON form keeps the full hash: a truncated one cannot be compared by hand.
    expect(json.turns[0].messages_hash).toMatch(/^c1:[0-9a-f]{64}$/);
  });

  it("says so rather than throwing for an unknown id", async () => {
    const h = await harness();
    const view = renderSessionsView({ store: h.store, clock: h.clock, options: { id: "nope" } });
    expect(view).toEqual({ text: "session not found", count: 0 });
    const json = JSON.parse(renderSessionsView({ store: h.store, options: { id: "nope", json: true } }).text);
    expect(json).toMatchObject({ session: null, turns: [] });
  });

  it("prints a hashed project root as a hash, never a path", async () => {
    const h = await harness();
    const salt = "cli-salt";
    const { observeTurn } = await import("../../continuity/session/observer.js");
    await observeTurn({
      store: h.store,
      request: turnRequest({ msgs: messages(1), root: "/repo/secret-checkout" }),
      clock: h.clock,
      newId: h.newId,
      owner: "1:test",
      sleep: async () => {},
      hashProjectPaths: true,
      projectRootSalt: salt,
    });
    const text = renderSessionsView({ store: h.store, clock: h.clock }).text;
    expect(text).toContain("pr1:");
    expect(text).not.toContain("secret-checkout");
  });
});


/**
 * The CLI as an operator actually runs it: a separate `node` process, no bundler, no
 * `@/` alias, a data root from the environment. Three things only a spawn can prove —
 * that `scripts/dxrouter.mjs` loads under bare node, that it opens the database under
 * `DXR_DATA_DIR` rather than a path of its own, and that stdout carries nothing but the
 * requested output (the driver banner and the migration log belong on stderr, or
 * `--json` would be unparseable).
 */
describe("§13 the CLI as a process", () => {
  const ROOT = path.resolve(import.meta.dirname, "..", "..");
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) removeTmpDir(dir);
  });

  function run(args, dataDir) {
    return execFileSync(process.execPath, [path.join(ROOT, "scripts", "dxrouter.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DXR_DATA_DIR: dataDir },
    });
  }

  it("runs under bare node and prints parseable JSON on stdout", () => {
    const dir = makeTmpDir("cliproc");
    dirs.push(dir);
    const out = run(["sessions", "--json"], dir);
    expect(JSON.parse(out)).toMatchObject({ count: 0, sessions: [] });
    expect(fs.existsSync(path.join(dir, "db", "continuity.sqlite"))).toBe(true);
  });

  it("offers exactly the inspection commands, none of which controls routing", () => {
    const dir = makeTmpDir("cliproc");
    dirs.push(dir);
    const out = run(["help"], dir);
    expect(out).toContain("Inspection only");
    // Every indented usage line, reduced to its command word. §13 allows an inspection
    // surface and nothing else, so this list is the whole contract: a `dxrouter pin`, a
    // `dxrouter switch` or a `dxrouter cache` would appear here.
    const commands = out
      .split(/\r?\n/)
      .filter((line) => line.startsWith("  dxrouter "))
      .map((line) => line.trim().split(/\s+/)[1]);
    expect(new Set(commands)).toEqual(new Set(["sessions", "cost", "measure", "help"]));
  });
});
