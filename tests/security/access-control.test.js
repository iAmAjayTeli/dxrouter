/**
 * Authentication on by default — including from localhost (M0 section 2).
 *
 * Two upstream behaviours are deliberately gone: a loopback caller getting the
 * whole LLM API without presenting anything, and `requireLogin: false` applying
 * to every peer rather than only to loopback. Both are asserted here from the
 * outside, through the real guard, because they are the difference between "the
 * gateway is local-only" and "anything on this machine can spend every stored
 * credential".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  next: Symbol("next"),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  killAppProcesses: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.next),
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
    redirect: vi.fn((url) => ({ status: 307, url: String(url) })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

// The shutdown route's only side effect, stubbed so the negative assertions ("nothing was
// killed") are observations rather than the absence of a crash.
vi.mock("@/lib/appUpdater", () => ({
  killAppProcesses: mocks.killAppProcesses,
}));

const { proxy, __test__ } = await import("@/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";
const CLI_TOKEN = "cli-token-fixture";
const SECURE_DEFAULTS = { requireLogin: true, requireApiKey: true };

/** A request as it arrives from a non-loopback peer. */
function remote(pathname, headers = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://router.example.com${pathname}`).searchParams },
    headers: new Headers({ host: "router.example.com", ...headers }),
    cookies: { get: () => undefined },
    url: `http://router.example.com${pathname}`,
  };
}

/**
 * A request that genuinely came through `custom-server.js`: the peer address was
 * taken from the TCP socket and proven with the per-process secret. Anything a
 * client could set by hand does not qualify.
 */
function loopback(pathname, headers = {}) {
  const req = remote(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
  req.headers.set("host", "localhost:20128");
  return req;
}

function withCookie(req, value) {
  req.cookies = { get: (name) => (name === "auth_token" ? { value } : undefined) };
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  mocks.getSettings.mockResolvedValue({ ...SECURE_DEFAULTS });
  mocks.validateApiKey.mockResolvedValue(false);
  mocks.getConsistentMachineId.mockResolvedValue(CLI_TOKEN);
  mocks.verifyDashboardAuthToken.mockResolvedValue(false);
});

describe("localhost still requires authentication", () => {
  it.each([
    ["/v1/chat/completions", 401],
    ["/api/v1/chat/completions", 401],
    ["/v1beta/models", 401],
    ["/codex/responses", 401],
  ])("denies %s from loopback with no credential", async (pathname, status) => {
    const res = await proxy(loopback(pathname));
    expect(res.status).toBe(status);
  });

  it("denies a loopback dashboard API call with no session", async () => {
    const res = await proxy(loopback("/api/providers"));
    expect(res.status).toBe(401);
  });

  it("accepts a loopback call that presents a valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);
    expect(await proxy(loopback("/v1/chat/completions", { authorization: "Bearer sk-valid" }))).toBe(mocks.next);
  });

  it("accepts the CLI's own token, which is derived from the machine id", async () => {
    expect(await proxy(loopback("/v1/chat/completions", { "x-9r-cli-token": CLI_TOKEN }))).toBe(mocks.next);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects a wrong CLI token instead of accepting the header's presence", async () => {
    const res = await proxy(loopback("/v1/chat/completions", { "x-9r-cli-token": "guessed" }));
    expect(res.status).toBe(401);
  });
});

describe("the operator opt-outs are loopback-only", () => {
  it("honours requireApiKey:false on loopback", async () => {
    mocks.getSettings.mockResolvedValue({ ...SECURE_DEFAULTS, requireApiKey: false });
    expect(await __test__.canAccessPublicLlmApi(loopback("/v1/chat/completions"))).toBe(true);
  });

  it("ignores requireApiKey:false for a remote peer", async () => {
    mocks.getSettings.mockResolvedValue({ ...SECURE_DEFAULTS, requireApiKey: false });
    expect(await __test__.canAccessPublicLlmApi(remote("/v1/chat/completions"))).toBe(false);
  });

  it("honours requireLogin:false on loopback", async () => {
    mocks.getSettings.mockResolvedValue({ ...SECURE_DEFAULTS, requireLogin: false });
    expect(await __test__.isAuthenticated(loopback("/api/providers"))).toBe(true);
  });

  it("ignores requireLogin:false for a remote peer", async () => {
    // One settings write used to turn a network-exposed dashboard into an open
    // one, credential management included.
    mocks.getSettings.mockResolvedValue({ ...SECURE_DEFAULTS, requireLogin: false });
    expect(await __test__.isAuthenticated(remote("/api/providers"))).toBe(false);
    expect((await proxy(remote("/api/providers"))).status).toBe(401);
  });

  it("treats unreadable settings as authentication required", async () => {
    mocks.getSettings.mockRejectedValue(new Error("database is locked"));
    expect(await __test__.isAuthenticated(loopback("/api/providers"))).toBe(false);
    expect(await __test__.canAccessPublicLlmApi(loopback("/v1/chat/completions"))).toBe(false);
  });
});

