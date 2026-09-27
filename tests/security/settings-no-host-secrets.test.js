/**
 * /api/settings must not hand the host's stored sudo password to dashboard sessions.
 *
 * The MITM/Tailscale flows cache the operator's sudo password in settings as
 * `mitmSudoEncrypted` (src/mitm/manager.js). Its key is sha256(machine id + a fixed
 * salt), or sha256(the salt) alone when node-machine-id is unavailable, so the
 * ciphertext is only as secret as the machine id. The PATCH handler already refused to
 * let a caller WRITE it (PROTECTED_SETTING_KEYS), but GET and the PATCH response
 * returned the whole settings row minus password and oidcClientSecret, so every
 * dashboard session (tunnel/LAN included) received it. No client reads it: the UI
 * learns "a password is cached" from the local-only MITM/Tailscale status routes
 * (`hasCachedPassword`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status ?? 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, updateSettings: mocks.updateSettings }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

const SUDO_CIPHERTEXT = "a1b2c3d4e5f6a7b8c9d0e1f2:0f1e2d3c4b5a69788796a5b4c3d2e1f0:deadbeefcafe";
const STORED = {
  password: "$2a$10$storedhash",
  oidcClientSecret: "oidc-secret",
  oidcIssuerUrl: "https://idp.example",
  oidcClientId: "client",
  mitmSudoEncrypted: SUDO_CIPHERTEXT,
  tunnelEnabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ ...STORED });
  mocks.updateSettings.mockImplementation(async (patch) => ({ ...STORED, ...patch }));
});

describe("settings responses omit host secrets", () => {
  it("GET does not return the encrypted sudo password", async () => {
    const res = await GET();
    expect(res.body).not.toHaveProperty("mitmSudoEncrypted");
    expect(JSON.stringify(res.body)).not.toContain(SUDO_CIPHERTEXT);
  });

  it("the PATCH response does not return it either", async () => {
    const res = await PATCH({ json: async () => ({ tunnelEnabled: true }) });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("mitmSudoEncrypted");
    expect(JSON.stringify(res.body)).not.toContain(SUDO_CIPHERTEXT);
  });

  it("existing redactions and fields are unchanged", async () => {
    const res = await GET();
    expect(res.body).not.toHaveProperty("password");
    expect(res.body).not.toHaveProperty("oidcClientSecret");
    expect(res.body.oidcConfigured).toBe(true);
    expect(res.body.hasPassword).toBe(true);
    expect(res.body.tunnelEnabled).toBe(false);
  });

  it("a caller still cannot write it", async () => {
    await PATCH({ json: async () => ({ mitmSudoEncrypted: "attacker-value" }) });
    expect(mocks.updateSettings.mock.calls[0][0]).not.toHaveProperty("mitmSudoEncrypted");
  });
});
