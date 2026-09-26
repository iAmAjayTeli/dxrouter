/**
 * Password persistence across restarts, against the real database.
 *
 * Everything else in this area is tested with a stubbed `updateSettings`, which
 * proves the route hashes correctly but says nothing about whether the hash
 * survives being written and read back. This file uses the real SQLite layer
 * under a temporary data root, so "the password you chose still works after a
 * restart" is checked where it can actually break.
 *
 * A restart is simulated by dropping the module registry and re-importing, which
 * is what the server does on boot; the state under test lives in the database
 * file, not in the process, so nothing is lost in the simulation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let DIR;

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-password-"));
  process.env.DXR_DATA_DIR = DIR;
});

afterAll(() => {
  delete process.env.DXR_DATA_DIR;
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* the OS reclaims the temp directory either way */
  }
});

beforeEach(() => {
  vi.resetModules();
});

/** A fresh import of the real modules, as a new process would get. */
async function boot() {
  const { getSettings, updateSettings } = await import("@/lib/localDb");
  const { ensureDashboardCredential, consumeInitialCredentialFile } = await import(
    "@/lib/security/bootstrapCredential.js"
  );
  return { getSettings, updateSettings, ensureDashboardCredential, consumeInitialCredentialFile };
}

/** Every byte under the data root, for "is the plaintext on disk" checks. */
function dataRootBytes() {
  const chunks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else chunks.push(fs.readFileSync(full));
    }
  };
  walk(DIR);
  return Buffer.concat(chunks).toString("latin1");
}

/** The reset route, with the real database behind it. */
async function resetRoute() {
  return import("../../src/app/api/auth/reset-password/route.js");
}

/** The settings route, with the real database behind it. */
async function settingsRoute() {
  return import("../../src/app/api/settings/route.js");
}

/**
 * A real Request, so the routes parse bodies exactly as they do in production.
 *
 * The fallback path rests on `request.json()` rejecting an empty body, and a
 * hand-rolled stub would assert that assumption rather than test it.
 */
function post(body) {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const silent = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("a chosen password survives restarts", () => {
  const CHOSEN = "chosen-password-that-persists";

  it("is stored once and still verifies after every subsequent boot", async () => {
    silent();

    // First boot: nothing stored, so the server provisions a credential.
    const first = await boot();
    expect(await first.ensureDashboardCredential({
      getSettings: first.getSettings,
      updateSettings: first.updateSettings,
      hash: (pw) => bcrypt.hash(pw, 10),
    })).toMatchObject({ status: "generated" });

    // The operator sets one they can remember, through the real route.
    const { POST } = await resetRoute();
    const response = await POST(post({ newPassword: CHOSEN }));
    expect(response.status).toBe(200);
    expect((await response.json()).credential).toBeNull();

    // Restart.
    vi.resetModules();
    const second = await boot();
    const afterRestart = await second.getSettings();
    expect(await bcrypt.compare(CHOSEN, afterRestart.password)).toBe(true);

    // Restarting must not mint a replacement.
    expect(await second.ensureDashboardCredential({
      getSettings: second.getSettings,
      updateSettings: second.updateSettings,
      hash: (pw) => bcrypt.hash(pw, 10),
    })).toEqual({ status: "existing" });

    vi.resetModules();
    const third = await boot();
    expect(await bcrypt.compare(CHOSEN, (await third.getSettings()).password)).toBe(true);
  });

  it("leaves no plaintext password anywhere under the data root", () => {
    expect(dataRootBytes()).not.toContain(CHOSEN);
  });

  it("survives a change, with the old password retired", async () => {
    silent();
    const NEXT = "the-replacement-password";
    const CURRENT = "the-password-before-the-change";

    const { POST } = await resetRoute();
    await POST(post({ newPassword: CURRENT }));

    const { PATCH } = await settingsRoute();
    const response = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: CURRENT, newPassword: NEXT }),
      })
    );
    expect(response.status).toBe(200);

    vi.resetModules();
    const after = await boot();
    const stored = (await after.getSettings()).password;

    expect(await bcrypt.compare(NEXT, stored)).toBe(true);
    expect(await bcrypt.compare(CURRENT, stored)).toBe(false);
    expect(dataRootBytes()).not.toContain(NEXT);
    expect(dataRootBytes()).not.toContain(CURRENT);
  });
});