describe("what counts as local", () => {
  it("requires the peer proof, not just the header", async () => {
    // Without the per-process token, `x-9r-real-ip` is attacker-supplied input.
    const forged = remote("/v1/chat/completions", { "x-9r-real-ip": "127.0.0.1" });
    expect(__test__.isLocalRequest(forged)).toBe(false);
  });

  it("rejects a spoofed Host when the real peer is remote", async () => {
    const req = loopback("/v1/chat/completions", { "x-9r-real-ip": "10.204.111.34" });
    expect(__test__.isLocalRequest(req)).toBe(false);
  });

  it("reads IPv6 and IPv4-mapped loopback forms", () => {
    for (const ip of ["::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(__test__.isLocalRequest(loopback("/v1/x", { "x-9r-real-ip": ip })), ip).toBe(true);
    }
  });

  it("stops being local once a reverse proxy is in the path", () => {
    // The loopback socket is then the proxy hop, not the end user.
    const viaProxy = loopback("/v1/chat/completions", { "x-9r-via-proxy": "1" });
    expect(__test__.isLocalRequest(viaProxy)).toBe(false);
  });

  it("stops being local when the browser Origin is not loopback", () => {
    const tunnelled = loopback("/api/providers", { origin: "https://router.example.com" });
    expect(__test__.isLocalRequest(tunnelled)).toBe(false);
  });
});

describe("deny by default", () => {
  it("denies an /api path nobody allow-listed", async () => {
    // A new route is protected the moment it is added, without anyone
    // remembering to list it.
    const res = await proxy(loopback("/api/some-future-route"));
    expect(res.status).toBe(401);
  });

  it("keeps the few genuinely public endpoints reachable", async () => {
    for (const p of ["/api/health", "/api/auth/login", "/api/version", "/api/settings/require-login"]) {
      expect(await proxy(remote(p)), p).toBe(mocks.next);
    }
  });

  it("requires a session for the always-protected routes even with login disabled", async () => {
    mocks.getSettings.mockResolvedValue({ ...SECURE_DEFAULTS, requireLogin: false });
    for (const p of ["/api/shutdown", "/api/settings/database", "/api/version/update", "/api/version/shutdown"]) {
      expect((await proxy(loopback(p))).status, p).toBe(401);
    }
  });

  it("accepts a valid session for an always-protected route", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    expect(await proxy(withCookie(loopback("/api/shutdown"), "jwt"))).toBe(mocks.next);
  });

  it("restricts spawn-capable routes to a local, authenticated caller", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const local = withCookie(loopback("/api/mcp/install"), "jwt");
    expect(await proxy(local)).toBe(mocks.next);

    const off_host = withCookie(remote("/api/mcp/install"), "jwt");
    const res = await proxy(off_host);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Local only/);
  });

  it("redirects an unauthenticated dashboard page to the login screen", async () => {
    const res = await proxy(remote("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.url).toMatch(/\/login$/);
  });
});

/**
 * Shutting the installation down is the most process-destructive thing the HTTP surface
 * can do: the route terminates every process ownership proved is ours and then exits the
 * server. It was only session-protected, so an operator who reached the dashboard over a
 * tunnel could shut the host down from anywhere — while strictly lesser routes
 * (`/api/tunnel/tailscale-check`, `/api/mcp/`) were already loopback-only.
 *
 * These cases run the real guard and then, only when the guard allows it, the real route,
 * which is how the deployed pipeline composes them. That is what makes the negative
 * assertion meaningful: `killAppProcesses` is not merely un-asserted on a rejected
 * request, it is unreachable.
 */
