/**
 * Startup security bootstrap (M0 section 2).
 *
 * The requirements this file covers are all refusals or first-run side effects:
 * a random credential generated on first run and shown once, a master key that
 * comes from the environment or the OS keychain, and a refusal to start at all
 * when credentials cannot be protected or the bind is unsafe.
 *
 * The credential file and the keyfile are inspected on disk rather than through a
 * mock, because "shown once" and "mode 0600" are properties of the file, and a
 * bootstrap whose file-writing is stubbed proves nothing about either.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let DIR;
const SAVED = {};
const ENV_KEYS = [
  "DXR_DATA_DIR",
  "DATA_DIR",
  "DXR_MASTER_KEY",
  "DXR_KEY_STORE",
  "INITIAL_PASSWORD",
  "DXR_BOOTSTRAP_NO_EXIT",
  "DXR_ALLOW_NETWORK",
  "HOSTNAME",
];

const KEY_HEX = "ab".repeat(32);

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-bootstrap-"));
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DXR_DATA_DIR = DIR;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* the OS reclaims the temp directory either way */
  }
});

beforeEach(() => {
  global._dxrMasterKey = null;
  global._dxrSecurityBootstrap = null;
  global._dxrFlags = null;
  delete process.env.DXR_MASTER_KEY;
  delete process.env.DXR_KEY_STORE;
  delete process.env.INITIAL_PASSWORD;
  vi.restoreAllMocks();
});

/** Import a security module against the current environment, cache-free. */
async function fresh(specifier) {
  vi.resetModules();
  return import(specifier);
}

function silence() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("generated first-run credential", () => {
  it("is long, uniform, and free of ambiguous characters", async () => {
    const { generateCredential } = await fresh("@/lib/security/bootstrapCredential.js");
    const c = generateCredential();
    expect(c).toHaveLength(26);
    // O/0 and I/l/1 are excluded so a credential read off a console cannot be
    // mistyped into a lockout.
    expect(c).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]+$/);
  });

  it("does not repeat itself across a large sample", async () => {
    const { generateCredential } = await fresh("@/lib/security/bootstrapCredential.js");
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(generateCredential());
    expect(seen.size).toBe(500);
  });

  it("honours an explicit length", async () => {
    const { generateCredential } = await fresh("@/lib/security/bootstrapCredential.js");
    expect(generateCredential(40)).toHaveLength(40);
  });
});

describe("ensureDashboardCredential", () => {
  function store(initial = {}) {
    const settings = { ...initial };
    return {
      settings,
      getSettings: async () => ({ ...settings }),
      updateSettings: async (patch) => Object.assign(settings, patch),
      hash: async (pw) => `hashed:${pw}`,
    };
  }

  it("generates, stores and shows a credential when nothing is set", async () => {
    const { ensureDashboardCredential, INITIAL_CREDENTIAL_FILE } = await fresh(
      "@/lib/security/bootstrapCredential.js"
    );
    const spies = silence();
    const s = store();

    const result = await ensureDashboardCredential(s);

    expect(result.status).toBe("generated");
    expect(s.settings.password).toMatch(/^hashed:/);
    const credential = s.settings.password.slice("hashed:".length);
    expect(credential).toHaveLength(26);

    // Shown once: on stdout and in a file, and nowhere else.
    const banner = spies.log.mock.calls.flat().join("\n");
    expect(banner).toContain(credential);
    expect(banner).toMatch(/FIRST RUN/);

    const file = INITIAL_CREDENTIAL_FILE();
    expect(result.file).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toContain(credential);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    }
  });

  it("stores no default password — the credential is never a known literal", async () => {
    const { ensureDashboardCredential } = await fresh("@/lib/security/bootstrapCredential.js");
    silence();
    const s = store();
    await ensureDashboardCredential(s);
    expect(s.settings.password).not.toBe("hashed:123456");
  });

  it("uses INITIAL_PASSWORD when the operator set one, without writing a file", async () => {
    process.env.INITIAL_PASSWORD = "operator-chosen-secret";
    const { ensureDashboardCredential, INITIAL_CREDENTIAL_FILE } = await fresh(
      "@/lib/security/bootstrapCredential.js"
    );
    silence();
    try {
      fs.rmSync(INITIAL_CREDENTIAL_FILE(), { force: true });
    } catch {
      /* not present */
    }
    const s = store();

    const result = await ensureDashboardCredential(s);

    expect(result.status).toBe("env");
    expect(s.settings.password).toBe("hashed:operator-chosen-secret");
    expect(fs.existsSync(INITIAL_CREDENTIAL_FILE())).toBe(false);
  });

  it("leaves an existing credential alone", async () => {
    const { ensureDashboardCredential } = await fresh("@/lib/security/bootstrapCredential.js");
    const s = store({ password: "hashed:already-set" });
    expect(await ensureDashboardCredential(s)).toEqual({ status: "existing" });
    expect(s.settings.password).toBe("hashed:already-set");
  });

  it("reports a failure instead of inventing a credential when settings are unreadable", async () => {
    const { ensureDashboardCredential } = await fresh("@/lib/security/bootstrapCredential.js");
    const result = await ensureDashboardCredential({
      getSettings: async () => {
        throw new Error("database is locked");
      },
      updateSettings: async () => {
        throw new Error("should not be called");
      },
      hash: async () => "x",
    });
    expect(result).toEqual({ status: "failed", error: "database is locked" });
  });

  it("shows the credential exactly once — the file is consumed at first login", async () => {
    const { ensureDashboardCredential, consumeInitialCredentialFile, INITIAL_CREDENTIAL_FILE } = await fresh(
      "@/lib/security/bootstrapCredential.js"
    );
    silence();
    await ensureDashboardCredential(store());
    const file = INITIAL_CREDENTIAL_FILE();
    expect(fs.existsSync(file)).toBe(true);

    expect(consumeInitialCredentialFile()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // Idempotent: a second login must not fail because the file is already gone.
    expect(consumeInitialCredentialFile()).toBe(false);
  });
});

