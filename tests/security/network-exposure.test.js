/**
 * Network-exposure policy (M0 section 2).
 *
 * Three requirements collapse into one decision function: network exposure needs
 * an explicit opt-in, network exposure needs authentication, and an unsafe
 * 0.0.0.0 bind must be refused. The tests are mostly about the refusals, since a
 * policy that only ever says yes is indistinguishable from no policy.
 */

import { describe, it, expect } from "vitest";

import {
  classifyBindHost,
  isNetworkAllowed,
  evaluateExposure,
  assertExposureAllowed,
} from "@/lib/security/networkExposure.js";
import { SecurityBootstrapError } from "@/lib/security/errors.js";

const authOn = { requireLogin: true, requireApiKey: true };

describe("classifyBindHost", () => {
  it.each(["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.5", "::ffff:127.0.0.1"])(
    "reads %s as loopback",
    (host) => {
      expect(classifyBindHost(host).exposed).toBe(false);
      expect(classifyBindHost(host).kind).toBe("loopback");
    }
  );

  it.each(["0.0.0.0", "::", "[::]", "*"])("reads %s as a wildcard bind", (host) => {
    const b = classifyBindHost(host);
    expect(b.kind).toBe("wildcard");
    expect(b.exposed).toBe(true);
  });

  it("reads a LAN address as exposed", () => {
    expect(classifyBindHost("192.168.1.40")).toMatchObject({ kind: "specific", exposed: true });
  });

  it("assumes the runtime default when HOSTNAME is unset", () => {
    // `next dev` binds loopback; the standalone production server binds 0.0.0.0,
    // so an unset HOSTNAME is only safe in development.
    expect(classifyBindHost(undefined, { nodeEnv: "development" })).toMatchObject({
      kind: "loopback",
      exposed: false,
      assumed: true,
    });
    expect(classifyBindHost("", { nodeEnv: "production" })).toMatchObject({
      kind: "wildcard",
      exposed: true,
      assumed: true,
    });
  });
});

describe("isNetworkAllowed", () => {
  it.each(["1", "true", "TRUE", "yes", "on"])("accepts %s", (v) => {
    expect(isNetworkAllowed({ DXR_ALLOW_NETWORK: v })).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "maybe"])("rejects %s", (v) => {
    expect(isNetworkAllowed({ DXR_ALLOW_NETWORK: v })).toBe(false);
  });
});

describe("evaluateExposure", () => {
  it("allows loopback without any opt-in", () => {
    expect(evaluateExposure({ host: "127.0.0.1", allowNetwork: false, settings: null }).ok).toBe(true);
  });

  it("refuses an exposed bind that was not opted into", () => {
    const r = evaluateExposure({ host: "0.0.0.0", allowNetwork: false, settings: authOn });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NETWORK_EXPOSURE_NOT_OPTED_IN");
    expect(r.remedy).toMatch(/DXR_ALLOW_NETWORK=1/);
  });

  it("refuses a production default bind, where HOSTNAME was merely forgotten", () => {
    const r = evaluateExposure({ host: undefined, allowNetwork: false, settings: authOn, nodeEnv: "production" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HOSTNAME is unset/);
  });

  it("refuses an exposed bind with authentication turned off", () => {
    for (const off of [{ requireLogin: false }, { requireApiKey: false }]) {
      const r = evaluateExposure({ host: "0.0.0.0", allowNetwork: true, settings: { ...authOn, ...off } });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NETWORK_EXPOSURE_WITHOUT_AUTH");
      // The defaults are not weakened for network-exposed instances; the message
      // has to say so, or the next person turns them off again.
      expect(r.remedy).toMatch(/not weakened/);
    }
  });

  it("refuses when the settings cannot be read, rather than assuming auth is on", () => {
    const r = evaluateExposure({ host: "10.0.0.5", allowNetwork: true, settings: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NETWORK_EXPOSURE_SETTINGS_UNKNOWN");
  });

  it("allows an exposed bind that opted in and kept authentication, with a warning", () => {
    const r = evaluateExposure({ host: "0.0.0.0", allowNetwork: true, settings: authOn });
    expect(r.ok).toBe(true);
    expect(r.warn).toMatch(/Network-exposed/);
  });

  it("ignores disabled authentication while bound to loopback", () => {
    // Turning login off on a loopback-only instance is a local convenience
    // choice; it is only a refusal when the port is reachable from elsewhere.
    const r = evaluateExposure({ host: "127.0.0.1", allowNetwork: false, settings: { requireLogin: false, requireApiKey: false } });
    expect(r.ok).toBe(true);
  });
});

describe("assertExposureAllowed", () => {
  it("throws a SecurityBootstrapError carrying the code and the remedy", () => {
    try {
      assertExposureAllowed({ host: "0.0.0.0", allowNetwork: false, settings: authOn });
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityBootstrapError);
      expect(e.code).toBe("NETWORK_EXPOSURE_NOT_OPTED_IN");
      expect(e.remedy).toBeTruthy();
    }
  });

  it("returns the evaluation when the bind is allowed", () => {
    expect(assertExposureAllowed({ host: "127.0.0.1", allowNetwork: false, settings: authOn }).ok).toBe(true);
  });
});