describe("shutdown is local-only and authenticated", () => {
  /** Mirrors the deployed order: the guard runs first, and the handler runs only if it passed. */
  async function pipeline(request) {
    const decision = await proxy(request);
    if (decision !== mocks.next) return { allowed: false, decision };
    const { POST } = await import("@/app/api/version/shutdown/route.js");
    return { allowed: true, decision, response: await POST() };
  }

  beforeEach(() => {
    mocks.killAppProcesses.mockClear();
    mocks.killAppProcesses.mockResolvedValue({ processes: [], pids: [] });
  });

  it("rejects an unauthenticated caller, and kills nothing", async () => {
    const { allowed, decision } = await pipeline(loopback("/api/version/shutdown"));

    expect(allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(mocks.killAppProcesses).not.toHaveBeenCalled();
  });

  it("rejects an authenticated caller from a non-loopback peer, and kills nothing", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const { allowed, decision } = await pipeline(withCookie(remote("/api/version/shutdown"), "jwt"));

    // A valid session used to be sufficient. It no longer is: the peer has to be local,
    // because nothing this route does is meaningful to a remote caller.
    expect(allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(decision.body.error).toMatch(/Local only/);
    expect(mocks.killAppProcesses).not.toHaveBeenCalled();
  });

  it("rejects a loopback socket that is really a proxy hop, and kills nothing", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const viaProxy = withCookie(loopback("/api/version/shutdown"), "jwt");
    viaProxy.headers.set("x-9r-via-proxy", "1");

    const { allowed, decision } = await pipeline(viaProxy);

    expect(allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(mocks.killAppProcesses).not.toHaveBeenCalled();
  });

  it("rejects a tunnelled browser whose Origin is not loopback, and kills nothing", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const tunnelled = withCookie(
      loopback("/api/version/shutdown", { origin: "https://router.example.com" }),
      "jwt"
    );

    const { allowed, decision } = await pipeline(tunnelled);

    expect(allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(mocks.killAppProcesses).not.toHaveBeenCalled();
  });

  it("still lets the local dashboard shut the installation down", async () => {
    // The regression that matters in the other direction: the two dashboard callers
    // (profile page, header menu) are same-origin fetches from a loopback browser, and
    // they must keep working.
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    vi.useFakeTimers(); // the route schedules process.exit; never let it fire

    try {
      const { allowed, response } = await pipeline(withCookie(loopback("/api/version/shutdown"), "jwt"));

      expect(allowed).toBe(true);
      expect(response.body.success).toBe(true);
      expect(mocks.killAppProcesses).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("still accepts the CLI's machine token from the host", async () => {
    vi.useFakeTimers();
    try {
      const { allowed } = await pipeline(
        loopback("/api/version/shutdown", { "x-9r-cli-token": CLI_TOKEN })
      );

      expect(allowed).toBe(true);
      expect(mocks.killAppProcesses).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("API key carriers", () => {
  it("reads all four shapes a provider client might use", () => {
    expect(__test__.extractApiKey(remote("/v1/x", { authorization: "Bearer sk-one" }))).toBe("sk-one");
    expect(__test__.extractApiKey(remote("/v1/x", { "x-api-key": "sk-two" }))).toBe("sk-two");
    expect(__test__.extractApiKey(remote("/v1/x", { "x-goog-api-key": "sk-three" }))).toBe("sk-three");

    const query = remote("/v1beta/models");
    query.nextUrl.searchParams = new URL("http://r.test/v1beta/models?key=sk-four").searchParams;
    expect(__test__.extractApiKey(query)).toBe("sk-four");
  });

  it("returns null rather than an empty string when nothing was presented", () => {
    expect(__test__.extractApiKey(remote("/v1/x"))).toBeNull();
  });

  it("validates the key it extracted, and denies when the store rejects it", async () => {
    mocks.validateApiKey.mockResolvedValue(false);
    const res = await proxy(remote("/v1/chat/completions", { "x-api-key": "sk-revoked" }));
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-revoked");
    expect(res.status).toBe(401);
  });
});
