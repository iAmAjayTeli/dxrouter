/**
 * `sessionObserver` — the host side of M1 observation.
 *
 * This is the only place where a live 9Router request meets the continuity engine in
 * M1, and it is deliberately one-directional: a request goes in, a content-free
 * observation record comes out, and **nothing the caller can route on is returned**
 * (§12). There is no `decide()` here, no candidate list, no provider, no pin. The
 * caller is expected to ignore the return value entirely; it exists so tests and the
 * CLI can see what was recorded.
 *
 * Three host concerns live here because they cannot live in `continuity/` (I1):
 *
 *   - the store handle, opened through `continuityDb.js` (a path, a driver chain);
 *   - the process identity used as the advisory lock owner (`pid`);
 *   - environment: policy overrides, the project-root privacy switch and its salt.
 *
 * ### Fail-open, unconditionally
 *
 * `observeTurn` throws on a real failure, on purpose, so tests can see it. Here that
 * becomes a swallowed warning: an observation may never change a response, and a
 * broken continuity database must degrade to "no observation", never to a failed
 * completion. Every exit path returns a record — `{observed: false, reason}` when
 * something went wrong — and no exit path rethrows.
 */

import { observeTurn } from "../../continuity/session/observer.js";
import { sweepSessions } from "../../continuity/session/sweeper.js";
import { resolveSessionPolicy } from "../../continuity/session/policy.js";
import { formatLockOwner } from "../../continuity/session/locks.js";
import { createClockAdapter } from "./clockAdapter.js";
import { getContinuityStore } from "./continuityDb.js";

const bool = (v, fallback = false) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(s)) return true;
  if (/^(0|false|no|off)$/.test(s)) return false;
  return fallback;
};

const int = (v) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Read the observation settings out of an environment.
 *
 * Pure in `env`, so a test can exercise the privacy branch without touching
 * `process.env`. The salt is read but never logged or returned in a record.
 */
export function resolveObserverEnv(env = process.env) {
  return {
    hashProjectPaths: bool(env.DXR_HASH_PROJECT_PATHS, false),
    projectRootSalt: env.DXR_PROJECT_ROOT_SALT || null,
    projectRoot: env.DXR_PROJECT_ROOT || null,
    policy: resolveSessionPolicy({
      idleTimeoutMs: int(env.DXR_SESSION_IDLE_MS),
      turnRetentionDays: int(env.DXR_TURN_RETENTION_DAYS),
      sessionRetentionDays: int(env.DXR_SESSION_RETENTION_DAYS),
    }),
  };
}

/**
 * Map a `NormalizedRequest` onto the observation input.
 *
 * The rename from `client_hint.session_header` to `session_key` happens here, in the
 * bilingual layer, and it is not cosmetic: the port carries a *hint* taken from client
 * input, and `observeTurn` validates it before it is allowed to name a session. One
 * translation in one place is what keeps `continuity/` from growing a second name for
 * the same field.
 */
export function toObservationRequest(normalized) {
  return {
    tools: normalized.tools,
    system: normalized.system,
    messages: normalized.messages,
    protocol: normalized.protocol,
    model: normalized.requested_model,
    client_hint: {
      session_key: normalized.client_hint?.session_header ?? null,
      project_root: normalized.client_hint?.project_root ?? null,
    },
  };
}

/**
 * Observe one turn. Never throws.
 *
 * @param {object} args
 * @param {object} args.normalized a NormalizedRequest (from `normalizeAdapter`)
 * @param {object} [args.store] an already-open continuity store; opened if absent
 * @param {object} [args.env]
 * @param {{now: () => number}} [args.clock]
 * @param {(msg: string) => void} [args.warn]
 * @returns {Promise<object>} observation record, or `{observed: false, reason}`
 */
export async function observeNormalizedTurn({
  normalized,
  store = null,
  env = process.env,
  clock = createClockAdapter(),
  warn = (msg) => console.warn(`[DXR][sessions] ${msg}`),
} = {}) {
  try {
    if (!normalized || typeof normalized !== "object") return { observed: false, reason: "no_normalized_request" };
    const settings = resolveObserverEnv(env);
    const handle = store || (await getContinuityStore());
    const request = toObservationRequest(normalized);
    if (!request.client_hint.project_root && settings.projectRoot) {
      request.client_hint.project_root = settings.projectRoot;
    }

    return await observeTurn({
      store: handle,
      request,
      clock,
      policy: settings.policy,
      owner: formatLockOwner(process.pid, "dxr"),
      hashProjectPaths: settings.hashProjectPaths,
      projectRootSalt: settings.projectRootSalt,
    });
  } catch (e) {
    // The one rule of this file. A broken observation is a missing row, never a
    // failed request.
    warn(`observation skipped: ${e?.message || e}`);
    return { observed: false, reason: "error", error: e?.message || String(e) };
  }
}

/**
 * Housekeeping (§8, §12.3): close idle sessions, release stale locks, apply retention.
 *
 * Called opportunistically by the host at most once per `sweepIntervalMs`; M1 starts
 * no timer of its own, because a background timer in a Next.js server is a lifecycle
 * problem (dev hot-reload, serverless) that an observation milestone should not own.
 */
export async function sweepContinuity({
  store = null,
  env = process.env,
  clock = createClockAdapter(),
  warn = (msg) => console.warn(`[DXR][sessions] ${msg}`),
} = {}) {
  try {
    const settings = resolveObserverEnv(env);
    const handle = store || (await getContinuityStore());
    return sweepSessions({ store: handle, clock, policy: settings.policy });
  } catch (e) {
    warn(`sweep skipped: ${e?.message || e}`);
    return null;
  }
}

export default observeNormalizedTurn;
