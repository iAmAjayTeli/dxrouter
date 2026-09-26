import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS lookup so we control which host resolves to what IP.
// The guard calls lookup(host, { all: true }), which returns an ARRAY of
// { address, family } records — the mock must honour that contract, otherwise
// every lookup "fails" and the SSRF tests pass without exercising the guard.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const originalFetch = globalThis.fetch;

const records = (...addresses) => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

function mockFetchOnce(bytes, ok = true) {
  const body = {
    getReader() {
      let sent = false;
      return {
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }),
        cancel: async () => {},
      };
    },
  };
  globalThis.fetch = vi.fn(async () => ({ ok, body }));
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(records("93.184.216.34")); // public by default
  // Default upstream serves a valid PNG: a rejection can then only come from the guard.
  mockFetchOnce(PNG);
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

// Private/reserved target: must be rejected BEFORE any network call.
async function expectBlocked(url) {
  expect(await fetchImageAsBase64(url)).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
  });

  it("resolves with all:true so every A/AAAA record is checked", async () => {
    await fetchImageAsBase64("https://example.com/a.png");
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("SSRF: rejects private IP (10.x)", async () => {
    lookupMock.mockResolvedValue(records("10.0.0.5"));
    await expectBlocked("http://internal.example/x.png");
  });

  it("SSRF: rejects cloud metadata 169.254.169.254", async () => {
    lookupMock.mockResolvedValue(records("169.254.169.254"));
    await expectBlocked("http://metadata/x.png");
  });

  it("SSRF: rejects blocked hostname localhost", async () => {
    await expectBlocked("http://localhost/x.png");
  });

  it("SSRF: rejects IPv6 loopback", async () => {
    lookupMock.mockResolvedValue(records("::1"));
    await expectBlocked("http://x/y.png");
  });

  it("SSRF: rejects IPv6 unspecified :: (Linux connects it to loopback)", async () => {
    lookupMock.mockResolvedValue(records("::"));
    await expectBlocked("http://x/y.png");
  });

  it("SSRF: rejects the whole fe80::/10 link-local range, not only fe80::", async () => {
    for (const addr of ["fe80::1", "fe90::1", "feab::1", "febf::1"]) {
      lookupMock.mockResolvedValue(records(addr));
      await expectBlocked("http://x/y.png");
    }
  });

  it("SSRF: rejects IPv4-mapped private address", async () => {
    lookupMock.mockResolvedValue(records("::ffff:127.0.0.1"));
    await expectBlocked("http://x/y.png");
  });

  it("SSRF: rejects when ANY resolved record is private (multi-A rebinding)", async () => {
    lookupMock.mockResolvedValue(records("93.184.216.34", "192.168.1.10"));
    await expectBlocked("http://x/y.png");
  });

  it("SSRF: rejects when DNS returns no records", async () => {
    lookupMock.mockResolvedValue([]);
    await expectBlocked("http://x/y.png");
  });

  it("does not over-block a public IPv6 address", async () => {
    lookupMock.mockResolvedValue(records("2606:2800:220:1:248:1893:25c8:1946"));
    expect(await fetchImageAsBase64("https://example.com/a.png")).not.toBeNull();
  });

  it("accepts valid PNG from public host, without following redirects", async () => {
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).not.toBeNull();
    expect(r.mimeType).toBe("image/png");
    expect(r.url.startsWith("data:image/png;base64,")).toBe(true);
    const [, init] = globalThis.fetch.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(init.dispatcher).toBeDefined();
  });

  it("rejects disguised non-image payload (magic byte mismatch)", async () => {
    mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
  });

  it("rejects payload over size cap", async () => {
    mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
  });

  it("returns null when fetch not ok", async () => {
    mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
  });
});
