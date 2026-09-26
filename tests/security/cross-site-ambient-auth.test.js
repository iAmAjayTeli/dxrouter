/**
 * Ambient authority must not be usable from another site.
 *
 * The dashboard session cookie is SameSite=Lax, so a browser attaches it to every
 * cross-site top-level GET navigation, and to every request from another port on the
 * same host ("same-site": http://localhost:3000 and http://localhost:20128 share a
 * site). The guard in src/dashboardGuard.js never looked at where a request came from,
 * and isLocalRequest() only rejects a non-loopback Origin, which a navigation does not
 * send. So a page the user merely visited could, with the user's session:
 *   - start/stop the local OAuth callback servers and plant an OAuth session
 *     (GET /api/oauth/{provider}/start-proxy?state=...&code_verifier=...&redirect_uri=...),
 *   - spawn a preset MCP stdio child (GET /api/mcp/{plugin}/sse, a LOCAL_ONLY route),
 *   - force OAuth token refreshes that rotate and rewrite stored credentials
 *     (GET /api/usage/{connectionId}),
 *   - make the server fetch an arbitrary URL (GET /api/providers/suggested-models?url=),
 * and, with requireApiKey=false, spend provider credentials on /v1 with no key at all.
 *
 * Browsers label every request with Sec-Fetch-Site. Ambient authority (the session
 * cookie, requireLogin=false, requireApiKey=false) is now refused when that label says
 * the request came from another site. Explicit credentials (API key, CLI token) are not
 * ambient, so a cross-site page cannot present them and they are unaffected, as are
 * non-browser clients, which send no Sec-Fetch-* headers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: mocks.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verifyDashboardAuthToken }));

const { proxy } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";
const CLI_TOKEN = "cli-token-fixture";

/** A browser request from the host itself (through custom-server.js), carrying the session cookie. */
function browser(pathname, site, extra = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...extra });
  if (site) headers.set("sec-fetch-site", site);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers,
    cookies: { get: vi.fn((name) => (name === "auth_token" ? { value: "valid-session" } : undefined)) },
    url: `http://localhost:20128${pathname}`,
  };
}

const allowed = (res) => res === mocks.nextResponse;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });
  mocks.validateApiKey.mockImplementation(async (k) => k === "sk-valid");
  mocks.getConsistentMachineId.mockResolvedValue(CLI_TOKEN);
  mocks.verifyDashboardAuthToken.mockImplementation(async (t) => t === "valid-session");
});

describe("the session cookie is refused when another site sent the request", () => {
  const routes = [
    "/api/oauth/codex/start-proxy", // starts a listener, registers a session from the query
    "/api/usage/conn-1", // refreshes and rewrites stored OAuth tokens
    "/api/providers/suggested-models", // server-side fetch of a caller-chosen URL
    "/api/keys", // plain protected route
  ];

  it.each(routes)("cross-site %s", async (path) => {
    expect((await proxy(browser(path, "cross-site"))).status).toBe(401);
  });

  it.each(routes)("same-site (another localhost port) %s", async (path) => {
    expect((await proxy(browser(path, "same-site"))).status).toBe(401);
  });

  it("LOCAL_ONLY route (spawns an MCP child) from another site", async () => {
    expect((await proxy(browser("/api/mcp/filesystem/sse", "cross-site"))).status).toBe(403);
  });

  it("ALWAYS_PROTECTED route from another site", async () => {
    expect((await proxy(browser("/api/shutdown", "cross-site"))).status).toBe(401);
  });

  it("requireLogin=false from another site", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, requireApiKey: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    expect((await proxy(browser("/api/keys", "cross-site"))).status).toBe(401);
  });

  it("requireApiKey=false does not let another site spend credentials on /v1", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: false });
    expect((await proxy(browser("/v1/chat/completions", "cross-site"))).status).toBe(401);
  });
});

describe("legitimate traffic is unchanged", () => {
  it.each(["same-origin", "none", null])("session cookie with Sec-Fetch-Site=%s", async (site) => {
    expect(allowed(await proxy(browser("/api/keys", site)))).toBe(true);
    expect(allowed(await proxy(browser("/api/mcp/filesystem/sse", site)))).toBe(true);
    expect(allowed(await proxy(browser("/api/shutdown", site)))).toBe(true);
  });

  it("an explicit API key still works cross-site (a page cannot present one it does not have)", async () => {
    const res = await proxy(browser("/v1/chat/completions", "cross-site", { authorization: "Bearer sk-valid" }));
    expect(allowed(res)).toBe(true);
  });

  it("the CLI token still works (explicit credential, not ambient)", async () => {
    const res = await proxy(browser("/api/shutdown", "cross-site", { "x-9r-cli-token": CLI_TOKEN }));
    expect(allowed(res)).toBe(true);
  });

  it("public SSO endpoints still accept the identity provider's cross-site redirect/POST", async () => {
    expect(allowed(await proxy(browser("/api/auth/oidc/callback", "cross-site")))).toBe(true);
    expect(allowed(await proxy(browser("/api/auth/saml/acs", "cross-site")))).toBe(true);
  });

  it("requireApiKey=false still serves same-origin and non-browser local callers", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: false });
    expect(allowed(await proxy(browser("/v1/chat/completions", null)))).toBe(true);
    expect(allowed(await proxy(browser("/v1/chat/completions", "same-origin")))).toBe(true);
  });
});
