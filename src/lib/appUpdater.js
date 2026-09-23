import { execFileSync, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { DATA_DIR } from "@/lib/dataDir";
import { listOwnedProcesses } from "@/lib/dxrInstallation";
import { loadPid as loadCloudflaredPid, clearPid as clearCloudflaredPid } from "@/lib/tunnel/cloudflare/pid";
import { TUNNEL_DIR } from "@/lib/tunnel/shared/state";

/**
 * Shutting this installation down without touching anything else on the machine.
 *
 * What was here before selected processes by command-line substring — `9router`,
 * `next-server`, `\bin\app\`, `cli.js` — and killed, by bare name, every `cloudflared` and
 * tray binary on the machine. On a box running DXRouter (port 20127) alongside an upstream
 * 9Router install (port 20128) that is not a heuristic, it is a collision: each install
 * matched the other's processes, `next-server` matched any Next.js process belonging to
 * anyone, and `cli.js` matched any script with that name. Meanwhile it frequently failed
 * to match the process it was aimed at, because a Windows command line names the entry
 * file (`…\next\dist\server\lib\start-server.js`) and never the string `next-server`.
 *
 * So termination now requires provable ownership, in descending order of strength:
 *   · the PID this process spawned (held by whichever caller did the spawning)
 *   · the PID listening on *our own* bound port
 *   · a process running from our own installation root, or recorded in a PID file that
 *     names our root
 * Ownership resolves in `@/lib/dxrInstallation`; this module only carries out the kills.
 *
 * Known limitation: the machine's tray icon is deliberately not killed here. It is spawned
 * by the CLI (`cli/src/cli/tray/`), never by the app, and it is a PowerShell process whose
 * command line names no installation root — so the only way to reach it from here would be
 * the bare-name match that this change exists to remove. Its owner cleans it up.
 */

const KILL_TIMEOUT_MS = 5000;
const PROCESS_WAIT_MS = 1500;

/** The MITM helper may run elevated, so it needs the privileged fallbacks. */
function killPidFile(pidFile) {
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return false;

    if (process.platform === "win32") {
      // taskkill first (works when the helper runs as the same user); the PowerShell
      // fallback can stop a process owned by an elevated token when ours allows it.
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 3000,
        });
      } catch {
        try {
          execFileSync(
            "powershell",
            ["-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Stop-Process -Id ${pid} -Force`],
            { stdio: "ignore", windowsHide: true, timeout: 3000 }
          );
        } catch { /* best effort */ }
      }
    } else {
      try {
        execFileSync("sudo", ["-n", "kill", "-9", String(pid)], {
          stdio: "ignore",
          timeout: 3000,
        });
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Auxiliary helpers this installation started, located through the PID files they write
 * under the configured data root. The data root is what scopes these to us — it belongs to
 * this installation alone, so a PID inside it is ours by construction.
 */
function killAuxiliaryProcesses() {
  const mitmPidFile = path.join(DATA_DIR, "mitm", ".mitm.pid");
  if (killPidFile(mitmPidFile)) {
    try { fs.unlinkSync(mitmPidFile); } catch { /* best effort */ }
  }

  // Cloudflare's own module owns both the path and the record.
  if (loadCloudflaredPid()) {
    killPidFile(path.join(TUNNEL_DIR, "cloudflared.pid"));
    clearCloudflaredPid();
  }

  // Tailscale is driven by the CLI, which records its PID in the same directory.
  const tailscalePidFile = path.join(TUNNEL_DIR, "tailscale.pid");
  if (killPidFile(tailscalePidFile)) {
    try { fs.unlinkSync(tailscalePidFile); } catch { /* best effort */ }
  }
}

function forceKill(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: KILL_TIMEOUT_MS,
      });
    } else {
      execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
    }
  } catch { /* already gone */ }
}

/**
 * Terminate the helper processes and every process provably belonging to this
 * installation.
 *
 * This process is excluded from the result by `listOwnedProcesses` — it is the server that
 * is about to exit, and it must survive long enough to answer the request that asked for
 * the shutdown. The routes that call this schedule their own `process.exit`.
 *
 * Returns the ownership report so callers can log or assert on what was selected.
 */
export async function killAppProcesses() {
  killAuxiliaryProcesses();

  // Resolved once, so the port that is probed and the port that was reported to the
  // operator cannot disagree.
  const owned = listOwnedProcesses();
  for (const proc of owned.processes) forceKill(proc.pid);

  if (owned.pids.length > 0) {
    await new Promise((r) => setTimeout(r, PROCESS_WAIT_MS));
  }

  return owned;
}
