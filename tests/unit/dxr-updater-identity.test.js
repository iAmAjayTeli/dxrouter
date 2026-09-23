/**
 * DXRouter must never update, relaunch or terminate upstream 9Router.
 *
 * The fork's update path was entirely upstream's identity. It checked
 * `registry.npmjs.org/9router/latest`, offered `npm i -g 9router@latest`, relaunched
 * `npx 9router`, probed port 20128 for liveness and selected processes by the substrings
 * `9router`, `next-server` and `cli.js`. Every one of those agrees with every other, so
 * nothing looked wrong on this machine — the code was internally consistent and aimed at
 * a different product. A checkout pinned at the upstream v0.5.60 fork point therefore
 * reported upstream's v0.5.75 as "available" and installed it over the operator's global
 * 9Router while DXRouter itself stayed exactly where it was.
 *
 * These tests exist because "looks fine" is precisely the failure mode. They are mostly
 * structural: the invariant is that the wrong identity does not appear in the update path
 * at all, which is a property of the source tree, not of one run.
 *
 * Three groups:
 *   1. identity and provenance — the target resolves to DXRouter
 *   2. ownership — a foreign process can never be selected for termination
 *   3. source invariants — the upstream identity and install commands are absent
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * One pass over a source file, returning its string/template literals and the code with
 * comments removed.
 *
 * Both halves are needed and they answer different questions. The literals are the only
 * things a program can *construct* — `/api/version` refusing a name in a comment is
 * documentation, while the same name in a literal is a URL or a command. The
 * comment-free code is for "this file cannot do X at all" assertions, which would
 * otherwise be defeated by the comment explaining that X was removed. Comments are
 * stripped by a scanner that knows about strings rather than line-wise, because a URL in
 * a literal would be truncated at `//` and hide exactly the thing being looked for.
 *
 * Known limitation, shared with `scripts/check-import-boundary.mjs`: a regex literal
 * containing a quote can be misread as the start of a string. That can only invent a
 * literal or lose code after it, never fabricate a passing absence check out of real
 * code that is present before it.
 */
function scanSource(source) {
  const literals = [];
  let code = "";
  let i = 0;
  let line = 1;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") { line += 1; code += ch; i += 1; continue; }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") { line += 1; code += "\n"; }
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const startLine = line;
      let value = "";
      code += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          code += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (source[i] === "\n") line += 1;
        value += source[i];
        code += source[i];
        i += 1;
      }
      code += source[i] ?? "";
      i += 1;
      literals.push({ value, line: startLine });
      continue;
    }
    code += ch;
    i += 1;
  }

  return { literals, code };
}

const extractStringLiterals = (source) => scanSource(source).literals;

/** A file's source with comments removed and string literals left intact. */
const codeOnly = (rel) => scanSource(readSource(rel)).code;

/** The files that decide what this product updates, restarts and kills. */
const UPDATER_PATH = [
  "src/lib/appUpdater.js",
  "src/lib/dxrInstallation.js",
  "src/shared/constants/config.js",
  "src/shared/constants/dxrouterIdentity.js",
  "src/app/api/version/route.js",
  "src/app/api/version/update/route.js",
  "src/shared/components/Sidebar.js",
  "cli/cli.js",
  // Holds the CLI's port default and its OAuth redirect, and resolves the shared data
  // root — so it is on the identity path even though it performs no update itself. Its
  // one `9router` literal is the data-root name, allowlisted below.
  "cli/src/cli/api/client.js",
];

/**
 * The installer that used to live at `src/lib/updater/updater.js`, deleted rather than
 * hardened.
 *
 * It ran `npm i -g <packageName>` in a detached process and could relaunch an arbitrary
 * command afterwards. No app code spawned it — `/api/version/update` refuses — but
 * `cli/scripts/build-cli.js` copied it into the published CLI, where the only thing
 * standing between it and installing the wrong product was one exact-string comparison
 * against the upstream package name. There is no release channel, so there was no correct
 * target for it to install.
 *
 * Named here so the absence is asserted rather than assumed; see the cases at the end of
 * this file.
 */
const DELETED_INSTALLER = "src/lib/updater/updater.js";

// ---------------------------------------------------------------------------
// 1. Identity and provenance
// ---------------------------------------------------------------------------

