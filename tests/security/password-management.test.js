/**
 * Dashboard password management.
 *
 * The rule these tests defend is that a password someone chose survives every
 * path that touches it — a reset, a change, a restart — and that at no point is
 * it readable back out of the API, the database column, or the log stream.
 *
 * bcrypt is real here, not stubbed. "The stored value is a bcrypt hash of what
 * was typed" is the property under test, and a mocked hasher would assert only
 * that the mock was called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status ?? 200, body, headers: init?.headers })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

// Pulled in by the settings route; stubbed so the import stays a unit import.
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

const { POST: resetPassword } = await import("../../src/app/api/auth/reset-password/route.js");
const { GET: readSettings, PATCH: patchSettings } = await import("../../src/app/api/settings/route.js");

/** A request carrying a JSON body. */
const withBody = (body) => ({ json: async () => body });

/** The request the legacy CLI sends: POST with no body at all. */
const withoutBody = {
  json: async () => {
    throw new SyntaxError("Unexpected end of JSON input");
  },
};

/** The hash handed to updateSettings by the most recent call. */
const storedPassword = () => mocks.updateSettings.mock.calls.at(-1)?.[0]?.password;

const BCRYPT_HASH = /^\$2[aby]\$/;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ password: "an-existing-hash" });
  mocks.updateSettings.mockImplementation(async (patch) => ({ ...patch }));
});

describe("POST /api/auth/reset-password with a password the operator chose", () => {
  const CHOSEN = "a-password-i-can-remember";

  it("stores a bcrypt hash of it and hands back no credential", async () => {
    const response = await resetPassword(withBody({ newPassword: CHOSEN }));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.userProvided).toBe(true);
    expect(response.body.shownOnce).toBe(false);
    expect(response.body.credential).toBeNull();

    const stored = storedPassword();
    expect(stored).toMatch(BCRYPT_HASH);
    expect(stored).not.toContain(CHOSEN);
    expect(await bcrypt.compare(CHOSEN, stored)).toBe(true);
  });

  it("never puts the password in the response body", async () => {
    const response = await resetPassword(withBody({ newPassword: CHOSEN }));
    expect(JSON.stringify(response.body)).not.toContain(CHOSEN);
  });

  it("never logs the password", async () => {
    const spies = ["log", "warn", "error", "info", "debug"].map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    );

    await resetPassword(withBody({ newPassword: CHOSEN }));

    const written = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(written).not.toContain(CHOSEN);
  });

  it("does not write the plaintext into the settings row", async () => {
    await resetPassword(withBody({ newPassword: CHOSEN }));
    expect(JSON.stringify(mocks.updateSettings.mock.calls)).not.toContain(CHOSEN);
  });

  it("rejects an empty password instead of reporting success", async () => {
    const response = await resetPassword(withBody({ newPassword: "" }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only password", async () => {
    const response = await resetPassword(withBody({ newPassword: "   " }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-string password", async () => {
    const response = await resetPassword(withBody({ newPassword: 123456 }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reset-password without a password", () => {
  it("keeps the random fallback for callers that send no body", async () => {
    const response = await resetPassword(withoutBody);

    expect(response.status).toBe(200);
    expect(response.body.shownOnce).toBe(true);
    expect(response.body.userProvided).toBe(false);
    expect(response.body.credential).toHaveLength(26);
    // Still no default literal: the fallback generates, it does not clear to one.
    expect(response.body.credential).not.toBe("123456");
    expect(await bcrypt.compare(response.body.credential, storedPassword())).toBe(true);
  });

  it("treats an unreadable body the same as an absent one", async () => {
    const response = await resetPassword({ json: async () => "not-an-object" });
    expect(response.body.shownOnce).toBe(true);
    expect(response.body.credential).toHaveLength(26);
  });
});

describe("GET /api/settings", () => {
  it("never returns the stored hash", async () => {
    mocks.getSettings.mockResolvedValue({
      password: "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ",
      requireLogin: true,
    });

    const response = await readSettings();

    expect(response.body.password).toBeUndefined();
    expect(response.body.hasPassword).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("$2a$10$");
  });

  it("reports hasPassword false when nothing is set", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    expect((await readSettings()).body.hasPassword).toBe(false);
  });
});

describe("PATCH /api/settings password change", () => {
  const CURRENT = "the-old-one";

  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ password: bcrypt.hashSync(CURRENT, 10) });
  });

  it("accepts a valid change and retires the old password", async () => {
    const response = await patchSettings(
      withBody({ currentPassword: CURRENT, newPassword: "the-new-one" })
    );

    expect(response.status).toBe(200);

    const stored = storedPassword();
    expect(stored).toMatch(BCRYPT_HASH);
    expect(await bcrypt.compare("the-new-one", stored)).toBe(true);
    // The property that matters after a change: the old password is dead.
    expect(await bcrypt.compare(CURRENT, stored)).toBe(false);
  });

  it("never echoes the password or the hash back", async () => {
    const response = await patchSettings(
      withBody({ currentPassword: CURRENT, newPassword: "the-new-one" })
    );
    expect(response.body.password).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("the-new-one");
    expect(JSON.stringify(response.body)).not.toContain(storedPassword());
  });

  it("rejects a wrong current password without touching storage", async () => {
    const response = await patchSettings(
      withBody({ currentPassword: "not-the-old-one", newPassword: "the-new-one" })
    );

    expect(response.status).toBe(401);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("requires a current password when one is stored", async () => {
    const response = await patchSettings(withBody({ newPassword: "the-new-one" }));
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty new password instead of reporting success", async () => {
    const response = await patchSettings(
      withBody({ currentPassword: CURRENT, newPassword: "" })
    );
    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("still refuses any current password when no hash is stored", async () => {
    mocks.getSettings.mockResolvedValue({});
    const response = await patchSettings(
      withBody({ currentPassword: "123456", newPassword: "the-new-one" })
    );
    expect(response.status).toBe(401);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("cannot mass-assign the password field directly", async () => {
    mocks.getSettings.mockResolvedValue({ password: bcrypt.hashSync(CURRENT, 10) });
    await patchSettings(withBody({ password: "injected-hash", requireLogin: true }));
    expect(mocks.updateSettings.mock.calls.at(-1)[0]).not.toHaveProperty("password");
  });
});

describe("secret redaction covers the password fields", () => {
  it("treats newPassword and currentPassword as secret keys", async () => {
    const { isSecretKey } = await import("@/lib/security/redact.js");
    expect(isSecretKey("newPassword")).toBe(true);
    expect(isSecretKey("currentPassword")).toBe(true);
    expect(isSecretKey("password")).toBe(true);
  });
});
