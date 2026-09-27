/**
 * POST /api/settings/proxy-test tests a proxy against a fixed target, not a caller-chosen one.
 *
 * The route forwarded `body.testUrl` to testProxyUrl(), which HEADs that URL through the
 * proxy and returns its status. No caller sends testUrl: the dashboard sends only
 * `{ proxyUrl }`, and every internal caller (provider test, proxy-pool test) uses the
 * default. So the parameter did nothing but let a session pick the destination: point
 * proxyUrl at the operator's own (often LAN or corporate) proxy and testUrl at an
 * internal address, and read back its status through that proxy.
 *
 * The proxy URL itself stays caller-chosen. Testing a proxy the operator is about to
 * save, frequently on localhost or the LAN, is the feature.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  testProxyUrl: vi.fn(async () => ({ ok: true, status: 200, url: "https://google.com/" })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));

const { POST } = await import("../../src/app/api/settings/proxy-test/route.js");
const call = (body) => POST({ json: async () => body });

beforeEach(() => vi.clearAllMocks());

describe("proxy-test uses the built-in test target", () => {
  it("ignores a caller-supplied testUrl", async () => {
    await call({ proxyUrl: "http://10.0.0.2:3128", testUrl: "http://169.254.169.254/latest/meta-data/" });

    expect(mocks.testProxyUrl).toHaveBeenCalledTimes(1);
    const args = mocks.testProxyUrl.mock.calls[0][0];
    expect(args.testUrl).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain("169.254.169.254");
  });

  it("still tests the proxy the caller supplied (the feature)", async () => {
    const res = await call({ proxyUrl: "http://127.0.0.1:7890" });

    expect(res.status).toBe(200);
    expect(mocks.testProxyUrl.mock.calls[0][0].proxyUrl).toBe("http://127.0.0.1:7890");
  });
});
