/**
 * Feature flags — the M0 "engine OFF" guarantee.
 *
 * The acceptance gate says the DXR engine must remain off and `accountFallback`
 * must remain authoritative. That is a property of the default resolution, so it is
 * asserted here rather than assumed from the fact that nothing calls the engine.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_FLAGS,
  MILESTONE_FLAGS,
  resolveFlags,
  isEngineDisabled,
  describeFlags,
  unimplementedRequests,
  assertEngineOff,
} from "../../continuity/flags.js";

describe("defaults", () => {
  it("ships the engine off", () => {
    const flags = resolveFlags({});
    expect(flags.engine).toBe("off");
    expect(flags.engineAuthority).toBe(false);
    expect(flags.shadow).toBe(false);
    expect(isEngineDisabled(flags)).toBe(true);
    expect(assertEngineOff(flags)).toBe(true);
  });

  it("ships every milestone gate off", () => {
    const flags = resolveFlags({});
    for (const name of Object.keys(MILESTONE_FLAGS)) {
      expect(flags[name], name).toBe(false);
      expect(DEFAULT_FLAGS[name], name).toBe(false);
    }
  });

  it("requires explicit opt-in for network exposure", () => {
    expect(resolveFlags({}).allowNetwork).toBe(false);
    expect(resolveFlags({ DXR_ALLOW_NETWORK: "1" }).allowNetwork).toBe(true);
  });

  it("is frozen, so nothing can flip a flag at runtime", () => {
    const flags = resolveFlags({});
    expect(Object.isFrozen(flags)).toBe(true);
  });
});

describe("clamping", () => {
  it("cannot grant authority or shadow while the engine is off", () => {
    const flags = resolveFlags({ DXR_ENGINE_AUTHORITY: "1", DXR_SHADOW: "1" });
    // Clamped here rather than at call sites: "engine OFF by default" has to be a
    // property of the code, not of the deployment.
    expect(flags.engineAuthority).toBe(false);
    expect(flags.shadow).toBe(false);
    expect(assertEngineOff(flags)).toBe(true);
  });

  it("keeps an unimplemented milestone gate false even with the engine on", () => {
    const flags = resolveFlags({ DXR_ENGINE: "on", DXR_CACHE_ECONOMICS: "1", DXR_SESSION_INFERENCE: "1" });
    expect(flags.engine).toBe("on");
    expect(flags.cacheEconomics).toBe(false);
    expect(flags.sessionInference).toBe(false);
  });

  it("reads shadow mode from the engine mode itself", () => {
    expect(resolveFlags({ DXR_ENGINE: "shadow" }).shadow).toBe(true);
    expect(resolveFlags({ DXR_ENGINE: "shadow" }).engineAuthority).toBe(false);
  });

  it("treats an unrecognised engine value as off rather than guessing", () => {
    expect(resolveFlags({ DXR_ENGINE: "maybe" }).engine).toBe("off");
    expect(resolveFlags({ DXR_ENGINE: "" }).engine).toBe("off");
  });
});

describe("honesty about unimplemented switches", () => {
  it("reports a requested-but-unshipped flag so nobody thinks it took effect", () => {
    const requests = unimplementedRequests({ DXR_CACHE_ECONOMICS: "1", DXR_DRIFT_SENTINEL: "true" });
    expect(requests.map((r) => r.flag).sort()).toEqual(["cacheEconomics", "driftSentinel"]);
    expect(requests.every((r) => r.milestone.startsWith("M"))).toBe(true);
  });

  it("reports nothing when nothing was requested", () => {
    expect(unimplementedRequests({})).toEqual([]);
  });

  it("declares every milestone gate unimplemented in M0", () => {
    for (const [name, spec] of Object.entries(MILESTONE_FLAGS)) {
      expect(spec.implemented, `${name} must not claim to be implemented in M0`).toBe(false);
    }
  });
});

describe("describeFlags", () => {
  it("summarises the engine state for the startup banner", () => {
    expect(describeFlags(resolveFlags({}))).toBe("engine=off authority=off shadow=off");
  });
});

describe("assertEngineOff", () => {
  it("fails loudly when the engine is on", () => {
    expect(() => assertEngineOff(resolveFlags({ DXR_ENGINE: "on" }))).toThrow(/must be OFF/);
  });
});
