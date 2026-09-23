/**
 * Provenance and process ownership for one DXRouter installation.
 *
 * Server-only: it shells out to `git` and reads the machine's process table, so it must
 * never be reached from a client component. The vocabulary it answers in — `DXR_IDENTITY`,
 * `INSTALLATION_MODE`, `DXR_DEFAULT_APP_PORT` — is pure and lives in
 * `@/shared/constants/dxrouterIdentity`, which is safe on both sides.
 *
 * Two questions, both fail-closed:
 *
 *   `describeInstallation()`  — is this checkout *provably* the DXRouter source checkout?
 *   `listOwnedProcesses()`    — which running processes *provably* belong to it?
 *
 * "Provably" is load-bearing, and it is the whole reason this module exists. The code it
 * replaces selected processes by matching the substrings `9router`, `next-server`,
 * `cli.js`, `cloudflared` and the tray binaries in a command line. On a machine carrying
 * both DXRouter and an upstream 9Router install — which is exactly this operator's
 * machine — every one of those substrings describes *both* installations, so each could
 * terminate the other's server, and `next-server` matched any Next.js process on the box.
 * Nothing here matches on a bare name.
 *
 * Three ownership signals, in descending order of strength:
 *
 *   1. the PID we spawned ourselves (the caller already holds it)
 *   2. the PID listening on a port we can *prove* we bound — never a defaulted one
 *   3. a PID recorded in a PID file under our data root, or a process running from our
 *      own installation root
 *
 * A signal that cannot be established returns "not ours" rather than falling back to a
 * name match.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DXR_DEFAULT_APP_PORT,
  DXR_IDENTITY,
  INSTALLATION_MODE,
} from "@/shared/constants/dxrouterIdentity";
import { DATA_DIR } from "@/lib/dataDir";

const GIT_TIMEOUT_MS = 4000;
const PROCESS_TABLE_TIMEOUT_MS = 8000;
/** How far up from cwd to look for the repository root before giving up. */
const ROOT_SEARCH_DEPTH = 8;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Nearest ancestor of `startDir` holding a `.git` entry, or null.
 *
 * cwd rather than `import.meta.url` on purpose: the same source file is served from the
 * repo root in dev and from a compiled bundle inside a standalone build, so its own
 * location says nothing stable about where the app root is. cwd is set by whatever
 * launched the process, which is the thing we actually want to interrogate.
 */
export function resolveAppRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < ROOT_SEARCH_DEPTH; i += 1) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

