import { UPDATER_CONFIG } from "@/shared/constants/config";

/**
 * The local port a tunnel should point at.
 *
 * Both tunnel managers took `localPort = 20128` as a default parameter, and no caller
 * anywhere passes a port — `enableTunnel()` and `enableTailscale()` are called bare from
 * the two API routes and from both `safeRestart*` paths in `initializeApp`. So that
 * default was not a fallback, it was the only source of the value, and it named upstream
 * 9Router's port: `cloudflared tunnel --url http://127.0.0.1:20128` published a tunnel to
 * a port DXRouter does not listen on, or — worse, on a host running both — to the other
 * installation.
 *
 * `PORT` first because it is what the process was actually told to bind: the CLI sets it
 * when spawning the server (`cli/cli.js`) and the container image sets it, so in both
 * shipped launch paths this is a real observation. `npm start` passes `--port` as argv to
 * Next instead, so `PORT` may be absent there; the canonical constant is the answer then.
 *
 * Deliberately NOT `resolveOwnPort()` from `@/lib/dxrInstallation`, even though the
 * arithmetic is identical: that module shells out to `git` and reads the process table for
 * ownership decisions, and a tunnel has no business pulling that into its import graph.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} a usable TCP port, never NaN and never a string
 */
export function resolveLocalAppPort(env = process.env) {
  const parsed = Number.parseInt(env?.PORT ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return UPDATER_CONFIG.appPort;
}
