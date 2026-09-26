/**
 * /v1/search must not let a caller redirect an authenticated provider call.
 *
 * `body.provider_options.baseUrl` flows into resolveBaseUrl(), and every request
 * builder attaches the stored upstream credential (params.token) to the URL it
 * returns. The only check was assertPublicUrl(), which stops private targets but
 * not public ones: any holder of a router API key could name their own host and
 * receive the admin's Serper/Brave/Exa/... key in a request header.
 *
 * assertPublicUrl() itself also missed IPv4-mapped IPv6 in the form WHATWG URL
 * actually produces ([::ffff:169.254.169.254] parses to [::ffff:a9fe:a9fe]), the
 * fe80::/10 link-local range beyond fe80::, and CGNAT 100.64.0.0/10 (which holds
 * Alibaba Cloud's metadata endpoint).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSearchRequest, resolveBaseUrl } from "../../open-sse/handlers/search/callers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { assertPublicUrl } from "../../src/shared/utils/ssrfGuard.js";

const SECRET = "serper-admin-key-do-not-leak";
const ATTACKER = "https://collector.attacker.example";
const SERPER = { id: "serper", baseUrl: "https://google.serper.dev", method: "POST", authType: "apikey", searchTypes: ["web"] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a client-supplied baseUrl never receives the stored credential", () => {
  it("rejects provider_options.baseUrl when the provider sends a credential", () => {
    const params = { query: "q", searchType: "web", maxResults: 5, token: SECRET, providerOptions: { baseUrl: ATTACKER } };
    expect(() => buildSearchRequest(SERPER, params)).toThrow(/not allowed/);
  });

  it("end to end: the attacker host is never contacted and the call fails as a 400", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSearchCore({
      body: { query: "q", provider_options: { baseUrl: ATTACKER } },
      provider: { id: "serper" },
      providerConfig: SERPER,
      credentials: { apiKey: SECRET },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("attacker");
      expect(JSON.stringify(init?.headers ?? {})).not.toContain(SECRET);
    }
  });

  it("still honours an admin-configured baseUrl (connection providerSpecificData)", () => {
    const params = { token: SECRET, providerSpecificData: { baseUrl: "https://serper-proxy.example.com/" } };
    expect(resolveBaseUrl(SERPER, params)).toBe("https://serper-proxy.example.com");
  });

  it("keeps the override for keyless providers, where there is nothing to leak", () => {
    const searxng = { id: "searxng", baseUrl: "https://searxng.example.com", authType: "none" };
    expect(resolveBaseUrl(searxng, { providerOptions: { baseUrl: "https://my-searxng.example.org" } })).toBe(
      "https://my-searxng.example.org"
    );
  });

  it("uses the provider default when nothing overrides it", () => {
    expect(resolveBaseUrl(SERPER, { token: SECRET })).toBe("https://google.serper.dev");
  });
});

describe("assertPublicUrl blocks private targets in the forms URL parsing produces", () => {
  const blocked = [
    // IPv4-mapped IPv6: WHATWG serialises these as hex, never dotted.
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[::ffff:10.0.0.1]/",
    // fe80::/10 link-local, not only the fe80:: prefix
    "http://[fe90::1]/",
    "http://[febf::1]/",
    // CGNAT, including Alibaba Cloud metadata
    "http://100.100.100.200/latest/meta-data",
    "http://100.64.0.1/",
    // Previously covered; kept as a floor.
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[::]/",
    "http://169.254.169.254/",
    "http://localhost/",
  ];
  it.each(blocked)("blocks %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow(/Blocked URL/);
  });

  const allowed = [
    "https://example.com/",
    "http://93.184.216.34/",
    "http://100.63.255.255/", // just below CGNAT
    "http://100.128.0.1/", // just above CGNAT
    "http://[::ffff:93.184.216.34]/", // mapped public IPv4
    "http://[2606:2800:220:1:248:1893:25c8:1946]/",
  ];
  it.each(allowed)("allows %s", (url) => {
    expect(() => assertPublicUrl(url)).not.toThrow();
  });
});
