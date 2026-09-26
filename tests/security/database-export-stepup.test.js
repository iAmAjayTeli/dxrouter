/**
 * /api/settings/database (full export/import of every stored credential) keeps its
 * password step-up unless the caller presents the REAL CLI token.
 *
 * The guard lets this ALWAYS_PROTECTED route through with any valid dashboard session,
 * from any peer; the route then demands the dashboard password again — except for CLI
 * requests. "CLI request" was decided by the header's mere presence:
 *   Boolean(request.headers.get("x-9r-cli-token"))
 * so a session (a tunnel or LAN one included) that sent `x-9r-cli-token: x` skipped the
 * password and could export every provider API key and OAuth token, or import a database
 * that replaces them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(async () => ({ providerConnections: [{ apiKey: "sk-stored-secret" }] })),
  importDb: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  verifyDashboardPassword: vi.fn(async (p) => p === "correct-password"),
  getConsistentMachineId: vi.fn(async () => "real-cli-token"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
    next: vi.fn(),
    redirect: vi.fn(),
  },
}));
vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  importDb: mocks.importDb,
  getSettings: mocks.getSettings,
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
  verifyDashboardAuthToken: vi.fn(),
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));

const { GET, POST } = await import("../../src/app/api/settings/database/route.js");

const get = (headers) => GET({ headers: new Headers(headers) });
const post = (headers, body) => POST({ headers: new Headers(headers), json: async () => body });

beforeEach(() => vi.clearAllMocks());

describe("database export/import step-up", () => {
  it("a forged x-9r-cli-token does not skip the password on export", async () => {
    const res = await get({ "x-9r-cli-token": "x" });
    expect(res.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("a forged x-9r-cli-token does not skip the password on import", async () => {
    const res = await post({ "x-9r-cli-token": "x" }, { settings: {} });
    expect(res.status).toBe(401);
    expect(mocks.importDb).not.toHaveBeenCalled();
  });

  it("the real CLI token still skips it (the local CLI's own backup path)", async () => {
    expect((await get({ "x-9r-cli-token": "real-cli-token" })).status).toBe(200);
    expect((await post({ "x-9r-cli-token": "real-cli-token" }, { settings: {} })).status).toBe(200);
  });

  it("the dashboard password still works, and a wrong one does not", async () => {
    expect((await get({ "x-9r-password": "correct-password" })).status).toBe(200);
    expect((await get({ "x-9r-password": "wrong" })).status).toBe(401);
    expect((await post({}, { password: "correct-password", settings: {} })).status).toBe(200);
  });
});
