/**
 * /api/cli-tools/all-statuses must not re-serve a LOCAL_ONLY route to a non-local caller.
 *
 * /api/cli-tools/cowork-settings is LOCAL_ONLY in src/dashboardGuard.js: it reads the
 * host's Claude Desktop (Cowork) config. That config is not just host data: every MCP
 * bridge entry the route writes carries `x-9r-cli-token` (injectAuthHeaders), and its
 * GET returns the config verbatim. The CLI token passes canAccessLocalOnlyRoute() and
 * ALWAYS_PROTECTED from ANY peer — /api/shutdown, /api/settings/database export,
 * /api/mcp/* process spawn, tailscale install.
 *
 * all-statuses imported that GET directly and was itself only session-protected. So a
 * dashboard session from a tunnel or the LAN, which the guard deliberately keeps away
 * from local-only routes, could read the cowork config here and lift the CLI token:
 * remote session -> host-local authority.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  coworkGet: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => Symbol("next")),
    json: (body, init) => ({ status: init?.status || 200, body, json: async () => body }),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: mocks.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verifyDashboardAuthToken }));

// Every per-tool GET is replaced: the test is about which ones all-statuses calls, and
// the real ones read the machine's actual CLI configs.
const stub = (id) => async () => ({ json: async () => ({ tool: id }) });
const TOOLS = ["claude", "codex", "opencode", "droid", "openclaw", "hermes", "copilot", "cline", "kilo", "deepseek-tui", "jcode", "grok-build", "devin"];
for (const id of TOOLS) {
  vi.doMock(`../../src/app/api/cli-tools/${id}-settings/route`, () => ({ GET: stub(id) }));
}
vi.mock("../../src/app/api/cli-tools/cowork-settings/route", () => ({ GET: mocks.coworkGet }));

const { GET } = await import("../../src/app/api/cli-tools/all-statuses/route.js");

const PEER_TOKEN = "peer-token-fixture";
const CLI_TOKEN = "cli-token-fixture";

function request({ peer = "127.0.0.1", site, cli } = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer });
  if (site) headers.set("sec-fetch-site", site);
  if (cli) headers.set("x-9r-cli-token", cli);
  return {
    nextUrl: { pathname: "/api/cli-tools/all-statuses", searchParams: new URLSearchParams() },
    headers,
    cookies: { get: vi.fn((n) => (n === "auth_token" ? { value: "valid-session" } : undefined)) },
    url: "http://localhost:20128/api/cli-tools/all-statuses",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });
  mocks.getConsistentMachineId.mockResolvedValue(CLI_TOKEN);
  mocks.verifyDashboardAuthToken.mockImplementation(async (t) => t === "valid-session");
  mocks.coworkGet.mockImplementation(async () => ({
    json: async () => ({ installed: true, config: { managedMcpServers: [{ headers: { "x-9r-cli-token": CLI_TOKEN } }] } }),
  }));
});

describe("all-statuses honours the LOCAL_ONLY gate of the routes it aggregates", () => {
  it("a remote (tunnel/LAN) session gets no cowork data, and the cowork GET never runs", async () => {
    const body = await (await GET(request({ peer: "203.0.113.7" }))).json();

    expect(mocks.coworkGet).not.toHaveBeenCalled();
    expect(body.cowork).toBeNull();
    expect(JSON.stringify(body)).not.toContain(CLI_TOKEN);
    // Everything else is still served: the fix is scoped to what is local-only.
    for (const id of TOOLS) expect(body[id]).toEqual({ tool: id });
  });

  it("a local session still gets cowork status", async () => {
    const body = await (await GET(request())).json();

    expect(mocks.coworkGet).toHaveBeenCalledTimes(1);
    expect(body.cowork.installed).toBe(true);
  });

  it("the CLI token (already local authority) still gets cowork status", async () => {
    const body = await (await GET(request({ peer: "203.0.113.7", cli: CLI_TOKEN }))).json();
    expect(body.cowork.installed).toBe(true);
  });
});