describe("the random fallback still provisions a working login", () => {
  it("returns a credential once and stores a hash that verifies", async () => {
    silent();
    const { POST } = await resetRoute();
    // No body at all — what the legacy CLI sends, and the case the random
    // fallback exists for.
    const response = await POST(post());

    const body = await response.json();
    expect(body.shownOnce).toBe(true);
    const credential = body.credential;
    expect(credential).toHaveLength(26);

    vi.resetModules();
    const after = await boot();
    expect(await bcrypt.compare(credential, (await after.getSettings()).password)).toBe(true);
    // The generated credential is shown once in the response, never written to disk.
    expect(dataRootBytes()).not.toContain(credential);
  });
});

describe("the stored hash stays out of the settings API", () => {
  it("reports only that a password exists", async () => {
    silent();
    const { POST } = await resetRoute();
    await POST(post({ newPassword: "listed-nowhere" }));

    vi.resetModules();
    const { GET } = await settingsRoute();
    const response = await GET();
    const body = await response.json();

    expect(body.hasPassword).toBe(true);
    expect(body.password).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("$2");
  });
});

describe("the hash is on disk, readable by a separate process", () => {
  const PASSWORD = "survives-a-real-process-boundary";

  it("verifies from a freshly spawned process reading the database file", async () => {
    silent();
    const { POST } = await resetRoute();
    await POST(post({ newPassword: PASSWORD }));

    // A real second process, reading the file directly. `vi.resetModules()` only
    // clears this process's module registry; this proves the value is actually
    // committed to disk rather than living in a cache that a restart would drop.
    const reader = path.join(DIR, "read-password.mjs");
    fs.writeFileSync(
      reader,
      [
        'import { DatabaseSync } from "node:sqlite";',
        "const db = new DatabaseSync(process.argv[2], { readOnly: true });",
        'const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();',
        "process.stdout.write(JSON.parse(row.data).password ?? \"\");",
      ].join("\n")
    );

    const stored = execFileSync(process.execPath, [reader, path.join(DIR, "db", "data.sqlite")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000, // a sync spawn blocks the worker; testTimeout cannot interrupt it
    });

    expect(stored).toMatch(/^\$2[aby]\$/);
    expect(stored).not.toContain(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, stored)).toBe(true);
  });
});

describe("the reset route is still local-only", () => {
  const REMOTE = { Host: "gateway.example.com", Origin: "https://gateway.example.com" };

  function request(headers = {}) {
    return new Request("http://gateway.example.com/api/auth/reset-password", {
      method: "POST",
      headers,
    });
  }

  it("refuses a remote caller that has no CLI token", async () => {
    const { canAccessLocalOnlyRoute } = (await import("@/dashboardGuard.js")).__test__;
    expect(await canAccessLocalOnlyRoute(request(REMOTE))).toBe(false);
  });

  it("refuses a remote caller presenting a wrong token", async () => {
    const { canAccessLocalOnlyRoute } = (await import("@/dashboardGuard.js")).__test__;
    expect(await canAccessLocalOnlyRoute(request({ ...REMOTE, "x-9r-cli-token": "deadbeefdeadbeef" }))).toBe(
      false
    );
  });

  it("admits the local CLI presenting the token it derives", async () => {
    const { canAccessLocalOnlyRoute } = (await import("@/dashboardGuard.js")).__test__;
    const { getConsistentMachineId } = await import("@/shared/utils/machineId.js");
    // Exactly what cli/src/cli/api/client.js computes from the same data root.
    const token = await getConsistentMachineId("9r-cli-auth");

    expect(await canAccessLocalOnlyRoute(request({ ...REMOTE, "x-9r-cli-token": token }))).toBe(true);
  });
});
