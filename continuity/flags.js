/**
 * Feature flags for the Continuity Engine.
 *
 * Pure: `resolveFlags` takes an environment-shaped object and returns a frozen
 * descriptor. Nothing here reads `process` — that is the app side's job
 * (`src/lib/dxr/flags.js`), which keeps `continuity/**` free of host imports
 * (invariant I1).
 *
 * M0 ships every *engine* switch OFF, and M1 does not change that: the legacy
 * 9Router selection walk remains authoritative and no flag here can make the engine
 * decide anything.
 *
 * M1 and M2 each add exactly one switch that is not clamped by the engine mode:
 * `sessions` and `cacheTracking`.
 * Session observation writes hashes, grades and counts into the continuity database
 * and returns nothing the request path can route on, so gating it behind an engine
 * that is off by definition would leave M1 dead code with no way to exercise it.
 * §20 gives M1 the rollback `DXR_SESSIONS=off`, which only means something if
 * observation is on by default. Whether the *engine* may consume that identity in a
 * decision is a separate, still-clamped gate (`sessionInference`, below).
 *
 * A third clamped switch, `usageFieldEvidence`, is off by default and is not a
 * milestone gate at all: it asks the host adapters to keep one raw sample of each
 * provider's usage *field shape* on disk, which is the only way to settle whether a
 * spelling in the adapter's usage vocabulary is real. Off by default because it writes
 * a file per provider on the response path, and clamped by nothing because it is a
 * diagnostic an operator turns on to answer a question about the observer itself.
 *
 * M2 adds `cacheTracking` for the same reason and with the same shape: recording what
 * a provider reported about its own cache is an observation, not a decision, and §20
 * gives M2 the rollback `DXR_CACHE_TRACKING=off`, which is only a rollback if the
 * observation is on by default. Whether cache economics may *enter* a decision stays
 * clamped behind `cacheEconomics`, which M3 owns.
 */

/** @typedef {"off"|"shadow"|"on"} EngineMode */

const MODES = new Set(["off", "shadow", "on"]);

function mode(value, fallback = "off") {
  const v = String(value ?? "").trim().toLowerCase();
  if (MODES.has(v)) return v;
  if (/^(1|true|yes|on)$/.test(v)) return "on";
  if (/^(0|false|no)$/.test(v)) return "off";
  return fallback;
}

function bool(value, fallback = false) {
  const v = String(value ?? "").trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(v)) return true;
  if (/^(0|false|no|off)$/.test(v)) return false;
  return fallback;
}

export const DEFAULT_FLAGS = Object.freeze({
  /** Engine construction. `off` in M0: nothing is instantiated on the request path. */
  engine: "off",
  /** Whether the engine's decision may be acted on. Never true while `engine` is off. */
  engineAuthority: false,
  /** Record engine-vs-legacy comparisons without acting. Requires `engine !== "off"`. */
  shadow: false,
  /** Explicit opt-in to non-loopback binding (mirrored here for a single flag surface). */
  allowNetwork: false,
  /** Emit the resolved-flag banner at startup. */
  banner: true,
  /**
   * M1: observe session identity and prefix layers on the request path.
   *
   * On by default and deliberately NOT clamped by `engine`, because observation is
   * not a decision: it records hashes, grades and token counts and returns nothing
   * the caller could route on (§12). `DXR_SESSIONS=off` is the M1 rollback.
   */
  sessions: true,
  /**
   * M2: record observed cache state and provider-reported cache usage.
   *
   * Same reasoning as `sessions`: this writes token counts, confidences and hashes
   * and returns nothing the caller could route on. `DXR_CACHE_TRACKING=off` is the
   * M2 rollback. It does not price anything into a decision — that is
   * `cacheEconomics`, which stays clamped until M3.
   */
  cacheTracking: true,
  /**
   * Diagnostic: keep one raw, numbers-only sample of each provider's usage field
   * shape under `<data root>/evidence/usage-fields/`.
   *
   * Off by default — it writes to disk from the response path, and nothing in normal
   * operation needs it. It is the evidence behind `adapters/ninerouter/usageFields.js`:
   * without it, a provider spelling this repository has never seen is indistinguishable
   * from a provider that reported nothing. `DXR_USAGE_FIELD_EVIDENCE=1` turns it on.
   */
  usageFieldEvidence: false,
  // ── Per-milestone capability gates ───────────────────────────────────────────
  // Each later milestone lands behind its own switch so an unfinished capability
  // can ship in a release without any chance of reaching traffic. All default off
  // and all are clamped off while `engine` is off.
  /**
   * Engine consumption of session identity in a decision. Distinct from `sessions`
   * above: M1 *derives* identity (implemented, on by default) but nothing consumes
   * it, because M1 produces no Decision at all. This gate unlocks with the first
   * milestone that lets identity influence a route, so it stays unimplemented here.
   */
  sessionInference: false,
  /** M2: confirm cache semantics per (provider, model) with probes. */
  compatProbes: false,
  /** M2: price cache hits into the decision (STAY / MOVE / WAIT). */
  cacheEconomics: false,
  /** M4: replay a session onto a different provider. */
  sessionRebase: false,
  /** M4: watch for silent model substitution and capability drift. */
  driftSentinel: false,
});

