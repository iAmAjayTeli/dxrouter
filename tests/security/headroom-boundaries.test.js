/**
 * Headroom routes: the process controls are all local-only, and the reverse proxy never
 * forwards DXRouter's own trust headers.
 *
 * - /api/headroom/start and /stop were LOCAL_ONLY; /restart (kill + respawn of the same
 *   Python proxy) was left session-only, so a tunnel/LAN session could restart it.
 * - /api/headroom/proxy/[...path] copied every request header to settings.headroomUrl,
 *   stripping only cookie/authorization and only for non-loopback hosts. Its callers are
 *   local (LOCAL_ONLY), so they typically carry x-9r-cli-token — host-local authority
 *   from any peer — and custom-server.js stamps x-9r-peer-token / x-9r-real-ip on every
 *   request. All of it went to the configured Headroom host.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(async () => "real-cli-token"),
  verifyDashboardAuthToken: vi.fn(async (t) => t === "valid-session"),
}));

vi.mock("next/server", () => {
  class NextResponse extends Response {
    static json(body, init) { return { status: init?.status || 200, body }; }
    static next() { return "next"; }
    static redirect() { return { status: 307 }; }
  }
  return { NextResponse };
});
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: mocks.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: mocks.verifyDashboardAuthToken }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://127.0.0.1:8787" }));

const { proxy } = await import("../../src/dashboardGuard.js");
const headroomProxy = await import("../../src/app/api/headroom/proxy/[...path]/route.js");

const PEER_TOKEN = "peer-token-fixture";

function guardRequest(pathname, { peer = "203.0.113.7" } = {}) {
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    headers: new Headers({ "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": peer }),
    cookies: { get: vi.fn((n) => (n === "auth_token" ? { value: "valid-session" } : undefined)) },
    url: `http://localhost:20128${pathname}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ requireLogin: true, headroomUrl: "https://headroom.remote.example" });
});

describe("headroom process controls are uniformly local-only", () => {
  it.each(["/api/headroom/start", "/api/headroom/stop", "/api/headroom/restart"])(
    "a remote session is refused %s",
    async (path) => {
      expect((await proxy(guardRequest(path))).status).toBe(403);
    }
  );

  it("a local session still reaches /api/headroom/restart", async () => {
    expect(await proxy(guardRequest("/api/headroom/restart", { peer: "127.0.0.1" }))).toBe("next");
  });
});

describe("the Headroom reverse proxy keeps DXRouter's trust headers", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const inbound = () =>
    new Request("http://localhost:20128/api/headroom/proxy/stats?x=1", {
      headers: {
        "x-9r-cli-token": "real-cli-token",
        "x-9r-peer-token": PEER_TOKEN,
        "x-9r-real-ip": "127.0.0.1",
        "x-9r-via-proxy": "1",
        cookie: "auth_token=valid-session",
        authorization: "Bearer sk-router",
        "x-api-key": "sk-router",
        accept: "application/json",
      },
    });

  const sent = async () => {
    await headroomProxy.GET(inbound(), { params: Promise.resolve({ path: ["stats"] }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    return { url: String(url), headers: init.headers };
  };

  it("never forwards x-9r-* headers, to a remote host", async () => {
    const { url, headers } = await sent();
    expect(url).toBe("https://headroom.remote.example/stats?x=1");
    for (const h of ["x-9r-cli-token", "x-9r-peer-token", "x-9r-real-ip", "x-9r-via-proxy"]) {
      expect(headers.get(h), h).toBeNull();
    }
  });

  it("strips viewer credentials for a remote host, keeps ordinary headers", async () => {
    const { headers } = await sent();
    for (const h of ["cookie", "authorization", "x-api-key"]) expect(headers.get(h), h).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });

  it("never forwards x-9r-* headers to a loopback host either", async () => {
    mocks.getSettings.mockResolvedValue({ headroomUrl: "http://127.0.0.1:8787" });
    const { headers } = await sent();
    expect(headers.get("x-9r-cli-token")).toBeNull();
    expect(headers.get("x-9r-peer-token")).toBeNull();
    // Loopback Headroom behaviour for viewer credentials is unchanged.
    expect(headers.get("cookie")).toBe("auth_token=valid-session");
  });
});
