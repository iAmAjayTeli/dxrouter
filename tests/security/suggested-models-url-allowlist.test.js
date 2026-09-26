/**
 * /api/providers/suggested-models must only fetch the models catalogues the registry declares.
 *
 * The provider page asks the server to fetch a provider's public model list (to avoid
 * CORS) and passes the provider's `modelsFetcher.url` as `?url=`. The handler fetched
 * whatever URL it was given: any dashboard session — including one borrowed from a
 * tunnel or the LAN — could make the server request internal addresses or cloud
 * metadata (http://169.254.169.254/...) and learn from the response shape/timing.
 *
 * Every legitimate URL is a constant in open-sse/providers/registry/*.js, so the fix is
 * an exact allow-list of the registry's (type, url) pairs rather than an SSRF heuristic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");

const call = (url, type) =>
  GET({ url: `http://localhost:20128/api/providers/suggested-models?${new URLSearchParams({ url, type })}` });

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const declared = REGISTRY.map((p) => p?.modelsFetcher).filter((f) => f?.url && f?.type);

describe("suggested-models fetches only registry-declared catalogues", () => {
  it("the registry declares catalogues to test against", () => {
    expect(declared.length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/", "openrouter-free"],
    ["loopback service", "http://127.0.0.1:8080/admin", "openrouter-free"],
    ["LAN host", "http://192.168.1.1/", "opencode-free"],
    ["arbitrary public host", "https://attacker.example/models", "openrouter-free"],
    ["a declared host with a different path", "https://openrouter.ai/api/v1/keys", "openrouter-free"],
  ])("refuses %s without fetching", async (_label, url, type) => {
    const res = await call(url, type);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a declared URL paired with another provider's filter type", async () => {
    const res = await call("https://openrouter.ai/api/v1/models", "mimo-free");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fetches every declared catalogue whose filter exists", async () => {
    const { FILTERS } = await import("../../src/app/api/providers/suggested-models/filters.js");
    const usable = declared.filter((f) => FILTERS[f.type]);
    expect(usable.length).toBeGreaterThan(0);
    for (const f of usable) {
      fetchMock.mockClear();
      const res = await call(f.url, f.type);
      expect(res.status, f.url).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(f.url);
    }
  });
});
