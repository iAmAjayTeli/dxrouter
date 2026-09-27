/**
 * OAuth callback listeners are host-local: start-proxy / stop-proxy are LOCAL_ONLY.
 *
 * GET /api/oauth/{provider}/start-proxy binds a local HTTP listener (trae/windsurf on a
 * dynamic port, zed on `native_app_port` from the query, codex/xai on `app_port` from the
 * query) and for codex/xai registers a server-side session from query-supplied state,
 * code_verifier and redirect_uri; stop-proxy kills those listeners. Any dashboard
 * session (tunnel/LAN included) could do both. The listeners only ever receive a browser
 * redirect to localhost ON THE DXROUTER HOST, so they serve a browser on that host and
 * nothing else; a remote dashboard user's redirect lands on their own machine. The
 * OAuth modal already treats a failed start-proxy as "no proxy" (codex/xai fall back to
 * the paste/channel flow).
 *
 * Enforced through the guard's shared LOCAL_ONLY policy (a pattern next to the
 * *-settings one), not an OAuth-specific check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(async () => "real-cli-token"),
  verifyDashboardAuthToken: vi.fn(async (t) => t === "valid-session"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => "next"),
    json: (body, init) => ({ status: init?.status || 200, body }),
    redirect: vi.fn(() => ({ status: 307 })),
  },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: mocks.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verifyDashboardAuthToken }));

const { proxy, isLocalOnlyPath } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";
// Every provider the route's start-proxy / stop-proxy branches handle.
const PROVIDERS = ["trae", "windsurf", "zed", "codex", "xai"];
const ACTIONS = ["start-proxy", "stop-proxy"];
const CASES = PROVIDERS.flatMap((p) => ACTIONS.map((a) => `/api/oauth/${p}/${a}`));

function req(pathname, { peer = "203.0.113.7", cli, cookie = true, site } = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer });
  if (cli) headers.set("x-9r-cli-token", cli);
  if (site) headers.set("sec-fetch-site", site);
  return {
    method: "GET",
    nextUrl: { pathname, searchParams: new URLSearchParams("app_port=1455&state=s&code_verifier=v") },
    headers,
    cookies: { get: vi.fn((n) => (cookie && n === "auth_token" ? { value: "valid-session" } : undefined)) },
    url: `http://localhost:20128${pathname}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });
});

describe("OAuth callback listener start/stop are local-only", () => {
  it.each(CASES)("a remote session is refused %s before the route runs", async (path) => {
    const res = await proxy(req(path));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Local only: CLI token required" });
  });

  it.each(CASES)("a local same-origin dashboard session still reaches %s", async (path) => {
    expect(await proxy(req(path, { peer: "127.0.0.1", site: "same-origin" }))).toBe("next");
  });

  it.each(CASES)("the real CLI token still reaches %s", async (path) => {
    expect(await proxy(req(path, { cli: "real-cli-token", cookie: false }))).toBe("next");
  });

  it("a forged CLI token does not", async () => {
    expect((await proxy(req("/api/oauth/codex/start-proxy", { cli: "x", cookie: false }))).status).toBe(403);
  });

  it.each(CASES)("a cross-site request from the host itself is still rejected: %s", async (path) => {
    const res = await proxy(req(path, { peer: "127.0.0.1", site: "cross-site" }));
    expect(res).not.toBe("next");
    expect([401, 403]).toContain(res.status);
  });
});

describe("the rest of the OAuth route keeps its existing policy", () => {
  it.each(["authorize", "poll-status", "exchange", "device-code", "ide-status", "register-session"])(
    "codex/%s stays session-level",
    async (action) => {
      expect(isLocalOnlyPath(`/api/oauth/codex/${action}`)).toBe(false);
      expect(await proxy(req(`/api/oauth/codex/${action}`))).toBe("next");
    }
  );

  it("the match is exact: a provider or action merely containing the words is not caught", () => {
    expect(isLocalOnlyPath("/api/oauth/start-proxy")).toBe(false);
    expect(isLocalOnlyPath("/api/oauth/codex/start-proxy-extra")).toBe(false);
  });
});
