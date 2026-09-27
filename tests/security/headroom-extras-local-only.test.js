/**
 * /api/headroom/extras: installing and uninstalling are local-only; reading is not.
 *
 * POST and DELETE run `pip install` / `pip uninstall headroom-ai[...]` in the host's
 * Python. The extras are whitelisted and the command is built without a shell, but it is
 * still a package install on the host, the same host-control class as pxpipe/install,
 * and any dashboard session (tunnel/LAN included) could trigger it. Policy: POST and
 * DELETE are LOCAL_ONLY; GET (installed-extras status and the `?log=1` install-log tail
 * the UI polls) stays session-level.
 *
 * The rule lives in the guard's one LOCAL_ONLY list, scoped by method, so the refusal
 * happens before the route (and pip) runs.
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

const { proxy } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";
const PATH = "/api/headroom/extras";

function req(method, { peer = "203.0.113.7", cli, cookie = true, search = "" } = {}) {
  const headers = new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer });
  if (cli) headers.set("x-9r-cli-token", cli);
  return {
    method,
    nextUrl: { pathname: PATH, searchParams: new URLSearchParams(search) },
    headers,
    cookies: { get: vi.fn((n) => (cookie && n === "auth_token" ? { value: "valid-session" } : undefined)) },
    url: `http://localhost:20128${PATH}${search ? `?${search}` : ""}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });
});

describe("headroom extras install/uninstall are local-only", () => {
  it.each(["POST", "DELETE"])("a remote session is refused %s before the route runs", async (method) => {
    const res = await proxy(req(method));
    expect(res.status).toBe(403);
    // Same body every LOCAL_ONLY refusal already returns: nothing new is disclosed.
    expect(res.body).toEqual({ error: "Local only: CLI token required" });
  });

  it.each(["POST", "DELETE"])("a local session still reaches %s", async (method) => {
    expect(await proxy(req(method, { peer: "127.0.0.1" }))).toBe("next");
  });

  it.each(["POST", "DELETE"])("the real CLI token still reaches %s; a forged one does not", async (method) => {
    expect(await proxy(req(method, { cli: "real-cli-token", cookie: false }))).toBe("next");
    expect((await proxy(req(method, { cli: "x", cookie: false }))).status).toBe(403);
  });

  it("method matching is case-insensitive", async () => {
    expect((await proxy(req("post"))).status).toBe(403);
  });
});

describe("reading headroom extras stays session-level", () => {
  it("a remote session can still GET status", async () => {
    expect(await proxy(req("GET"))).toBe("next");
  });

  it("a remote session can still GET the install-log tail (?log=1)", async () => {
    expect(await proxy(req("GET", { search: "log=1" }))).toBe("next");
  });

  it("with no session a GET is still refused as before (401, not 403)", async () => {
    expect((await proxy(req("GET", { cookie: false }))).status).toBe(401);
  });
});