describe("DXRouter identity", () => {
  it("names DXRouter and records upstream only as a relationship", async () => {
    const { DXR_IDENTITY } = await import("@/shared/constants/dxrouterIdentity.js");

    expect(DXR_IDENTITY.project).toBe("dxrouter");
    expect(DXR_IDENTITY.packageName).toBe("dxrouter");
    expect(DXR_IDENTITY.repository).toBe("https://github.com/iAmAjayTeli/dxrouter.git");
    expect(DXR_IDENTITY.upstream.packageName).toBe("9router");
    expect(DXR_IDENTITY.upstream.repository).toBe("https://github.com/decolua/9router.git");
  });

  it("points its release source at the DXRouter repository, never upstream's", async () => {
    const { DXR_IDENTITY } = await import("@/shared/constants/dxrouterIdentity.js");

    expect(DXR_IDENTITY.releasesApi).toContain("iAmAjayTeli/dxrouter");
    expect(DXR_IDENTITY.changelogUrl).toContain("iAmAjayTeli/dxrouter");
    for (const url of [DXR_IDENTITY.releasesApi, DXR_IDENTITY.releasesPage, DXR_IDENTITY.changelogUrl]) {
      expect(url).not.toContain("decolua");
      expect(url).not.toContain("registry.npmjs.org");
    }
  });

  it("defaults to DXRouter's port and never to upstream's", async () => {
    const { DXR_DEFAULT_APP_PORT } = await import("@/shared/constants/dxrouterIdentity.js");
    const { UPDATER_CONFIG } = await import("@/shared/constants/config.js");

    expect(DXR_DEFAULT_APP_PORT).toBe(20127);
    expect(UPDATER_CONFIG.appPort).toBe(20127);
    expect(UPDATER_CONFIG.appPort).not.toBe(20128);
  });

  it("exposes no installable command or package name at all", async () => {
    const { UPDATER_CONFIG } = await import("@/shared/constants/config.js");

    // Absence is the safety property: there is no self-update channel, so there must be
    // nothing the UI could copy that would install the wrong thing.
    expect(UPDATER_CONFIG.npmPackageName).toBeUndefined();
    expect(UPDATER_CONFIG.installCmd).toBeUndefined();
    expect(UPDATER_CONFIG.installCmdLatest).toBeUndefined();
    expect(UPDATER_CONFIG.statusPort).toBeUndefined();
  });

  it("keeps the data-root name at 9router, which is deliberate and separate", async () => {
    // Renaming the data directory would orphan every existing install's credentials and
    // usage history (see src/lib/dataDir.js). Update identity and data-root identity are
    // different concerns, and this test pins that they were not conflated.
    const { defaultDirName } = { defaultDirName: "9router" };
    expect(readSource("src/lib/dataDir.js")).toContain(`const APP_NAME = "${defaultDirName}"`);
  });
});

describe("installation provenance", () => {
  let tmp;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-provenance-"));
  });

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function makeRepo(name, originUrl) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    if (originUrl) {
      execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir, stdio: "ignore" });
    }
    return dir;
  }

  it("proves a source checkout only when origin is the DXRouter repository", async () => {
    const { describeInstallation } = await import("@/lib/dxrInstallation.js");
    const dir = makeRepo("dxr", "https://github.com/iAmAjayTeli/dxrouter.git");

    const install = describeInstallation({ startDir: dir });
    expect(install.mode).toBe("source-checkout");
    expect(install.selfUpdateAvailable).toBe(false);
    expect(install.message).toMatch(/git/i);
  });

  it("treats a checkout of anything else as unprovable, not as a source checkout", async () => {
    const { describeInstallation } = await import("@/lib/dxrInstallation.js");
    const dir = makeRepo("upstream", "https://github.com/decolua/9router.git");

    // The distinction matters: "it is a git checkout, so pull it" must never mean
    // "pull whatever repository happens to be configured".
    const install = describeInstallation({ startDir: dir });
    expect(install.mode).toBe("unknown");
    expect(install.selfUpdateAvailable).toBe(false);
  });

  it("fails closed when there is no repository to interrogate", async () => {
    const { describeInstallation } = await import("@/lib/dxrInstallation.js");
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir, { recursive: true });

    const install = describeInstallation({ startDir: dir });
    expect(install.mode).toBe("unknown");
    expect(install.appRoot).toBeNull();
    expect(install.message).toMatch(/refus/i);
  });

  it("matches ssh and https spellings of the same remote", async () => {
    const { canonicalRemote } = await import("@/lib/dxrInstallation.js");
    const expected = canonicalRemote("https://github.com/iAmAjayTeli/dxrouter.git");

    expect(canonicalRemote("git@github.com:iAmAjayTeli/dxrouter.git")).toBe(expected);
    expect(canonicalRemote("https://github.com/iAmAjayTeli/dxrouter")).toBe(expected);
    expect(canonicalRemote("https://github.com/decolua/9router.git")).not.toBe(expected);
    expect(canonicalRemote("")).toBeNull();
    expect(canonicalRemote(undefined)).toBeNull();
  });
});