function readOriginUrl(appRoot) {
  try {
    const out = execFileSync("git", ["-C", appRoot, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const url = out.trim();
    return url || null;
  } catch {
    // No git binary, not a repository, or no origin — all "cannot prove".
    return null;
  }
}

/**
 * Reduce a remote URL to a comparable form so the ssh and https spellings of the same
 * repository match. Returns null for anything unparseable.
 */
export function canonicalRemote(url) {
  if (typeof url !== "string") return null;
  let value = url.trim();
  if (!value) return null;
  value = value.replace(/^git\+/, "");
  // git@github.com:owner/repo.git → https://github.com/owner/repo
  value = value.replace(/^ssh:\/\/git@/, "https://").replace(/^git@([^:]+):/, "https://$1/");
  value = value.replace(/\.git$/, "").replace(/\/+$/, "");
  return value.toLowerCase() || null;
}

const REFUSAL_MESSAGE = Object.freeze({
  [INSTALLATION_MODE.SOURCE_CHECKOUT]:
    "DXRouter is running from a source checkout. Self-update is disabled; update this " +
    "checkout with git.",
  [INSTALLATION_MODE.UNKNOWN]:
    "This installation's DXRouter identity could not be verified against the git remote, " +
    "so no update target can be trusted. Refusing to update.",
});

/**
 * Provenance of the running installation, plus the reason to give the operator when an
 * update is refused.
 *
 * Source checkout is claimed only when the git remote *is* the DXRouter repository. A
 * checkout of something else (upstream, a mirror, a fork of a fork) is `UNKNOWN`, not
 * source checkout — the distinction is what stops "it's a git checkout, so update it"
 * from ever meaning "pull someone else's code over this one".
 *
 * Not memoised: `git config` is a few milliseconds, this runs on the version-check and
 * update paths only, and a cached verdict would leak between tests.
 */
export function describeInstallation({ startDir = process.cwd() } = {}) {
  const appRoot = resolveAppRoot(startDir);
  const originUrl = appRoot ? readOriginUrl(appRoot) : null;
  const expected = canonicalRemote(DXR_IDENTITY.repository);
  const actual = canonicalRemote(originUrl);

  const mode =
    appRoot && actual && actual === expected
      ? INSTALLATION_MODE.SOURCE_CHECKOUT
      : INSTALLATION_MODE.UNKNOWN;

  return {
    mode,
    appRoot,
    originUrl,
    expectedOrigin: DXR_IDENTITY.repository,
    message: REFUSAL_MESSAGE[mode],
    /**
     * Always false today. Kept as an explicit field rather than letting callers infer it
     * from `mode`, so that the day a release channel exists there is one place to change
     * and every existing caller is already reading the flag instead of guessing.
     */
    selfUpdateAvailable: false,
  };
}

// ---------------------------------------------------------------------------
// Runtime identity
// ---------------------------------------------------------------------------

/**
 * The port to *report*: `PORT`, else the DXRouter default.
 *
 * Safe to display, unsafe to act on. Use `resolveProvenPort` for anything that selects a
 * process — see the note there.
 */
export function resolveOwnPort(env = process.env) {
  const parsed = Number.parseInt(env?.PORT ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return DXR_DEFAULT_APP_PORT;
}

/**
 * The port this instance can *prove* it bound, or null.
 *
 * Separate from `resolveOwnPort` because the two answer different questions and only one
 * of them may reach a kill. "Which port should the dashboard show" tolerates a default;
 * "which listener is definitely ours" does not. `DXR_DEFAULT_APP_PORT` is a convention,
 * not an observation: an instance serving on another port with `PORT` unexported would
 * name 20127, and 20127 would then belong to whoever else is listening there. That is the
 * ownership mistake this module exists to prevent, one layer below the name matching it
 * already removed — and `dxrouterIdentity.js` says so in the constant's own contract
 * ("nothing may assume this default when asking 'is our server still up'").
 *
 * Proof is an explicit `PORT`. A port recorded in a PID file that names our own root also
 * counts, and `listOwnedProcesses` adds that case. Absent any proof the answer is null and
 * the caller must drop the port signal, which costs a signal rather than a stranger's
 * process.
 */
export function resolveProvenPort(env = process.env) {
  const parsed = Number.parseInt(env?.PORT ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return null;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** Lowercase, `/` → `\`, drop trailing separators and wrapping quotes. */
export function normalizePathLike(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/\//g, "\\")
    .toLowerCase()
    .replace(/\\+$/, "");
}

const DRIVE_ROOT = /^[a-z]:\\?$/;

/**
 * A root is only usable as a matcher if it is a real path below a filesystem root.
 * A degenerate value — empty, `C:\`, a bare word — would match everything, so it is
 * rejected rather than trusted. Same reasoning for the empty command line.
 */
export function isUsableAppRoot(appRoot) {
  const root = normalizePathLike(appRoot);
  return root.length >= 4 && !DRIVE_ROOT.test(root);
}

/**
 * Characters that may sit immediately before the root in a command line.
 *
 * A command line is not a path. The root is normally preceded by whitespace
 * (`node D:\dxrouter\…`) or by `=` (`--dir=D:\dxrouter`), so a literal "must be preceded
 * by a path separator" rule would reject every real process on Windows. What must be
 * rejected is a preceding *name* character, because that means the match is the tail of a
 * longer directory name.
 *
 * A separator is deliberately NOT a boundary. `resolveAppRoot` only ever returns an
 * absolute path, so the root already carries its own leading separator; a `\` in front of
 * it means the segment continues leftwards and the match is somebody else's directory.
 * That is precisely the case this rule was added for: normalised to `\opt\dxrouter`, the
 * unrelated install `/srv/opt/dxrouter` ends with our root, and a bare `endsWith` claimed
 * it. Windows was accidentally safe because a drive letter cannot recur mid-path; POSIX
 * was not, and `listOwnedProcesses` feeds this straight into a force-kill.
 *
 * The single quote is written as `\x27` and the double quote is absent on purpose. Double
 * quotes are already stripped from the haystack below, so one can never be the preceding
 * character; and a quote character inside this regex literal would be misparsed as the
 * start of a string by the source scanner in `tests/unit/dxr-updater-identity.test.js`,
 * which documents that limitation.
 */
const ROOT_BOUNDARY_BEFORE = /[\s\x27=;,]/;

/**
 * Does this command line belong to the installation rooted at `appRoot`?
 *
 * Root-qualified, never name-qualified: an upstream install at
 * `C:\nvm4w\nodejs\node_modules\9router` does not contain `d:\dxrouter`, and neither
 * does a Next.js server belonging to some other project.
 *
 * The match is bounded on both sides. `D:\dxrouter-other` and `D:\dxrouter.bak` are
 * rejected by the trailing test, `/srv/opt/dxrouter` by the leading one — the same class
 * of mistake as the name matching this module replaced, one directory level down.
 */
export function isCommandLineInAppRoot(commandLine, appRoot) {
  if (typeof commandLine !== "string" || !commandLine) return false;
  if (!isUsableAppRoot(appRoot)) return false;
  const root = normalizePathLike(appRoot);
  // Quotes are removed from the haystack as well as its ends: a quoted path such as
  // `"D:\dxrouter\node_modules\..."` would otherwise break the trailing-boundary test.
  const haystack = normalizePathLike(commandLine).replace(/"/g, "");

  // Every occurrence is tested, not just the first: a near-miss earlier in the line must
  // not mask a genuine match later in it (`--cwd=C:\other D:\dxrouter\server.js`).
  for (let at = haystack.indexOf(root); at !== -1; at = haystack.indexOf(root, at + 1)) {
    const startsCleanly = at === 0 || ROOT_BOUNDARY_BEFORE.test(haystack[at - 1]);
    const after = haystack[at + root.length];
    const endsCleanly = after === undefined || after === "\\";
    if (startsCleanly && endsCleanly) return true;
  }
  return false;
}

/** Runtimes that can host this app. Deliberately excludes editors and shells, which can
 * have the repository path in argv without being part of the installation. */
const APP_RUNTIME_NAME = /^(node|bun)(\.exe)?$/i;

export function isAppRuntimeName(name) {
  return APP_RUNTIME_NAME.test(String(name || "").trim());
}

function parseJsonLoose(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Every process on the machine as `{ pid, name, commandLine }`.
 *
 * Returns [] on any failure. An unreadable process table means "no process is provably
 * ours", which kills nothing — the correct direction to fail.
 *
 * JSON rather than the CSV/tab formats used elsewhere: a Windows command line can contain
 * the delimiters those formats rely on, and a mis-split row is a wrong PID.
 */
function listProcesses() {
  if (process.platform === "win32") {
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | " +
      "ConvertTo-Json -Compress -Depth 3";
    let raw;
    try {
      raw = execSync(
        `powershell -NonInteractive -NoProfile -WindowStyle Hidden -Command "${script}"`,
        { encoding: "utf8", timeout: PROCESS_TABLE_TIMEOUT_MS, windowsHide: true }
      );
    } catch {
      return [];
    }
    const parsed = parseJsonLoose(raw);
    if (!parsed) return [];
    // PowerShell 5.1 emits a bare object rather than a one-element array for a single row.
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row?.ProcessId),
        name: String(row?.Name || ""),
        commandLine: String(row?.CommandLine || ""),
      }))
      .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  }

  let raw;
  try {
    raw = execSync("ps -eo pid=,comm=,args=", {
      encoding: "utf8",
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    });
  } catch {
    return [];
  }
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), name: match[2], commandLine: match[3] };
    })
    .filter((row) => row && Number.isInteger(row.pid) && row.pid > 0);
}

/** PIDs with a listener on `port`, on loopback or otherwise. Port-compared, not
 * substring-matched, so `:20127` never matches `:201270`. */
export function pidsListeningOnPort(port) {
  const wanted = Number(port);
  if (!Number.isInteger(wanted) || wanted <= 0) return [];
  const found = new Set();

  if (process.platform === "win32") {
    let raw;
    try {
      raw = execSync("netstat -ano -p tcp", {
        encoding: "utf8",
        timeout: PROCESS_TABLE_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      return [];
    }
    for (const line of String(raw).split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const [proto, local, , state, pid] = parts;
      if (!/^tcp/i.test(proto)) continue;
      if (state !== "LISTENING") continue;
      const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
      if (localPort !== wanted) continue;
      if (Number.isInteger(Number(pid))) found.add(Number(pid));
    }
    return [...found];
  }

  try {
    const raw = execSync(`lsof -ti:${wanted} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    });
    for (const line of String(raw).split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid)) found.add(pid);
    }
  } catch {
    // lsof absent or nothing listening.
  }
  return [...found];
}

