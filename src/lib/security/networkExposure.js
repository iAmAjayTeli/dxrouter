/**
 * Network-exposure policy.
 *
 * M0 rule: binding anywhere other than loopback requires BOTH an explicit
 * opt-in (`DXR_ALLOW_NETWORK=1`) AND authentication left enabled. Any other
 * combination refuses to start rather than silently exposing an unauthenticated
 * LLM gateway (and the provider credentials behind it) to the local network.
 *
 * Everything here is pure — settings are passed in, never imported — so the
 * policy is directly testable and can also be reused by the CLI.
 */

import { SecurityBootstrapError } from "./errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

/**
 * Classify a bind address.
 *
 * `host` is the value the server will pass to `listen()` — `HOSTNAME` for the
 * Next standalone server. When it is unset the classification depends on the
 * runtime default: `next dev` binds loopback, the standalone production server
 * binds `0.0.0.0`.
 *
 * @param {string|undefined} host
 * @param {{ nodeEnv?: string }} [opts]
 * @returns {{ kind: "loopback"|"wildcard"|"specific", host: string, exposed: boolean, assumed: boolean }}
 */
export function classifyBindHost(host, { nodeEnv = process.env.NODE_ENV } = {}) {
  const raw = (host ?? "").trim();

  if (raw === "") {
    const production = nodeEnv === "production";
    return {
      kind: production ? "wildcard" : "loopback",
      host: production ? "0.0.0.0" : "localhost",
      exposed: production,
      assumed: true,
    };
  }

  const normalized = raw.toLowerCase().replace(/^\[|\]$/g, "");

  if (WILDCARD_HOSTS.has(normalized) || WILDCARD_HOSTS.has(raw.toLowerCase())) {
    return { kind: "wildcard", host: raw, exposed: true, assumed: false };
  }
  if (LOOPBACK_HOSTS.has(normalized) || /^127\./.test(normalized)) {
    return { kind: "loopback", host: raw, exposed: false, assumed: false };
  }
  return { kind: "specific", host: raw, exposed: true, assumed: false };
}

/** `DXR_ALLOW_NETWORK` accepts 1/true/yes/on. */
export function isNetworkAllowed(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.DXR_ALLOW_NETWORK ?? "").trim());
}

/**
 * Evaluate the policy without throwing.
 *
 * @param {object} input
 * @param {string|undefined} input.host           bind address (`HOSTNAME`)
 * @param {boolean} input.allowNetwork            `DXR_ALLOW_NETWORK`
 * @param {object|null} input.settings            app settings (may be null if unreadable)
 * @param {string} [input.nodeEnv]
 * @returns {{ ok: boolean, binding: object, reason?: string, remedy?: string, code?: string }}
 */
export function evaluateExposure({ host, allowNetwork, settings, nodeEnv }) {
  const binding = classifyBindHost(host, { nodeEnv });

  if (!binding.exposed) return { ok: true, binding };

  const where = binding.kind === "wildcard" ? `all interfaces (${binding.host})` : `${binding.host}`;
  const assumed = binding.assumed ? " (HOSTNAME is unset; the production server binds all interfaces)" : "";

  if (!allowNetwork) {
    return {
      ok: false,
      binding,
      code: "NETWORK_EXPOSURE_NOT_OPTED_IN",
      reason: `Refusing to start: the server would listen on ${where}${assumed}, exposing the LLM API and the dashboard beyond this machine.`,
      remedy:
        "Bind loopback instead (--host 127.0.0.1, or HOSTNAME=127.0.0.1). " +
        "If network access is genuinely wanted, opt in explicitly with DXR_ALLOW_NETWORK=1 and keep authentication enabled.",
    };
  }

  // Opted in — authentication must still be on. Unreadable settings are treated
  // as unsafe: we cannot prove authentication is enabled.
  if (!settings) {
    return {
      ok: false,
      binding,
      code: "NETWORK_EXPOSURE_SETTINGS_UNKNOWN",
      reason: `Refusing to start: the server would listen on ${where} but its authentication settings could not be read, so authentication cannot be confirmed.`,
      remedy: "Fix the settings store, or bind loopback (HOSTNAME=127.0.0.1) until it is readable.",
    };
  }

  const disabled = [];
  if (settings.requireLogin === false) disabled.push("requireLogin");
  if (settings.requireApiKey === false) disabled.push("requireApiKey");

  if (disabled.length > 0) {
    return {
      ok: false,
      binding,
      code: "NETWORK_EXPOSURE_WITHOUT_AUTH",
      reason:
        `Refusing to start: the server would listen on ${where} with authentication disabled (${disabled.join(", ")} = false). ` +
        "Network exposure requires authentication.",
      remedy:
        `Re-enable ${disabled.join(" and ")} in the dashboard settings, or bind loopback (HOSTNAME=127.0.0.1). ` +
        "These defaults are not weakened for network-exposed instances.",
    };
  }

  return {
    ok: true,
    binding,
    warn: `Network-exposed: listening on ${where}. Authentication is required for every request.`,
  };
}

/**
 * Throwing form used by the startup bootstrap.
 * @throws {SecurityBootstrapError}
 */
export function assertExposureAllowed(input) {
  const result = evaluateExposure(input);
  if (!result.ok) {
    throw new SecurityBootstrapError(result.reason, { code: result.code, remedy: result.remedy });
  }
  return result;
}
