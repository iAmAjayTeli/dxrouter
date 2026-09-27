/**
 * POST /api/oauth/gitlab/pat must not turn into a read-anything proxy.
 *
 * The route verifies a Personal Access Token by fetching `${baseUrl}/api/v4/user`,
 * where baseUrl comes from the request body (self-hosted GitLab is a real use case, so
 * the host cannot simply be restricted). On a non-2xx reply it returned the upstream
 * body verbatim — `GitLab token verification failed: ${await res.text()}` — and on a
 * 2xx reply that is not JSON the parser's message (which quotes the start of the body)
 * came back as the error. With `?` in baseUrl absorbing the fixed suffix, any dashboard
 * session could point the server at an internal URL and read the response.
 *
 * The verification result is all the dashboard needs: status, not the upstream body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ createProviderConnection: vi.fn(async () => ({ id: "c1" })) }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("@/models", () => ({ createProviderConnection: mocks.createProviderConnection }));

const { POST } = await import("../../src/app/api/oauth/gitlab/pat/route.js");

const INTERNAL_BODY = "INTERNAL-ADMIN-PAGE secret=hunter2 db_password=swordfish";
const call = (body) => POST({ json: async () => body });

let fetchMock;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("gitlab PAT verification does not reflect upstream bodies", () => {
  it("a non-2xx upstream body is not returned to the caller", async () => {
    fetchMock.mockResolvedValue(new Response(INTERNAL_BODY, { status: 403, statusText: "Forbidden" }));
    const res = await call({ token: "glpat-x", baseUrl: "http://10.0.0.5:8080/admin?" });

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(JSON.stringify(res.body)).not.toContain("INTERNAL-ADMIN-PAGE");
    expect(res.body.error).toMatch(/403/); // still says what happened
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("a 2xx non-JSON upstream body is not quoted back through a parse error", async () => {
    fetchMock.mockResolvedValue(new Response(INTERNAL_BODY, { status: 200 }));
    const res = await call({ token: "glpat-x", baseUrl: "http://10.0.0.5:8080/admin?" });

    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("INTERNAL");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("a real GitLab user response still creates the connection, self-hosted base included", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 7, username: "dev", name: "Dev", email: "dev@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await call({ token: "glpat-x", baseUrl: "https://gitlab.internal.example/" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://gitlab.internal.example/api/v4/user", expect.anything());
    expect(mocks.createProviderConnection).toHaveBeenCalledTimes(1);
    expect(mocks.createProviderConnection.mock.calls[0][0].providerSpecificData.baseUrl).toBe(
      "https://gitlab.internal.example"
    );
  });
});
