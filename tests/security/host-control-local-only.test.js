/**
 * Host-control routes are local-only (policy decisions 1 and 2).
 *
 * /api/cli-tools/*-settings read and rewrite other tools' configuration on the HOST:
 * claude-settings POST merged any caller `env` into ~/.claude/settings.json
 * (ANTHROPIC_BASE_URL, proxy variables, NODE_TLS_REJECT_UNAUTHORIZED ...), codex-settings
 * POST pointed Codex at any base URL, and their GETs return those files — including
 * env.ANTHROPIC_AUTH_TOKEN and bearer keys. Any dashboard session reached them, a tunnel
 * or LAN one included: a remote session could redirect the user's coding agents (and the
 * model replies that drive their shell/file tools) to a server of its choosing.
 *
 * /api/pxpipe/install, /start and /restart run `npm install` into the data dir and load
 * the package into the server process.
 *
 * Both are host-control operations, so they join LOCAL_ONLY_PATHS: a loopback browser
 * with a session, or the CLI token. Nothing is removed; remote sessions are refused.
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

function req(pathname, { peer = "203.0.113.7", cli, cookie = true } = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer });
  if (cli) headers.set("x-9r-cli-token", cli);
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

// Every *-settings route that exists today (src/app/api/cli-tools/*-settings).
const SETTINGS_TOOLS = [
  "claude", "cline", "codex", "copilot", "cowork", "deepseek-tui", "devin", "droid",
  "grok-build", "hermes", "jcode", "kilo", "openclaw", "opencode",
];
const SETTINGS_ROUTES = SETTINGS_TOOLS.map((t) => `/api/cli-tools/${t}-settings`);
const PXPIPE_CONTROL = ["/api/pxpipe/install", "/api/pxpipe/start", "/api/pxpipe/restart"];

describe("CLI tool settings are local-only", () => {
  it.each(SETTINGS_ROUTES)("a remote session is refused %s", async (path) => {
    expect((await proxy(req(path))).status).toBe(403);
  });

  it.each(SETTINGS_ROUTES)("a local session still reaches %s", async (path) => {
    expect(await proxy(req(path, { peer: "127.0.0.1" }))).toBe("next");
  });

  it.each(SETTINGS_ROUTES)("the CLI token still reaches %s from any peer", async (path) => {
    expect(await proxy(req(path, { cli: "real-cli-token", cookie: false }))).toBe("next");
  });

  it("a forged CLI token does not", async () => {
    expect((await proxy(req("/api/cli-tools/claude-settings", { cli: "x", cookie: false }))).status).toBe(403);
  });

  it("the matcher covers any future *-settings route, and nothing unrelated", () => {
    expect(isLocalOnlyPath("/api/cli-tools/some-new-tool-settings")).toBe(true);
    expect(isLocalOnlyPath("/api/cli-tools/all-statuses")).toBe(false);
    expect(isLocalOnlyPath("/api/cli-tools/cowork-mcp-registry")).toBe(false);
  });
});

describe("pxpipe install / process control is local-only", () => {
  it.each(PXPIPE_CONTROL)("a remote session is refused %s", async (path) => {
    expect((await proxy(req(path))).status).toBe(403);
  });

  it.each(PXPIPE_CONTROL)("a local session still reaches %s", async (path) => {
    expect(await proxy(req(path, { peer: "127.0.0.1" }))).toBe("next");
  });

  it.each(["/api/pxpipe/status", "/api/pxpipe/stats", "/api/pxpipe/health", "/api/pxpipe/logs", "/api/pxpipe/stop"])(
    "read-only / stop routes stay session-level: %s",
    async (path) => {
      expect(await proxy(req(path))).toBe("next");
    }
  );
});
