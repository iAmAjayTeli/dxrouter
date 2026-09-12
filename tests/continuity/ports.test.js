/**
 * The five ports — contract enforcement.
 *
 * A port's job is to fail at wiring time instead of on the first real request, so
 * these tests are mostly about what the factories *reject*. Anything a port accepts
 * silently becomes an engine assumption, and I3 says an assumption is not a fact.
 */

import { describe, it, expect } from "vitest";

import {
  PORTS,
  PROTOCOLS,
  PortContractError,
  ERROR_CLASSES,
  createNormalizedRequest,
  isNormalizedRequest,
  createRoute,
  assertExecutionResult,
  defineRouteExecutor,
  createConnectionDescriptor,
  defineCredentialStore,
  createModelDescriptor,
  defineCatalog,
  defineClock,
  fixedClock,
  systemClock,
} from "../../continuity/ports/index.js";

const baseRequest = {
  protocol: "openai",
  requested_model: "gpt-5",
  messages: [{ role: "user", content: "hi" }],
  arrived_at: 1_700_000_000_000,
};

describe("the port surface", () => {
  it("names exactly the five ports", () => {
    expect([...PORTS]).toEqual(["NormalizedRequest", "RouteExecutor", "CredentialStore", "Catalog", "Clock"]);
  });
});

