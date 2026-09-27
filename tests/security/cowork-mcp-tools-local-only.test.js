/**
 * POST /api/cli-tools/cowork-mcp-tools is local-only (policy A).
 *
 * The route probes an MCP server at a caller-chosen `url` with three server-side
 * JSON-RPC POSTs (redirects followed, private addresses reachable) and reflects tool
 * names, statuses and raw fetch errors, so any dashboard session, tunnel or LAN
 * included, could use it to scan and read internal services. Its only caller is the
 * Cowork (Claude Desktop) marketplace, whose result can only be applied through
 * cowork-settings, which is already LOCAL_ONLY. It joins that boundary via the
 * guard's existing LOCAL_ONLY_PATHS list; cowork-mcp-registry (a fixed Anthropic URL)
 * is unchanged.
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
const TOOLS = "/api/cli-tools/cowork-mcp-tools";
const REGISTRY = "/api/cli-tools/cowork-mcp-registry";

function req(pathname, { peer = "203.0.113.7", cli, cookie = true, site } = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer });
  if (cli) headers.set("x-9r-cli-token", cli);
  if (site) headers.set("sec-fetch-site", site);
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
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

describe("cowork-mcp-tools is local-only", () => {
  it("a remote session is refused, so the server-side probe never runs", async () => {
    expect((await proxy(req(TOOLS))).status).toBe(403);
  });

  it("a local dashboard session (the marketplace, same-origin) still reaches it", async () => {
    expect(await proxy(req(TOOLS, { peer: "127.0.0.1", site: "same-origin" }))).toBe("next");
  });

  it("the CLI token still reaches it; a forged one does not", async () => {
    expect(await proxy(req(TOOLS, { cli: "real-cli-token", cookie: false }))).toBe("next");
    expect((await proxy(req(TOOLS, { cli: "x", cookie: false }))).status).toBe(403);
  });

  it("is decided by the shared LOCAL_ONLY policy (what all-statuses and others consult)", () => {
    expect(isLocalOnlyPath(TOOLS)).toBe(true);
  });

  it("cowork-mcp-registry (fixed upstream URL) stays session-level", async () => {
    expect(isLocalOnlyPath(REGISTRY)).toBe(false);
    expect(await proxy(req(REGISTRY))).toBe("next");
  });
});