describe("master key resolution", () => {
  it("takes DXR_MASTER_KEY as 64 hex characters", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { getMasterKeySync, getMasterKeySource } = await fresh("@/lib/security/masterKey.js");
    expect(getMasterKeySync().toString("hex")).toBe(KEY_HEX);
    expect(getMasterKeySource()).toBe("env");
  });

  it("also accepts 32 bytes of base64", async () => {
    process.env.DXR_MASTER_KEY = Buffer.from(KEY_HEX, "hex").toString("base64");
    const { getMasterKeySync } = await fresh("@/lib/security/masterKey.js");
    expect(getMasterKeySync().toString("hex")).toBe(KEY_HEX);
  });

  it("refuses a key of the wrong size rather than stretching it", async () => {
    process.env.DXR_MASTER_KEY = "tooshort";
    const { resolveMasterKey } = await fresh("@/lib/security/masterKey.js");
    try {
      resolveMasterKey();
      throw new Error("should have refused");
    } catch (e) {
      expect(e.code).toBe("MASTER_KEY_INVALID");
      // Hashing a short passphrase into 32 bytes would silently accept a weak
      // key; the remedy tells the operator how to generate a real one.
      expect(e.remedy).toMatch(/randomBytes\(32\)/);
    }
  });

  it("caches the resolved key, so credentials stay readable within a process", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { getMasterKeySync, __resetMasterKeyCache } = await fresh("@/lib/security/masterKey.js");
    const first = getMasterKeySync();
    process.env.DXR_MASTER_KEY = "cd".repeat(32);
    expect(getMasterKeySync()).toBe(first);
    __resetMasterKeyCache();
    expect(getMasterKeySync().toString("hex")).toBe("cd".repeat(32));
  });

  it("writes a private keyfile under DXR_KEY_STORE=file, warns, and reuses it", async () => {
    process.env.DXR_KEY_STORE = "file";
    const keyfile = path.join(DIR, "master.key");
    fs.rmSync(keyfile, { force: true });

    const spies = silence();
    const { getMasterKeySync, getMasterKeySource, __resetMasterKeyCache } = await fresh(
      "@/lib/security/masterKey.js"
    );
    const key = getMasterKeySync();

    expect(getMasterKeySource()).toBe("file");
    expect(key).toHaveLength(32);
    // The keyfile lives in the one data root, not next to the repo.
    expect(fs.existsSync(keyfile)).toBe(true);
    expect(fs.readFileSync(keyfile, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(keyfile).mode & 0o077).toBe(0);
    }
    // Storing the key beside the database it protects is a real downgrade, so it
    // is never silent.
    expect(spies.warn.mock.calls.flat().join(" ")).toMatch(/DXR_KEY_STORE=file/);

    // A rotating key would make every previously stored credential unreadable.
    __resetMasterKeyCache();
    expect(getMasterKeySync().toString("hex")).toBe(key.toString("hex"));
  });

  it("prefers DXR_MASTER_KEY over the keyfile", async () => {
    process.env.DXR_KEY_STORE = "file";
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { getMasterKeySync, getMasterKeySource } = await fresh("@/lib/security/masterKey.js");
    expect(getMasterKeySource()).toBe("env");
    expect(getMasterKeySync().toString("hex")).toBe(KEY_HEX);
  });

  it("isEncryptionAvailable answers without throwing either way", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const ok = await fresh("@/lib/security/masterKey.js");
    expect(ok.isEncryptionAvailable()).toBe(true);

    global._dxrMasterKey = null;
    process.env.DXR_MASTER_KEY = "nope";
    const bad = await fresh("@/lib/security/masterKey.js");
    expect(bad.isEncryptionAvailable()).toBe(false);
  });
});

