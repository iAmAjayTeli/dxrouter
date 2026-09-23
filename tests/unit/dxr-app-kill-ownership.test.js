/**
 * `killAppProcesses` may only terminate what ownership proved.
 *
 * The identity suite (`dxr-updater-identity.test.js`) asserts this structurally: the
 * upstream name and the substring matching are absent from the source. That is necessary
 * and not sufficient — it says the old selector is gone, not that the surviving one
 * governs the kill. Nothing executed the kill at all, so "selects correctly" and "kills
 * only what it selected" were two different claims with evidence for one.
 *
 * So these cases run the real `killAppProcesses` against a mocked process-killing
 * primitive and assert on the PIDs that actually reached it. The selection half uses the
 * REAL matchers (`isCommandLineInAppRoot`, `isAppRuntimeName`) over a synthetic process
 * table, so the boundary rule and the kill are wired together in one assertion rather
 * than trusted to agree.
 *
 * This lives in its own file because it must mock `child_process`, and the identity suite
 * needs the real one to shell out to `git` for provenance.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One recorder and one fixture holder, shared by both `child_process` specifiers.
 *
 * `appUpdater` imports the bare `child_process` while `dxrInstallation` imports
 * `node:child_process`. Vite resolves them to the same module, so two separate mock
 * factories silently shadow one another and the kills stop being recorded — which is
 * exactly what happened when they were written apart. One implementation, registered
 * twice, cannot drift.
 */
const harness = vi.hoisted(() => {
  const killer = { calls: [] };
  const shell = { netstat: "", lsof: "" };
  const factory = () => ({
    execFileSync: (file, args) => {
      killer.calls.push({ file, args: args ?? [] });
      return "";
    },
    execSync: (command) => {
      const text = String(command);
      // Read-only probes answer with a fixture; anything else is a kill and is recorded.
      if (/netstat/i.test(text)) return shell.netstat;
      if (/lsof/i.test(text)) return shell.lsof;
      killer.calls.push({ file: "sh", args: [text] });
      return "";
    },
  });
  return { killer, shell, factory };
});

const { killer, shell } = harness;

vi.mock("child_process", () => harness.factory());
vi.mock("node:child_process", () => harness.factory());

/** A data root with no PID files, so auxiliary cleanup is a no-op we can ignore. */
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-kill-root-"));

vi.mock("@/lib/dataDir", () => ({ DATA_DIR: emptyRoot }));
vi.mock("@/lib/tunnel/shared/state", () => ({ TUNNEL_DIR: path.join(emptyRoot, "tunnel") }));
vi.mock("@/lib/tunnel/cloudflare/pid", () => ({
  loadPid: () => null,
  clearPid: () => {},
}));

/** Replaced per test; the real module is loaded for its matchers below. */
const ownership = vi.hoisted(() => ({ result: { processes: [], pids: [] } }));

vi.mock("@/lib/dxrInstallation", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, listOwnedProcesses: () => ownership.result };
});

