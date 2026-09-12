/**
 * Ordered security bootstrap.
 *
 * Runs once, at Node-runtime startup, before the server accepts traffic:
 *
 *   1. resolve and report the single data root
 *   2. resolve the credential-encryption master key   (refuse if impossible)
 *   3. ensure a dashboard credential exists           (generate + show once)
 *   4. enforce the network-exposure policy            (refuse if unsafe)
 *   5. report the resolved DXR flags
 *
 * Any step that cannot establish a safe state refuses the boot instead of
 * degrading silently. A refusal prints the reason and the remedy, then exits
 * non-zero (tests set `DXR_BOOTSTRAP_NO_EXIT=1` and read the returned report).
 */

import { DATA_DIR, DATA_DIR_SOURCE } from "@/lib/dataDir";
import { SecurityBootstrapError } from "./errors.js";
import { getMasterKeySource, resolveMasterKey } from "./masterKey.js";
import { ensureDashboardCredential } from "./bootstrapCredential.js";
import { assertExposureAllowed, isNetworkAllowed } from "./networkExposure.js";
import { describeFlags, getFlags, warnUnimplementedFlags } from "@/lib/dxr/flags";

function refuse(err) {
  const lines = [
    "",
    "═".repeat(72),
    "  dxrouter refused to start — security precondition not met",
    "═".repeat(72),
    `  ${err.message}`,
  ];
  if (err.remedy) lines.push("", `  How to fix: ${err.remedy}`);
  lines.push("═".repeat(72), "");
  console.error(lines.join("\n"));
}

/**
 * @param {object} [deps] injected for tests; defaults wire the real app.
 * @returns {Promise<{ok: boolean, steps: object, error?: SecurityBootstrapError}>}
 */
export async function runSecurityBootstrap(deps = {}) {
  if (global._dxrSecurityBootstrap) return global._dxrSecurityBootstrap;

  const {
    env = process.env,
    dataDir = DATA_DIR,
    dataDirSource = DATA_DIR_SOURCE,
    loadSettings = null,
    credentialDeps = null,
    exit = (code) => process.exit(code),
  } = deps;

  const steps = {};
  const report = { ok: false, steps };

  try {
    // 1 — data root. One configured root; nothing else may invent a location.
    steps.dataRoot = { path: dataDir, source: dataDirSource };
    console.log(`[dxr] data root: ${dataDir} (from ${dataDirSource})`);

    // 2 — master key. Must exist before any credential is written or read.
    resolveMasterKey();
    steps.masterKey = { source: getMasterKeySource() };
    console.log(`[dxr] credential encryption: AES-256-GCM, key source ${steps.masterKey.source}`);

    // 3 — dashboard credential.
    const cred =
      credentialDeps ??
      (await (async () => {
        const bcrypt = (await import("bcryptjs")).default;
        const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
        return {
          getSettings,
          updateSettings,
          hash: (pw) => bcrypt.hash(pw, 10),
        };
      })());
    steps.credential = await ensureDashboardCredential(cred);

    // 4 — exposure policy. Settings are read through whatever the caller gave
    // us; an unreadable store is treated as "cannot prove auth is on".
    let settings = null;
    try {
      settings = loadSettings ? await loadSettings() : await cred.getSettings();
    } catch {
      settings = null;
    }
    const exposure = assertExposureAllowed({
      host: env.HOSTNAME,
      allowNetwork: isNetworkAllowed(env),
      settings,
      nodeEnv: env.NODE_ENV,
    });
    steps.exposure = { kind: exposure.binding.kind, host: exposure.binding.host };
    if (exposure.warn) console.warn(`[dxr] ${exposure.warn}`);
    else console.log(`[dxr] bind: ${exposure.binding.host} (${exposure.binding.kind}) — not network-exposed`);

    // 5 — flags.
    const flags = getFlags();
    steps.flags = flags;
    if (flags.banner) console.log(`[dxr] flags: ${describeFlags(flags)} (M0: legacy routing is authoritative)`);
    // A switch that this build cannot honour is announced, never silently ignored.
    steps.unimplementedFlags = warnUnimplementedFlags({ env });

    report.ok = true;
  } catch (e) {
    const err = e instanceof SecurityBootstrapError ? e : new SecurityBootstrapError(e?.message || String(e));
    report.error = err;
    refuse(err);
    if (!/^(1|true|yes|on)$/i.test(String(env.DXR_BOOTSTRAP_NO_EXIT ?? ""))) {
      exit(1);
    }
  }

  global._dxrSecurityBootstrap = report;
  return report;
}

/** Test seam: allow the bootstrap to run again. */
export function __resetBootstrap() {
  global._dxrSecurityBootstrap = null;
}