describe("runSecurityBootstrap", () => {
  const AUTH_ON = { requireLogin: true, requireApiKey: true, password: "hashed:already-set" };

  function deps(overrides = {}) {
    const settings = { ...(overrides.settings ?? AUTH_ON) };
    return {
      env: { HOSTNAME: "127.0.0.1", DXR_BOOTSTRAP_NO_EXIT: "1", ...(overrides.env ?? {}) },
      exit: vi.fn(),
      credentialDeps: {
        getSettings: async () => ({ ...settings }),
        updateSettings: async (patch) => Object.assign(settings, patch),
        hash: async (pw) => `hashed:${pw}`,
      },
      ...(overrides.loadSettings ? { loadSettings: overrides.loadSettings } : {}),
    };
  }

  it("reports every step on a healthy loopback start", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();
    const d = deps();

    const report = await runSecurityBootstrap(d);

    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
    expect(d.exit).not.toHaveBeenCalled();
    // One data root, named in the report, so a misconfiguration is visible at boot.
    expect(report.steps.dataRoot).toEqual({ path: DIR, source: "DXR_DATA_DIR" });
    expect(report.steps.masterKey).toEqual({ source: "env" });
    expect(report.steps.credential).toEqual({ status: "existing" });
    expect(report.steps.exposure).toEqual({ kind: "loopback", host: "127.0.0.1" });
    // The M0 acceptance gate: the engine is off and legacy routing is authoritative.
    expect(report.steps.flags.engine).toBe("off");
    expect(report.steps.flags.engineAuthority).toBe(false);
  });

  it("generates the first-run credential as part of booting", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const report = await runSecurityBootstrap(deps({ settings: { requireLogin: true, requireApiKey: true } }));

    expect(report.ok).toBe(true);
    expect(report.steps.credential.status).toBe("generated");
  });

  it("announces a flag this build cannot honour", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const report = await runSecurityBootstrap(deps({ env: { DXR_CACHE_ECONOMICS: "1" } }));

    expect(report.steps.unimplementedFlags.join(" ")).toMatch(/DXR_CACHE_ECONOMICS is set but cacheEconomics/);
  });

  it("refuses to start when credentials cannot be protected", async () => {
    process.env.DXR_MASTER_KEY = "not-a-key";
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    const spies = silence();
    const d = deps();

    const report = await runSecurityBootstrap(d);

    expect(report.ok).toBe(false);
    expect(report.error.code).toBe("MASTER_KEY_INVALID");
    // Refusal comes before the credential step: nothing is written to a database
    // that cannot protect what it stores.
    expect(report.steps.credential).toBeUndefined();
    const banner = spies.error.mock.calls.flat().join("\n");
    expect(banner).toMatch(/refused to start/);
    expect(banner).toMatch(/How to fix/);
  });

  it("exits non-zero on refusal unless the test seam is set", async () => {
    process.env.DXR_MASTER_KEY = "not-a-key";
    const { runSecurityBootstrap, __resetBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const noExit = deps();
    expect((await runSecurityBootstrap(noExit)).ok).toBe(false);
    expect(noExit.exit).not.toHaveBeenCalled();

    __resetBootstrap();
    global._dxrMasterKey = null;
    const exits = deps({ env: { DXR_BOOTSTRAP_NO_EXIT: undefined } });
    await runSecurityBootstrap(exits);
    expect(exits.exit).toHaveBeenCalledWith(1);
  });

  it("refuses an exposed bind that was not opted into", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const report = await runSecurityBootstrap(deps({ env: { HOSTNAME: "0.0.0.0" } }));

    expect(report.ok).toBe(false);
    expect(report.error.code).toBe("NETWORK_EXPOSURE_NOT_OPTED_IN");
  });

  it("refuses an exposed bind whose authentication was turned off", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const report = await runSecurityBootstrap(
      deps({
        env: { HOSTNAME: "0.0.0.0", DXR_ALLOW_NETWORK: "1" },
        settings: { ...AUTH_ON, requireLogin: false },
      })
    );

    expect(report.ok).toBe(false);
    expect(report.error.code).toBe("NETWORK_EXPOSURE_WITHOUT_AUTH");
  });

  it("refuses an exposed bind when the settings cannot be read", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const report = await runSecurityBootstrap(
      deps({
        env: { HOSTNAME: "0.0.0.0", DXR_ALLOW_NETWORK: "1" },
        loadSettings: async () => {
          throw new Error("database is locked");
        },
      })
    );

    expect(report.ok).toBe(false);
    expect(report.error.code).toBe("NETWORK_EXPOSURE_SETTINGS_UNKNOWN");
  });

  it("allows an exposed bind that opted in and kept authentication, loudly", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    const spies = silence();

    const report = await runSecurityBootstrap(deps({ env: { HOSTNAME: "0.0.0.0", DXR_ALLOW_NETWORK: "1" } }));

    expect(report.ok).toBe(true);
    expect(report.steps.exposure.kind).toBe("wildcard");
    expect(spies.warn.mock.calls.flat().join(" ")).toMatch(/Network-exposed/);
  });

  it("runs once per process, so a second import cannot re-show a credential", async () => {
    process.env.DXR_MASTER_KEY = KEY_HEX;
    const { runSecurityBootstrap } = await fresh("@/lib/security/bootstrap.js");
    silence();

    const d = deps();
    const first = await runSecurityBootstrap(d);
    const second = await runSecurityBootstrap({ ...d, credentialDeps: null });
    expect(second).toBe(first);
  });
});