describe("runtime port", () => {
  it("reports the port actually bound, and DXRouter's default otherwise", async () => {
    const { resolveOwnPort } = await import("@/lib/dxrInstallation.js");

    // `resolveOwnPort` answers "what should be displayed". The bound port is
    // authoritative when known, and the default is a reasonable thing to show when it is
    // not — but see the next case: showing it and acting on it are different rights.
    expect(resolveOwnPort({ PORT: "20127" })).toBe(20127);
    expect(resolveOwnPort({ PORT: "30127" })).toBe(30127);
    expect(resolveOwnPort({})).toBe(20127);
    expect(resolveOwnPort({ PORT: "not-a-port" })).toBe(20127);
    expect(resolveOwnPort({ PORT: "0" })).toBe(20127);
    expect(resolveOwnPort({ PORT: "70000" })).toBe(20127);
  });

  it("proves a port only when one was actually configured, never by default", async () => {
    const { resolveProvenPort } = await import("@/lib/dxrInstallation.js");

    // The distinction this pins: `DXR_DEFAULT_APP_PORT` is a convention, not an
    // observation. An instance serving on another port with `PORT` unexported would name
    // 20127, and 20127 then belongs to whoever else is listening there — so a defaulted
    // port must never become evidence that a process is ours.
    expect(resolveProvenPort({ PORT: "20127" })).toBe(20127);
    expect(resolveProvenPort({ PORT: "30127" })).toBe(30127);
    expect(resolveProvenPort({})).toBeNull();
    expect(resolveProvenPort({ PORT: "" })).toBeNull();
    expect(resolveProvenPort({ PORT: "not-a-port" })).toBeNull();
    expect(resolveProvenPort({ PORT: "0" })).toBeNull();
    expect(resolveProvenPort({ PORT: "70000" })).toBeNull();
    expect(resolveProvenPort()).toBeDefined(); // process.env default path must not throw
  });

  it("omits the port ownership signal entirely when no port is proven", async () => {
    const { listOwnedProcesses } = await import("@/lib/dxrInstallation.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-noport-"));

    try {
      const owned = listOwnedProcesses({
        appRoot: path.join(os.tmpdir(), "dxr-ownership-probe-does-not-exist"),
        dataDir,
        env: {}, // no PORT, and no PID file to record one
      });

      // Not "20127": nothing was established, so there is no port to probe and no
      // listener that could be mistaken for ours.
      expect(owned.ownPort).toBeNull();
      expect(owned.portProven).toBe(false);
      // The default is still available for display, just not as evidence.
      expect(owned.reportedPort).toBe(20127);
      expect(owned.pids).toEqual([]);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("accepts a port recorded by a PID file that names our own root", async () => {
    const { listOwnedProcesses } = await import("@/lib/dxrInstallation.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-recordedport-"));
    const root = path.join(os.tmpdir(), "dxr-recorded-root");

    try {
      fs.mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "runtime", "app.pid"),
        JSON.stringify({ pid: 424242, port: 45321, root })
      );

      const owned = listOwnedProcesses({ appRoot: root, dataDir, env: {} });

      // "Recorded by us" is proof in the same way `PORT` is; the record is only honoured
      // because its root matches ours.
      expect(owned.ownPort).toBe(45321);
      expect(owned.portProven).toBe(true);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("ignores a port recorded by a PID file belonging to another root", async () => {
    const { listOwnedProcesses } = await import("@/lib/dxrInstallation.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-foreignport-"));

    try {
      fs.mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "runtime", "app.pid"),
        JSON.stringify({ pid: 424242, port: 45321, root: "D:\\some-other-install" })
      );

      const owned = listOwnedProcesses({
        appRoot: path.join(os.tmpdir(), "dxr-recorded-root"),
        dataDir,
        env: {},
      });

      expect(owned.ownPort).toBeNull();
      expect(owned.portProven).toBe(false);
      expect(owned.pids).not.toContain(424242);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Process ownership
// ---------------------------------------------------------------------------

describe("process ownership", () => {
  /**
   * These command lines were read off this machine with
   * `Get-CimInstance Win32_Process` before the ownership check was written, so the
   * fixtures are what Windows actually reports rather than what it was assumed to report.
   * Two findings shaped the implementation: a Windows Node process is named by its entry
   * script (`…\next\dist\server\lib\start-server.js`), so neither `next-server` nor
   * `cli.js` appears in the command line at all; and the installation root does.
   */
  const OUR_ROOT = "D:\\dxrouter";

  const OURS = [
    // The live DXRouter dev server on 20127, verbatim from WMI.
    "C:\\nvm4w\\nodejs\\node.exe D:\\dxrouter\\node_modules\\next\\dist\\server\\lib\\start-server.js",
    // Its dev-mode parent, which contains a doubled separator mid-path.
    '"node"   "D:\\dxrouter\\node_modules\\.bin\\\\..\\next\\dist\\bin\\next" dev --port 20127',
    // The packaged/standalone spelling.
    "node D:\\dxrouter\\.next-cli-build\\standalone\\server.js",
    // A bare invocation of the checkout itself.
    "node D:\\dxrouter",
  ];

  const NOT_OURS = [
    // Upstream 9Router v0.5.75, installed globally, would run from here on 20128.
    "C:\\nvm4w\\nodejs\\node.exe C:\\nvm4w\\nodejs\\node_modules\\9router\\app\\server.js",
    "node C:\\nvm4w\\nodejs\\node_modules\\9router\\cli.js",
    // Any other Next.js server on the machine — the old `next-server` substring matched
    // all of them, whoever owned them.
    "node /srv/other-project/node_modules/next/dist/server/lib/start-server.js",
    // A sibling directory that merely shares our root as a prefix.
    "node D:\\dxrouter-other\\server.js",
    "node D:\\dxrouter.bak\\server.js",
    "",
  ];

  it("selects only processes running from this installation root", async () => {
    const { isCommandLineInAppRoot } = await import("@/lib/dxrInstallation.js");
    for (const cmd of OURS) expect(isCommandLineInAppRoot(cmd, OUR_ROOT), cmd).toBe(true);
  });

  it("never selects upstream, another project, or a sibling directory", async () => {
    const { isCommandLineInAppRoot } = await import("@/lib/dxrInstallation.js");
    for (const cmd of NOT_OURS) expect(isCommandLineInAppRoot(cmd, OUR_ROOT), cmd).toBe(false);
  });

  /**
   * The leading boundary, which only POSIX roots can violate.
   *
   * Paths are normalised to backslashes before matching, so a POSIX root becomes
   * `\opt\dxrouter` — and an unrelated installation under `/srv/opt/dxrouter` *ends with*
   * that string. Windows is accidentally immune because a drive letter cannot recur
   * mid-path, which is why the Windows sibling fixtures above passed while this case did
   * not: a bare `endsWith` claimed a stranger's process, and `listOwnedProcesses` feeds
   * that straight into a force-kill.
   */
  describe("POSIX root boundaries", () => {
    const POSIX_ROOT = "/opt/dxrouter";

    it("does not claim an unrelated installation whose path ends with our root", async () => {
      const { isCommandLineInAppRoot } = await import("@/lib/dxrInstallation.js");

      for (const cmd of [
        "node /srv/opt/dxrouter/server.js",
        "node /home/u/mirror/opt/dxrouter/app.js",
        "node /var/lib/opt/dxrouter",
        // Trailing boundary, POSIX spelling of the sibling cases above.
        "node /opt/dxrouter-other/server.js",
        "node /opt/dxrouter.bak/server.js",
      ]) {
        expect(isCommandLineInAppRoot(cmd, POSIX_ROOT), cmd).toBe(false);
      }
    });

    it("still claims processes genuinely running from a POSIX root", async () => {
      const { isCommandLineInAppRoot } = await import("@/lib/dxrInstallation.js");

      for (const cmd of [
        "node /opt/dxrouter/server.js",
        "node /opt/dxrouter",
        "/usr/bin/node /opt/dxrouter/node_modules/next/dist/server/lib/start-server.js",
        // A near-miss earlier in the line must not mask a genuine match later in it.
        "node --cwd=/srv/opt/dxrouter /opt/dxrouter/server.js",
      ]) {
        expect(isCommandLineInAppRoot(cmd, POSIX_ROOT), cmd).toBe(true);
      }
    });
  });

  it("refuses a degenerate root rather than matching everything", async () => {
    const { isCommandLineInAppRoot, isUsableAppRoot } = await import("@/lib/dxrInstallation.js");

    expect(isUsableAppRoot("C:\\")).toBe(false);
    expect(isUsableAppRoot("c:")).toBe(false);
    expect(isUsableAppRoot("")).toBe(false);
    expect(isCommandLineInAppRoot("node C:\\anything\\at\\all.js", "C:\\")).toBe(false);
    expect(isCommandLineInAppRoot(OURS[0], "")).toBe(false);
    expect(isCommandLineInAppRoot(OURS[0], null)).toBe(false);
  });

  it("requires a JS runtime, so an editor holding the repo open is not ours", async () => {
    const { isAppRuntimeName } = await import("@/lib/dxrInstallation.js");

    expect(isAppRuntimeName("node.exe")).toBe(true);
    expect(isAppRuntimeName("node")).toBe(true);
    expect(isAppRuntimeName("bun.exe")).toBe(true);
    // VS Code has the repository path in its command line without being part of it.
    expect(isAppRuntimeName("Code.exe")).toBe(false);
    expect(isAppRuntimeName("powershell.exe")).toBe(false);
    expect(isAppRuntimeName("grep")).toBe(false);
  });

  /** The port primitive is what remains when no command line can be trusted. */
  function supportsPortLookup() {
    if (process.platform === "win32") return true;
    try {
      execFileSync("sh", ["-c", "command -v lsof"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  it.runIf(supportsPortLookup())("finds the owner of a port, and only that exact port", async () => {
    const { pidsListeningOnPort } = await import("@/lib/dxrInstallation.js");

    const port = 59987;
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });

    try {
      expect(pidsListeningOnPort(port)).toContain(process.pid);
      // Ports are compared as numbers: 59987 must not be found when 5998 is asked for,
      // which a substring test would report as a match.
      expect(pidsListeningOnPort(5998)).not.toContain(process.pid);
      expect(pidsListeningOnPort(1)).toEqual([]);
      expect(pidsListeningOnPort(0)).toEqual([]);
      expect(pidsListeningOnPort(NaN)).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("excludes this process from its own kill set", async () => {
    const { listOwnedProcesses } = await import("@/lib/dxrInstallation.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-owned-"));

    try {
      // A root and port nothing can match, so the assertion is about the exclusion rule
      // rather than about what happens to be running on the machine.
      const owned = listOwnedProcesses({
        appRoot: path.join(os.tmpdir(), "dxr-ownership-probe-does-not-exist"),
        ownPort: 1,
        dataDir,
      });

      expect(owned.selfPid).toBe(process.pid);
      expect(owned.pids).not.toContain(process.pid);
      expect(owned.pids).toEqual([]);
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("honours a PID file only when it names our own root", async () => {
    const { readAppPidFile } = await import("@/lib/dxrInstallation.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-pidfile-"));

    try {
      const dir = path.join(dataDir, "runtime");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "app.pid");

      // Absent is the normal case, and is never an error.
      expect(readAppPidFile(dataDir)).toBeNull();

      fs.writeFileSync(file, JSON.stringify({ pid: 4242, port: 20127, root: "D:\\dxrouter" }));
      expect(readAppPidFile(dataDir)).toMatchObject({ pid: 4242, root: "D:\\dxrouter" });

      // A bare integer carries no root, so it cannot be attributed and is ignored.
      fs.writeFileSync(file, "4242");
      expect(readAppPidFile(dataDir)).toBeNull();

      fs.writeFileSync(file, "{ not json");
      expect(readAppPidFile(dataDir)).toBeNull();
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The upstream identity is absent from the update path
// ---------------------------------------------------------------------------

describe("update path contains no upstream identity", () => {
  it("builds no install or relaunch command anywhere on the path", () => {
    // No exemption any more. The one file that legitimately ran an installer was deleted,
    // so "an install command exists somewhere on this path" is now unconditionally a bug
    // rather than something to be checked for being gated.
    const offenders = [];
    for (const rel of UPDATER_PATH) {
      for (const { value, line } of extractStringLiterals(readSource(rel))) {
        if (/\bnpm\s+(i|install)\b/i.test(value)) {
          offenders.push(`${rel}:${line} install command → ${value}`);
        }
        if (/\bnpx\b/i.test(value)) {
          offenders.push(`${rel}:${line} npx command → ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lets the upstream name exist only where it is recorded, refused or displayed", () => {
    // Every *constructible* literal mentioning the upstream name, per file, with the
    // reason it is allowed. Comments are not literals, so a file may explain what was
    // removed without failing this. Anything not listed here is a build failure — the
    // next person to reach for the upstream identity has to state why, in this list.
    const ALLOWED = {
      // The canonical record of the fork relationship — the single place the name lives.
      "src/shared/constants/dxrouterIdentity.js": [
        "9router",
        "https://github.com/decolua/9router.git",
      ],
      // (a) the denylist that refuses to install upstream, (b) the data-root directory
      // name, which must stay `9router` or every existing install loses its data.
      // The CLI's data-root fallback, which must agree with the server's, plus two tray
      // notification strings that still carry upstream branding. Those two are
      // user-visible text, not identity: fixing them is a branding pass over the CLI's
      // output, deliberately not mixed into the updater fix. They are pinned here so a
      // third cannot appear unnoticed.
      "cli/cli.js": [
        "9router",
        ".9router",
        "🔔 9Router is running in tray (PID: ${process.pid})",
        "🔔 9Router is now running in background (PID: ${bgProcess.pid})",
      ],
      // The same data-root name, resolved independently because this module runs before
      // the launcher configures anything. A compatibility literal, not an update target:
      // it names a directory on disk, never a package or a repository.
      "cli/src/cli/api/client.js": ["9router"],
      // Upstream's donation page, inherited with the fork. Not an update channel — it is
      // listed here rather than removed so that this test states the one remaining
      // upstream URL in the config, instead of a scroll of the file being the only record.
      "src/shared/constants/config.js": ["https://9router.com/api/donate"],
    };

    const found = {};
    for (const rel of UPDATER_PATH) {
      const hits = extractStringLiterals(readSource(rel))
        .filter(({ value }) => /9router/i.test(value))
        .map(({ value }) => value);
      if (hits.length) found[rel] = [...new Set(hits)].sort();
    }

    const expected = Object.fromEntries(
      Object.entries(ALLOWED).map(([k, v]) => [k, [...new Set(v)].sort()])
    );
    expect(found).toEqual(expected);
  });

  it("has no updater process left to run without an explicit identity", () => {
    // The file this used to interrogate is gone. Asserting its absence is the stronger
    // property: an installer whose guards must be inspected has to keep passing that
    // inspection, whereas one that does not exist cannot be aimed at anything.
    expect(fs.existsSync(path.join(REPO_ROOT, DELETED_INSTALLER))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "src", "lib", "updater"))).toBe(false);
  });

  it("keeps the dashboard free of upstream install text", () => {
    const literals = extractStringLiterals(readSource("src/shared/components/Sidebar.js")).map((l) => l.value);

    for (const value of literals) {
      expect(value).not.toMatch(/9router/i);
      expect(value).not.toMatch(/\bnpm\b/i);
    }
    const raw = readSource("src/shared/components/Sidebar.js");
    expect(raw).not.toContain("ManualUpdatePanel");
    expect(raw).not.toContain("Update now");
    expect(raw).not.toContain("Run 9Router");
  });

  it("asks DXRouter's release channel and nothing else", () => {
    const source = readSource("src/app/api/version/route.js");
    const literals = extractStringLiterals(source).map((l) => l.value);

    expect(source).toContain("DXR_IDENTITY.releasesApi");
    expect(source).not.toContain("NPM_PACKAGE_NAME");
    for (const value of literals) {
      expect(value).not.toContain("registry.npmjs.org");
      expect(value).not.toContain("9router");
      expect(value).not.toContain("npm i ");
      expect(value).not.toContain("npx ");
    }
  });
});

describe("the update route fails closed", () => {
  it("refuses with 409 and performs no kill or spawn", async () => {
    const source = readSource("src/app/api/version/update/route.js");
    const code = codeOnly("src/app/api/version/update/route.js");

    // Structural half: nothing that could terminate or start a process is even imported.
    expect(code).not.toMatch(/\bkillAppProcesses\b/);
    expect(code).not.toMatch(/\bspawnUpdaterAndExit\b/);
    expect(code).not.toMatch(/child_process/);
    expect(code).not.toMatch(/\bnpm\b/i);
    // Every import it does have is one that cannot touch the process table.
    const imports = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/dxrInstallation", "next/server"]);
    // The only status it can produce is the refusal.
    expect([...code.matchAll(/status:\s*(\d+)/g)].map((m) => m[1])).toEqual(["409"]);

    // Behavioural half.
    const { POST } = await import("@/app/api/version/update/route.js");
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.refused).toBe(true);
    expect(typeof body.mode).toBe("string");
    expect(body.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. The version check reports DXRouter's state, with upstream as a non-input
// ---------------------------------------------------------------------------

const httpsState = vi.hoisted(() => ({
  calls: [],
  reply: { kind: "json", status: 200, json: {} },
}));

vi.mock("https", () => ({
  default: {
    get: (url, options, cb) => {
      httpsState.calls.push({ url, options });
      const handlers = {};
      const req = {
        on(event, fn) { handlers[event] = fn; return req; },
        destroy() {},
      };
      const reply = httpsState.reply;
      setImmediate(() => {
        if (reply.kind === "timeout") { handlers.timeout?.(); return; }
        if (reply.kind === "error") { handlers.error?.(new Error("network down")); return; }
        const body = JSON.stringify(reply.json ?? {});
        cb({
          statusCode: reply.status,
          resume() {},
          on(event, fn) {
            if (event === "data" && body) fn(body);
            if (event === "end") fn();
            return this;
          },
        });
      });
      return req;
    },
  },
}));

describe("version check", () => {
  beforeEach(() => {
    // The route caches its release lookup on `global`; clear it so each case starts cold.
    delete global.__dxrReleaseCache;
    httpsState.calls = [];
    httpsState.reply = { kind: "json", status: 200, json: {} };
    vi.resetModules();
  });

  async function getVersion() {
    const { GET } = await import("@/app/api/version/route.js");
    const res = await GET();
    return { body: await res.json(), urls: httpsState.calls.map((c) => c.url) };
  }

  it("queries the DXRouter repository, and only that", async () => {
    const { body, urls } = await getVersion();

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("iAmAjayTeli/dxrouter");
    expect(urls[0]).not.toContain("decolua");
    expect(urls[0]).not.toContain("registry.npmjs.org");
    expect(body.releaseSource).toContain("iAmAjayTeli/dxrouter");
  });

  it("reports no release and no update when DXRouter has published none", async () => {
    httpsState.reply = { kind: "json", status: 404, json: { message: "Not Found" } };
    const { body } = await getVersion();

    expect(body.hasUpdate).toBe(false);
    expect(body.latestVersion).toBeNull();
    expect(body.state).toBe("unavailable");
    expect(body.message).toBe("No DXRouter release available");
  });

  it("fails closed on a server error", async () => {
    httpsState.reply = { kind: "json", status: 500, json: {} };
    expect((await getVersion()).body).toMatchObject({ hasUpdate: false, state: "unavailable" });
  });

  it("fails closed on a timeout", async () => {
    httpsState.reply = { kind: "timeout" };
    expect((await getVersion()).body).toMatchObject({ hasUpdate: false, state: "unavailable" });
  });

  it("fails closed on a transport error", async () => {
    httpsState.reply = { kind: "error" };
    expect((await getVersion()).body).toMatchObject({ hasUpdate: false, state: "unavailable" });
  });

  it("fails closed on an unparseable tag rather than guessing an update", async () => {
    httpsState.reply = { kind: "json", status: 200, json: { tag_name: "nightly" } };
    expect((await getVersion()).body).toMatchObject({ hasUpdate: false, latestVersion: "nightly" });
  });

  it("reports a DXRouter release as available, but still refuses to self-update", async () => {
    httpsState.reply = { kind: "json", status: 200, json: { tag_name: "v9.9.9" } };
    const { body } = await getVersion();

    expect(body.state).toBe("update-available");
    expect(body.hasUpdate).toBe(true);
    expect(body.latestVersion).toBe("9.9.9");
    // Knowing a release exists does not make installing it possible.
    expect(body.canSelfUpdate).toBe(false);
  });

  it("never reports upstream's newest version as an available update", async () => {
    // This is the original failure in one assertion. v0.5.75 is what upstream's npm
    // `latest` was at the fork point, and what the old route reported as available. A
    // payload shaped like the npm registry's — the only shape that used to be read —
    // must not produce an update here.
    httpsState.reply = { kind: "json", status: 200, json: { name: "9router", version: "0.5.75" } };
    const { body, urls } = await getVersion();

    expect(body.hasUpdate).toBe(false);
    expect(body.latestVersion).not.toBe("0.5.75");
    // ...and the registry was never a place this route could have learned it from.
    for (const url of urls) expect(url).not.toContain("npmjs.org");
  });

  it("sends the headers GitHub requires", async () => {
    await getVersion();
    const [{ options }] = httpsState.calls;
    expect(String(options?.headers?.["User-Agent"] ?? "")).toContain("dxrouter");
  });
});

// ---------------------------------------------------------------------------
// 5. The CLI is DXRouter-identified
// ---------------------------------------------------------------------------

describe("CLI identity", () => {
  it("publishes as dxrouter with the DXRouter repository", () => {
    const pkg = JSON.parse(readSource("cli/package.json"));

    expect(pkg.name).toBe("dxrouter");
    expect(pkg.bin).toEqual({ dxrouter: "./cli.js" });
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    expect(url).toContain("iAmAjayTeli/dxrouter");
    // The CLI derives its release source from this manifest, which is why the manifest
    // has to carry it.
    expect(url).not.toContain("decolua");
  });

  it("defaults to port 20127 and derives its release source from its own manifest", () => {
    const source = readSource("cli/cli.js");
    const code = codeOnly("cli/cli.js");

    expect(source).toMatch(/const DEFAULT_PORT\s*=\s*20127;/);
    expect(source).not.toMatch(/const DEFAULT_PORT\s*=\s*20128;/);
    expect(source).toMatch(/REPO_SLUG/);
    expect(source).toMatch(/RELEASES_API/);
    expect(code).not.toContain("registry.npmjs.org");
  });

  it("selects processes by port and PID file, never by name", () => {
    const source = readSource("cli/cli.js");
    const code = codeOnly("cli/cli.js");

    // The sweep that could kill a co-resident installation is gone.
    expect(code).not.toContain("killAllAppProcesses");
    expect(code).not.toContain("killCloudflaredByAppPort");
    expect(code).not.toContain("PROCESS_IDENTIFIERS");
    expect(code).not.toMatch(/["'`]next-server["'`]/);
    expect(code).not.toMatch(/includes\(\s*["']cli\.js["']\s*\)/);
    // The primitives that remain are ownership-based.
    expect(code).toContain("function killProcessOnPort(");
    expect(code).toContain("killAuxiliaryByPidFile");
  });

  it("points its internal API client at the server it starts", () => {
    const code = codeOnly("cli/cli.js");

    // The tunnel check runs before the terminal UI configures the shared client, so
    // without this the CLI asks whichever gateway owns its own default port and reports
    // "no tunnel" whatever the answer. It is also what makes a non-default `--port`
    // reach the client at all.
    expect(code).toMatch(/require\("\.\/src\/cli\/api\/client"\)\.configure\(\{ port \}\)/);
  });

  it("keeps the CLI's three port defaults in agreement", () => {
    // Three files name the port a bare invocation uses: the launcher, the API client the
    // launcher configures, and the `xai video` subcommand (which bypasses the launcher
    // and never touches the client, so it needs its own copy). They were 20128, 20128 and
    // 20128 — upstream's port — while this product's runtime moved to 20127, which is how
    // a subcommand could reach a different installation's gateway. Divergence here is the
    // bug, so the invariant asserted is agreement, not any one value.
    const launcher = readSource("cli/cli.js").match(/const DEFAULT_PORT = (\d+);/);
    const client = readSource("cli/src/cli/api/client.js").match(/port: (\d+),/);
    const subcommand = readSource("cli/src/cli/commands/xaiVideo.js").match(/const DEFAULT_PORT = (\d+);/);

    expect(launcher?.[1]).toBe("20127");
    expect(client?.[1]).toBe(launcher[1]);
    expect(subcommand?.[1]).toBe(launcher[1]);
  });

  it("returns OAuth to this installation's callback, not to a hardcoded port", () => {
    const code = codeOnly("cli/src/cli/api/client.js");

    // The browser lands on this URL, so a literal port sends the authorization code to
    // whichever installation owns it — and a code is single-use, so it arrives already
    // consumed. Derived from the configured port, the redirect follows `--port`.
    expect(code).toContain("`http://localhost:${config.port}/callback`");
    expect(code).not.toMatch(/localhost:20128/);
    // Codex is the one exception: its own client listens on a fixed 1455.
    expect(code).toContain('"http://localhost:1455/auth/callback"');
  });

  it("keeps the CLI's data root in step with the server's", () => {
    // A CLI that resolved a different root would talk to an empty database.
    const source = readSource("cli/cli.js");
    expect(source).toContain('path.join(process.env.APPDATA || "", "9router")');
    expect(source).toContain('path.join(os.homedir(), ".9router")');
    expect(source).toContain("DXR_DATA_DIR");
  });

  /**
   * The CLI compares a GitHub release tag against its own version with its own
   * `compareVersions` — a three-part numeric split, rather than the route's explicit
   * `parseVersion` guard. It is extracted from the source and evaluated here because
   * requiring `cli.js` starts a server, so it cannot simply be imported.
   *
   * What matters is the failure direction. When the differing position is unparseable the
   * comparison yields `NaN`, every `NaN` comparison is false, and the function falls
   * through to 0 — so no update is claimed. That is the same fail-closed outcome the route
   * reaches deliberately, and pinning it matters precisely because here it is incidental:
   * someone "fixing" the `NaN` could easily turn a `nightly` tag into an update prompt.
   *
   * Known imprecision, asserted rather than glossed: a tag whose numeric prefix is
   * genuinely greater does compare greater even with a prerelease suffix, so `1.2.3-beta.4`
   * reads as newer than `0.5.60`. Semver agrees on that pair, and the tag is not being
   * installed — nothing can self-update — so the prompt is the whole consequence.
   */
  it("claims no update from a release tag it cannot parse", () => {
    const source = readSource("cli/cli.js");
    const match = source.match(/function compareVersions\(a, b\) \{[\s\S]*?\n\}/);
    expect(match, "compareVersions not found in cli/cli.js").toBeTruthy();

    const compareVersions = new Function(`${match[0]}; return compareVersions;`)();

    // Ordinary comparisons still work.
    expect(compareVersions("0.5.61", "0.5.60")).toBe(1);
    expect(compareVersions("0.5.60", "0.5.60")).toBe(0);
    expect(compareVersions("0.5.59", "0.5.60")).toBe(-1);

    // Unparseable at the position that decides: must not read as newer. `checkForUpdate`
    // only prompts on `> 0`.
    for (const tag of ["nightly", "latest", "v-broken", "0.5.60-rc1", "0.5.60-beta.1", ""]) {
      expect(compareVersions(tag, "0.5.60"), tag).not.toBe(1);
    }

    // The documented imprecision, stated so a future reader does not mistake it for a bug
    // report: a greater numeric prefix wins before the unparseable part is ever reached.
    expect(compareVersions("1.2.3-beta.4", "0.5.60")).toBe(1);
  });
  it("documents DXRouter's own identity rather than upstream's", () => {
    // The README was the one place left that actively told a user to install the other
    // product: `npm install -g 9router`, `decolua/9router` links, and port 20128 throughout.
    // Following it got you upstream on the wrong port.
    const readme = readSource("cli/README.md");

    expect(readme).not.toMatch(/npm\s+(install|i)\s+-g\s+9router/);
    expect(readme).not.toMatch(/npx\s+9router/);
    expect(readme).not.toContain("20128:20128");
    expect(readme).not.toContain("localhost:20128");
    expect(readme).not.toContain("decolua/9router:latest");
    expect(readme).not.toContain("npmjs.com/package/9router");

    // And says what it is instead.
    expect(readme).toContain("iAmAjayTeli/dxrouter");
    expect(readme).toContain("localhost:20127");

    // `npm i -g dxrouter` must not appear either: that name belongs to an unrelated
    // package on the public registry, so it is not a correct instruction, just a
    // differently wrong one.
    expect(readme).not.toMatch(/npm\s+(install|i)\s+-g\s+dxrouter/);

    // The single surviving upstream link is the fork acknowledgment, which is attribution
    // rather than an instruction.
    const upstreamMentions = [...readme.matchAll(/decolua\/9router/g)];
    expect(upstreamMentions).toHaveLength(1);
  });
});

describe("the deleted installer cannot return through the build", () => {
  it("is absent from the source tree", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, DELETED_INSTALLER))).toBe(false);
  });

  it("is not copied into the published CLI build", () => {
    const build = codeOnly("cli/scripts/build-cli.js");

    // The copy step was the reason a file nothing imported still shipped. Asserting on
    // the build script rather than on a build artefact keeps this runnable without
    // producing one.
    expect(build).not.toMatch(/copyRecursive\(\s*updaterSrc/);
    expect(build).not.toMatch(/["'`]updater["'`]/);
    expect(build).not.toMatch(/updaterSrc|updaterDest/);
  });

  it("leaves no env-configured install target anywhere in the tree", () => {
    // The knobs that aimed it: a package name and the two ports it needed. If any
    // reappears, something is constructing an installer again.
    for (const rel of [...UPDATER_PATH, "cli/scripts/build-cli.js"]) {
      const text = readSource(rel);
      for (const knob of ["UPDATER_PKG_NAME", "UPDATER_PORT", "UPDATER_APP_PORT", "UPDATER_RELAUNCH"]) {
        expect(text, `${rel} mentions ${knob}`).not.toContain(knob);
      }
    }
  });
});

describe("no registry lookup survives anywhere on the update path", () => {
  it("never asks npm what the latest version of anything is", () => {
    const offenders = UPDATER_PATH.filter((rel) => codeOnly(rel).includes("registry.npmjs.org"));
    expect(offenders).toEqual([]);
  });
});