/**
 * Optional PID file recording the app server this installation started:
 * `<data root>/runtime/app.pid`, JSON `{ pid, port, root }`.
 *
 * Honoured only when its recorded `root` is our own root, so a stale file from another
 * installation cannot nominate a process for termination. Nothing writes it today — own
 * PID and own port already cover every path — so its absence is normal and never an
 * error.
 */
export function readAppPidFile(dataDir = DATA_DIR) {
  try {
    const file = path.join(dataDir, "runtime", "app.pid");
    if (!fs.existsSync(file)) return null;
    const parsed = parseJsonLoose(fs.readFileSync(file, "utf8"));
    const pid = Number(parsed?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, port: Number(parsed?.port) || null, root: parsed?.root ?? null };
  } catch {
    return null;
  }
}

/**
 * Processes provably belonging to this installation.
 *
 * The caller's own PID is always excluded — the server that asks for this is the process
 * that exits next on its own schedule, and `taskkill /F` on yourself truncates the HTTP
 * response the dashboard is waiting for.
 */
export function listOwnedProcesses({
  appRoot,
  ownPort,
  dataDir = DATA_DIR,
  excludePids = [],
  env = process.env,
} = {}) {
  const root = appRoot ?? describeInstallation().appRoot;
  const recorded = readAppPidFile(dataDir);
  const rootMatchesRecord = Boolean(
    recorded && isUsableAppRoot(root) && normalizePathLike(recorded.root) === normalizePathLike(root)
  );

  // Proven, never assumed. An explicit `ownPort` is the caller's own proof; otherwise
  // `PORT`; otherwise a port recorded by a PID file that names our root. `null` means
  // there is no port signal, and losing a signal is the correct cost — the alternative is
  // probing `DXR_DEFAULT_APP_PORT` on an instance that never bound it and killing whoever
  // did. See `resolveProvenPort`.
  const port =
    ownPort ?? resolveProvenPort(env) ?? (rootMatchesRecord && recorded.port ? recorded.port : null);
  const portProven = Number.isInteger(port) && port > 0;
  const self = process.pid;
  const excluded = new Set([self, ...excludePids].map(Number).filter(Number.isInteger));

  const owned = new Map();
  const add = (pid, source) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (excluded.has(pid)) return;
    if (!owned.has(pid)) owned.set(pid, { pid, sources: [] });
    owned.get(pid).sources.push(source);
  };

  // (2) the listener on our own port — the strongest signal available to the app itself,
  // but only once the port is established rather than defaulted.
  if (portProven) {
    for (const pid of pidsListeningOnPort(port)) add(pid, "own-port");
  }

  // (3) processes running out of our installation root.
  for (const proc of listProcesses()) {
    if (!isAppRuntimeName(proc.name)) continue;
    if (!isCommandLineInAppRoot(proc.commandLine, root)) continue;
    add(proc.pid, "app-root");
  }

  // (3, weaker) a root-qualified PID file we or the CLI left behind.
  if (rootMatchesRecord) add(recorded.pid, "pid-file");

  return {
    appRoot: root,
    /** The proven port, or null when none could be established. */
    ownPort: portProven ? port : null,
    portProven,
    /** What to show an operator, which may be the default. Never an ownership signal. */
    reportedPort: resolveOwnPort(env),
    selfPid: self,
    processes: [...owned.values()],
    pids: [...owned.keys()],
  };
}