describe("NormalizedRequest", () => {
  it("accepts a minimal request and freezes it", () => {
    const req = createNormalizedRequest(baseRequest);
    expect(Object.isFrozen(req)).toBe(true);
    expect(Object.isFrozen(req.messages)).toBe(true);
    expect(Object.isFrozen(req.params)).toBe(true);
    expect(req.tools).toBeNull();
    expect(req.system).toBeNull();
    expect(req.params.stream).toBe(false);
  });

  it("copies the arrays it is given, so a later mutation cannot change a hashed request", () => {
    const messages = [{ role: "user", content: "hi" }];
    const req = createNormalizedRequest({ ...baseRequest, messages });
    messages.push({ role: "user", content: "and again" });
    expect(req.messages).toHaveLength(1);
  });

  it("rejects an unknown protocol", () => {
    expect(() => createNormalizedRequest({ ...baseRequest, protocol: "kiro" })).toThrow(PortContractError);
  });

  it("accepts every declared protocol", () => {
    for (const protocol of PROTOCOLS) {
      expect(() => createNormalizedRequest({ ...baseRequest, protocol })).not.toThrow();
    }
  });

  it("rejects a missing messages array", () => {
    expect(() => createNormalizedRequest({ ...baseRequest, messages: undefined })).toThrow(/messages must be an array/);
  });

  it("rejects a non-numeric arrived_at — time must come from the Clock port", () => {
    expect(() => createNormalizedRequest({ ...baseRequest, arrived_at: "2026-01-01" })).toThrow(/arrived_at/);
    expect(() => createNormalizedRequest({ ...baseRequest, arrived_at: NaN })).toThrow(/arrived_at/);
  });

  it("reports contract violations with a port and a field", () => {
    try {
      createNormalizedRequest({ ...baseRequest, requested_model: "" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.code).toBe("PORT_CONTRACT_VIOLATION");
      expect(e.port).toBe("NormalizedRequest");
      expect(e.field).toBe("requested_model");
    }
  });

  it("isNormalizedRequest never throws", () => {
    expect(isNormalizedRequest(baseRequest)).toBe(true);
    expect(isNormalizedRequest(null)).toBe(false);
    expect(isNormalizedRequest({ protocol: "nope" })).toBe(false);
  });

  // M1 widened `client_hint` with `project_root` (invariant I1: the engine cannot read
  // a cwd, so the host passes the root in). The contract is three named scalars, and
  // the test that matters is the negative one — a header bag must not ride along, or
  // the store would start accumulating whatever a client chose to send.
  it("carries exactly the three named client hints and drops anything else", () => {
    const req = createNormalizedRequest({
      ...baseRequest,
      client_hint: {
        session_header: "cc-explicit",
        user_agent: "claude-code/1.2.3",
        project_root: "/repo/dxrouter",
        authorization: "Bearer sk-should-never-cross",
        cookie: "session=abc",
      },
    });
    expect(Object.keys(req.client_hint).sort()).toEqual(["project_root", "session_header", "user_agent"]);
    expect(req.client_hint.project_root).toBe("/repo/dxrouter");
    expect(Object.isFrozen(req.client_hint)).toBe(true);
    expect(JSON.stringify(req)).not.toContain("sk-should-never-cross");
  });

  it("leaves the hints undefined when the host supplies none", () => {
    const req = createNormalizedRequest(baseRequest);
    expect(req.client_hint.project_root).toBeUndefined();
    expect(req.client_hint.session_header).toBeUndefined();
  });
});

describe("RouteExecutor", () => {
  it("builds a frozen route", () => {
    const route = createRoute({ provider: "anthropic", model: "claude-opus-4.7", connection_id: "c1" });
    expect(Object.isFrozen(route)).toBe(true);
    expect(route.connection_id).toBe("c1");
  });

  it("requires provider and model", () => {
    expect(() => createRoute({ model: "x" })).toThrow(/provider/);
    expect(() => createRoute({ provider: "x" })).toThrow(/model/);
  });

  it("requires reported_model to be present even when it is null", () => {
    expect(() => assertExecutionResult({ status: 200, reported_model: null })).not.toThrow();
    expect(() => assertExecutionResult({ status: 200 })).toThrow(/reported_model is mandatory/);
  });

  it("rejects an invented error class", () => {
    expect(() => assertExecutionResult({ status: 500, reported_model: null, error_class: "overloaded" })).toThrow(
      /unknown error_class/
    );
    for (const cls of ERROR_CLASSES) {
      expect(() => assertExecutionResult({ status: 500, reported_model: null, error_class: cls })).not.toThrow();
    }
  });

  it("validates the result of a wrapped executor at call time", async () => {
    const bad = defineRouteExecutor({ execute: async () => ({ status: 200 }) });
    await expect(bad.execute(createRoute({ provider: "p", model: "m" }), baseRequest)).rejects.toThrow(
      /reported_model/
    );
  });

  it("rejects an implementation without execute()", () => {
    expect(() => defineRouteExecutor({})).toThrow(/must expose execute/);
  });
});

describe("CredentialStore", () => {
  it("shapes a descriptor and carries no secret", () => {
    const d = createConnectionDescriptor({
      id: "c1",
      provider: "anthropic",
      auth_type: "oauth",
      accessToken: "sk-should-not-appear",
    });
    expect(JSON.stringify(d)).not.toContain("sk-should-not-appear");
    expect(d.active).toBe(true);
  });

  it("treats active:false as inactive and anything else as active", () => {
    expect(createConnectionDescriptor({ id: "c", provider: "p", active: false }).active).toBe(false);
    expect(createConnectionDescriptor({ id: "c", provider: "p", active: undefined }).active).toBe(true);
  });

  it("requires a list() that returns an array", () => {
    const store = defineCredentialStore({ list: () => "nope", get: () => null });
    expect(() => store.list()).toThrow(/must return an array/);
  });
});

describe("Catalog", () => {
  it("keeps capabilities tri-state", () => {
    const m = createModelDescriptor({ provider: "p", model: "m" });
    // null, not false: I4 needs "unknown" to contribute zero rather than be read
    // as a confirmed absence.
    expect(m.supports_caching).toBeNull();
    expect(m.supports_tools).toBeNull();
    expect(m.context_window).toBeNull();
  });

  it("requires a non-empty version string", () => {
    const catalog = defineCatalog({ models: () => [], version: () => "" });
    expect(() => catalog.version()).toThrow(/non-empty/);
  });
});

describe("Clock", () => {
  it("rejects a clock that does not return epoch ms", () => {
    const bad = defineClock({ now: () => "2026-01-01" });
    expect(() => bad.now()).toThrow(/epoch milliseconds/);
  });

  it("fixedClock is deterministic and advanceable", () => {
    const clock = fixedClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });

  it("systemClock returns real time", () => {
    const t = systemClock.now();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(1_600_000_000_000);
  });
});