afterAll(() => {
  try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * The PIDs handed to a kill primitive, parsed by command shape rather than by scraping
 * every integer out of the arguments.
 *
 * Shape-aware on purpose: the POSIX force-kill is `kill -9 <pid> 2>/dev/null`, so a
 * digit-scraper would report 9 and 2 as terminated processes and the exact-set assertions
 * below would pass or fail depending on which platform ran them. An unrecognised call is
 * deliberately not counted here — the `toEqual([])` assertions inspect `killer.calls`
 * directly, so a kill in an unexpected shape still fails rather than hiding.
 */
function killedPids() {
  const pids = new Set();
  const addAfter = (args, flag) => {
    const at = args.findIndex((a) => String(a).toUpperCase() === flag);
    if (at !== -1 && args[at + 1] !== undefined) pids.add(Number(args[at + 1]));
  };

  for (const { file, args } of killer.calls) {
    if (/taskkill/i.test(file)) { addAfter(args, "/PID"); continue; }
    if (/^sudo$/i.test(file)) { addAfter(args, "-9"); continue; }
    const match = String(args[0] ?? "").match(/\bkill\s+-9\s+(\d+)/);
    if (match) pids.add(Number(match[1]));
  }
  return pids;
}

/**
 * The real selection step, run over a synthetic process table.
 *
 * Mirrors `listOwnedProcesses`' root branch exactly — same two predicates, same order —
 * so what is asserted below is the behaviour of the shipped matchers rather than a
 * paraphrase of them. The port and PID-file signals are not involved: this is about which
 * command lines qualify.
 */
async function ownedFromTable(table, root) {
  const { isCommandLineInAppRoot, isAppRuntimeName } = await import("@/lib/dxrInstallation.js");
  const processes = table
    .filter((proc) => isAppRuntimeName(proc.name) && isCommandLineInAppRoot(proc.commandLine, root))
    .map((proc) => ({ pid: proc.pid, sources: ["app-root"] }));
  return { processes, pids: processes.map((p) => p.pid) };
}

beforeEach(() => {
  killer.calls = [];
  shell.netstat = "";
  shell.lsof = "";
  ownership.result = { processes: [], pids: [] };
});

/**
 * Which listener owns a port, read out of the OS tool's output.
 *
 * Worth pinning separately because this is the signal that gets force-killed, and its
 * parsing has two traps. A dual-stack listener is reported as `[::]:20127`, so anything
 * splitting on the first colon reads the port as empty and finds nothing; and the port
 * must be compared as a number, since `:20127` is a substring of `:201270`.
 */
describe("port ownership is parsed, not pattern-matched", () => {
  const WANTED = 20127;

  it.runIf(process.platform === "win32")("reads IPv4, IPv6 and dual-stack listener rows", async () => {
    const { pidsListeningOnPort } = await import("@/lib/dxrInstallation.js");

    shell.netstat = [
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:20127        0.0.0.0:0              LISTENING       4101",
      "  TCP    [::]:20127             [::]:0                 LISTENING       4102",
      "  TCP    [::1]:20127            [::]:0                 LISTENING       4103",
      // A longer port that merely starts with ours — a substring test would claim it.
      "  TCP    127.0.0.1:201270       0.0.0.0:0              LISTENING       9001",
      // Right port, wrong state: an outbound connection is not a listener.
      "  TCP    127.0.0.1:20127        10.0.0.9:443           ESTABLISHED     9002",
      // A different port entirely.
      "  TCP    127.0.0.1:20128        0.0.0.0:0              LISTENING       9003",
      // UDP rows share the table and must be ignored.
      "  UDP    127.0.0.1:20127        *:*                                    9004",
    ].join("\n");

    const pids = pidsListeningOnPort(WANTED).sort((a, b) => a - b);

    expect(pids).toEqual([4101, 4102, 4103]);
    for (const foreign of [9001, 9002, 9003, 9004]) expect(pids).not.toContain(foreign);
  });

  it.runIf(process.platform !== "win32")("reads the PID list lsof prints", async () => {
    const { pidsListeningOnPort } = await import("@/lib/dxrInstallation.js");

    shell.lsof = "4101\n4102\n";
    expect(pidsListeningOnPort(WANTED).sort((a, b) => a - b)).toEqual([4101, 4102]);
  });

  it("refuses a port that is not a port rather than probing something", async () => {
    const { pidsListeningOnPort } = await import("@/lib/dxrInstallation.js");

    for (const bad of [0, -1, NaN, null, undefined, "not-a-port"]) {
      expect(pidsListeningOnPort(bad), String(bad)).toEqual([]);
    }
  });
});

describe("killAppProcesses terminates exactly the owned set", () => {
  it("passes every owned PID to the kill primitive", async () => {
    ownership.result = {
      processes: [{ pid: 4101, sources: ["own-port"] }, { pid: 4102, sources: ["app-root"] }],
      pids: [4101, 4102],
    };

    const { killAppProcesses } = await import("@/lib/appUpdater.js");
    const owned = await killAppProcesses();

    expect(killedPids()).toEqual(new Set([4101, 4102]));
    expect(owned.pids).toEqual([4101, 4102]);
  });

  it("kills nothing at all when ownership proved nothing", async () => {
    ownership.result = { processes: [], pids: [] };

    const { killAppProcesses } = await import("@/lib/appUpdater.js");
    await killAppProcesses();

    // Not "kills fewer things" — an empty ownership report must produce an empty kill
    // list, because every fallback that used to fill it in was a name match.
    expect(killer.calls).toEqual([]);
  });

  it("never reaches a PID that ownership did not report", async () => {
    // 9001 is the upstream 9Router server, 9002 an unrelated Next.js app, 9003 the
    // operator's editor — all running, none ours. The old selector matched all three.
    ownership.result = { processes: [{ pid: 4101, sources: ["app-root"] }], pids: [4101] };

    const { killAppProcesses } = await import("@/lib/appUpdater.js");
    await killAppProcesses();

    const killed = killedPids();
    expect(killed).toContain(4101);
    for (const foreign of [9001, 9002, 9003]) expect(killed).not.toContain(foreign);
    expect(killed.size).toBe(1);
  });
});

describe("the selection rule decides the kill, end to end", () => {
  const WIN_ROOT = "D:\\dxrouter";
  const POSIX_ROOT = "/opt/dxrouter";

  it("kills this installation's processes and leaves co-resident ones alone", async () => {
    const table = [
      // Ours: the dev server, its parent, and a standalone build.
      { pid: 5001, name: "node.exe", commandLine: "C:\\nvm4w\\nodejs\\node.exe D:\\dxrouter\\node_modules\\next\\dist\\server\\lib\\start-server.js" },
      { pid: 5002, name: "node.exe", commandLine: '"node" "D:\\dxrouter\\node_modules\\.bin\\\\..\\next\\dist\\bin\\next" dev --port 20127' },
      // Upstream 9Router, installed globally on the same machine.
      { pid: 6001, name: "node.exe", commandLine: "C:\\nvm4w\\nodejs\\node.exe C:\\nvm4w\\nodejs\\node_modules\\9router\\app\\server.js" },
      // Somebody else's Next.js server — the `next-server` substring matched these.
      { pid: 6002, name: "node.exe", commandLine: "node C:\\work\\other\\node_modules\\next\\dist\\server\\lib\\start-server.js" },
      // Sibling checkouts that share our root as a prefix.
      { pid: 6003, name: "node.exe", commandLine: "node D:\\dxrouter-other\\server.js" },
      { pid: 6004, name: "node.exe", commandLine: "node D:\\dxrouter.bak\\server.js" },
      // An editor with our path in its argv, which is not part of the installation.
      { pid: 6005, name: "Code.exe", commandLine: "Code.exe D:\\dxrouter" },
    ];

    ownership.result = await ownedFromTable(table, WIN_ROOT);
    const { killAppProcesses } = await import("@/lib/appUpdater.js");
    await killAppProcesses();

    expect(killedPids()).toEqual(new Set([5001, 5002]));
  });

  it("does not kill a POSIX installation whose path merely ends with ours", async () => {
    // The boundary defect, carried all the way to the kill: normalised to
    // `\opt\dxrouter`, `/srv/opt/dxrouter` ends with our root. A bare `endsWith` selected
    // it, and selection is termination.
    const table = [
      { pid: 7001, name: "node", commandLine: "node /opt/dxrouter/server.js" },
      { pid: 8001, name: "node", commandLine: "node /srv/opt/dxrouter/server.js" },
      { pid: 8002, name: "node", commandLine: "node /home/u/mirror/opt/dxrouter/app.js" },
      { pid: 8003, name: "node", commandLine: "node /opt/dxrouter-other/server.js" },
    ];

    ownership.result = await ownedFromTable(table, POSIX_ROOT);
    const { killAppProcesses } = await import("@/lib/appUpdater.js");
    await killAppProcesses();

    const killed = killedPids();
    expect(killed).toContain(7001);
    for (const foreign of [8001, 8002, 8003]) expect(killed).not.toContain(foreign);
  });

  it("kills nothing when the root is degenerate rather than everything", async () => {
    const table = [
      { pid: 9101, name: "node", commandLine: "node C:\\anything\\at\\all.js" },
      { pid: 9102, name: "node", commandLine: "node D:\\dxrouter\\server.js" },
    ];

    // A drive root would match every path on the volume, so it is refused outright.
    ownership.result = await ownedFromTable(table, "C:\\");
    const { killAppProcesses } = await import("@/lib/appUpdater.js");
    await killAppProcesses();

    expect(killer.calls).toEqual([]);
  });
});