/**
 * Env var per milestone gate, and the milestone that implements it.
 *
 * `implemented` is the second key: a switch is only honoured once the code behind
 * it exists. In M0 every entry is `false`, so `DXR_CACHE_ECONOMICS=1` resolves to
 * `false` and is reported at startup as having no effect — rather than reading as
 * "on" while nothing happens. Flipping an entry belongs in the same commit as the
 * behaviour it unlocks.
 */
export const MILESTONE_FLAGS = Object.freeze({
  // Identity *derivation* landed in M1 under the top-level `sessions` flag. This
  // entry gates the engine acting on it, which no milestone before M2 does, so
  // `implemented` stays false and `DXR_SESSION_INFERENCE=1` is still reported at
  // startup as having no effect rather than reading as "on".
  sessionInference: { env: "DXR_SESSION_INFERENCE", milestone: "M2", implemented: false },
  compatProbes: { env: "DXR_COMPAT_PROBES", milestone: "M2", implemented: false },
  cacheEconomics: { env: "DXR_CACHE_ECONOMICS", milestone: "M2", implemented: false },
  sessionRebase: { env: "DXR_SESSION_REBASE", milestone: "M4", implemented: false },
  driftSentinel: { env: "DXR_DRIFT_SENTINEL", milestone: "M4", implemented: false },
});

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<typeof DEFAULT_FLAGS>}
 */
export function resolveFlags(env = {}) {
  const engine = mode(env.DXR_ENGINE, DEFAULT_FLAGS.engine);

  // Authority and shadow are meaningless — and unsafe — with no engine.
  // Clamping here (rather than trusting callers) is what makes "DXR engine OFF
  // by default" a property of the code and not of the deployment.
  const engineAuthority = engine === "off" ? false : bool(env.DXR_ENGINE_AUTHORITY, false);
  const shadow = engine === "off" ? false : bool(env.DXR_SHADOW, engine === "shadow");

  const milestones = {};
  for (const [flag, spec] of Object.entries(MILESTONE_FLAGS)) {
    // Three conditions, all required: implemented, requested, engine running.
    milestones[flag] = spec.implemented && engine !== "off" && bool(env[spec.env], false);
  }

  return Object.freeze({
    engine,
    engineAuthority,
    shadow,
    // Not clamped by `engine`: see the module header. An operator turning the engine
    // off must still get session observation, and an operator turning observation off
    // must get silence from M1 regardless of engine mode.
    sessions: bool(env.DXR_SESSIONS, DEFAULT_FLAGS.sessions),
    cacheTracking: bool(env.DXR_CACHE_TRACKING, DEFAULT_FLAGS.cacheTracking),
    // Unclamped like the two above, and for the same reason: it observes, and an
    // operator diagnosing the observer must be able to turn it on with the engine off.
    usageFieldEvidence: bool(env.DXR_USAGE_FIELD_EVIDENCE, DEFAULT_FLAGS.usageFieldEvidence),
    allowNetwork: bool(env.DXR_ALLOW_NETWORK, DEFAULT_FLAGS.allowNetwork),
    banner: bool(env.DXR_FLAG_BANNER, DEFAULT_FLAGS.banner),
    ...milestones,
  });
}

/**
 * Switches an operator asked for that this build cannot honour.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{flag: string, env: string, milestone: string}>}
 */
export function unimplementedRequests(env = {}) {
  const out = [];
  for (const [flag, spec] of Object.entries(MILESTONE_FLAGS)) {
    if (!spec.implemented && bool(env[spec.env], false)) {
      out.push({ flag, env: spec.env, milestone: spec.milestone });
    }
  }
  return out;
}

/**
 * The M0 acceptance condition stated as an assertion rather than assumed: the
 * engine is off and no milestone gate is active.
 */
export function assertEngineOff(flags) {
  if (!isEngineDisabled(flags)) {
    throw new Error(`DXR engine must be OFF in M0, but engine=${flags.engine}`);
  }
  const active = Object.keys(MILESTONE_FLAGS).filter((f) => flags[f] === true);
  if (active.length > 0) {
    throw new Error(`DXR engine is off but these milestone flags resolved true: ${active.join(", ")}`);
  }
  return true;
}

/** True when the engine must not be consulted at all (the M0 state). */
export function isEngineDisabled(flags) {
  return !flags || flags.engine === "off";
}

/** Human-readable one-liner for the startup banner. */
export function describeFlags(flags) {
  const base = `engine=${flags.engine} authority=${flags.engineAuthority ? "on" : "off"} shadow=${flags.shadow ? "on" : "off"}`;
  // Only mentioned when they deviate from the default, so the banner keeps saying what
  // is unusual rather than growing a field per milestone.
  const off = [];
  if (flags.sessions === false) off.push("sessions=off");
  if (flags.cacheTracking === false) off.push("cacheTracking=off");
  if (flags.usageFieldEvidence === true) off.push("usageFieldEvidence=on");
  return off.length ? `${base} ${off.join(" ")}` : base;
}
