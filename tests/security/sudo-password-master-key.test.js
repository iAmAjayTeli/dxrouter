/**
 * The cached host sudo password (settings.mitmSudoEncrypted) is protected by the DXR
 * master key, with a one-way, idempotent migration of legacy records.
 *
 * src/mitm/manager.js used to encrypt it with AES-256-GCM under
 * sha256(machineId + "9router-mitm-pwd"), or sha256("9router-mitm-pwd") alone when
 * node-machine-id failed, and stored `ivHex:tagHex:ctHex`. That key is derivable by
 * anyone who knows the machine id (or nothing at all, on the fallback path). Every other
 * secret at rest in DXRouter uses the master key and the `dxr1:` envelope
 * (src/lib/security/crypto.js), so this one now does too.
 *
 * Everything here is real: the settings live in a real SQLite database under a temp
 * data dir, the master key comes from DXR_MASTER_KEY through masterKey.js, and legacy
 * fixtures are produced by the exact legacy algorithm with the real node-machine-id.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import machineId from "node-machine-id";

const TEST_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const PLAINTEXT = "sudo-pass-Zq81-do-not-persist";

const saved = {
  DXR_DATA_DIR: process.env.DXR_DATA_DIR,
  DXR_MASTER_KEY: process.env.DXR_MASTER_KEY,
  DXR_KEY_STORE: process.env.DXR_KEY_STORE,
  PATH: process.env.PATH,
};
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-sudo-mk-"));
const EMPTY_BIN = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-sudo-nobin-"));
process.env.DXR_DATA_DIR = DIR;
process.env.DXR_MASTER_KEY = TEST_KEY;

const { getSettings, updateSettings } = await import("../../src/lib/localDb.js");
const { __resetMasterKeyCache } = await import("../../src/lib/security/masterKey.js");
const { decryptSecret, ENVELOPE_PREFIX } = await import("../../src/lib/security/crypto.js");
const sudo = await import("../../src/lib/security/sudoSecret.js");
const managerMod = await import("../../src/mitm/manager.js");
const manager = managerMod.default || managerMod;

/** The exact pre-migration algorithm from src/mitm/manager.js (golden fixture writer). */
function legacyEncrypt(plaintext, { machineBound }) {
  const salt = "9router-mitm-pwd";
  const key = machineBound
    ? crypto.createHash("sha256").update(machineId.machineIdSync() + salt).digest()
    : crypto.createHash("sha256").update(salt).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

let writes = 0;
const countingUpdate = async (patch) => {
  if (Object.prototype.hasOwnProperty.call(patch, "mitmSudoEncrypted")) writes++;
  return updateSettings(patch);
};

const stored = async () => (await getSettings()).mitmSudoEncrypted;
const useKey = (hex) => {
  process.env.PATH = saved.PATH;
  delete process.env.DXR_KEY_STORE;
  process.env.DXR_MASTER_KEY = hex;
  __resetMasterKeyCache();
};
/**
 * No master key at all: DXR_MASTER_KEY unset and the OS keychain required but
 * unreachable (its CLI - powershell.exe / security / secret-tool - is not on PATH),
 * so masterKey.js refuses with MASTER_KEY_UNAVAILABLE on every platform.
 */
const useNoKey = () => {
  delete process.env.DXR_MASTER_KEY;
  process.env.DXR_KEY_STORE = "keychain";
  process.env.PATH = EMPTY_BIN;
  __resetMasterKeyCache();
};

/** Every byte the database layer has written under the data dir. */
function persistedBytes() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(fs.readFileSync(f));
    }
  };
  walk(DIR);
  return Buffer.concat(out);
}

beforeAll(() => {
  manager.initDbHooks(getSettings, countingUpdate);
});

beforeEach(async () => {
  useKey(TEST_KEY);
  writes = 0;
  await updateSettings({ mitmSudoEncrypted: null });
  writes = 0;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetMasterKeyCache();
  for (const d of [DIR, EMPTY_BIN]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

describe("legacy records migrate to the master key", () => {
  it.each([
    ["machine-id key", true],
    ["salt-only fallback key", false],
  ])("a legacy (%s) value decrypts and is rewritten as a dxr1 envelope", async (_label, machineBound) => {
    await updateSettings({ mitmSudoEncrypted: legacyEncrypt(PLAINTEXT, { machineBound }) });

    expect(await manager.loadEncryptedPassword()).toBe(PLAINTEXT);

    const after = await stored();
    expect(after.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(decryptSecret(after, Buffer.from(TEST_KEY, "hex"))).toBe(PLAINTEXT);
    expect(writes).toBe(1);
  });

  it("migration is idempotent: a second read writes nothing and changes nothing", async () => {
    await updateSettings({ mitmSudoEncrypted: legacyEncrypt(PLAINTEXT, { machineBound: true }) });
    await manager.loadEncryptedPassword();
    const first = await stored();
    writes = 0;

    expect(await manager.loadEncryptedPassword()).toBe(PLAINTEXT);
    expect(await stored()).toBe(first);
    expect(writes).toBe(0);
  });

  it("a migrated value still decrypts after a restart (fresh modules, fresh key cache)", async () => {
    await updateSettings({ mitmSudoEncrypted: legacyEncrypt(PLAINTEXT, { machineBound: true }) });
    await manager.loadEncryptedPassword();
    const migrated = await stored();

    vi.resetModules();
    const fresh = await import("../../src/lib/security/sudoSecret.js");
    const freshKeys = await import("../../src/lib/security/masterKey.js");
    freshKeys.__resetMasterKeyCache();
    expect(fresh.openSudoPassword(migrated)).toEqual({ plaintext: PLAINTEXT, format: "dxr1" });

    const freshManagerMod = await import("../../src/mitm/manager.js");
    const freshManager = freshManagerMod.default || freshManagerMod;
    freshManager.initDbHooks(getSettings, countingUpdate);
    writes = 0;
    expect(await freshManager.loadEncryptedPassword()).toBe(PLAINTEXT);
    expect(writes).toBe(0);
  });
});

describe("new writes use only the master key", () => {
  it("saving a password stores a dxr1 envelope, never the legacy format or plaintext", async () => {
    await manager.__test__.saveMitmSettings(true, PLAINTEXT);

    const value = await stored();
    expect(value.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(value).not.toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(value).not.toContain(PLAINTEXT);
    expect(decryptSecret(value, Buffer.from(TEST_KEY, "hex"))).toBe(PLAINTEXT);
    expect(await manager.loadEncryptedPassword()).toBe(PLAINTEXT);
  });

  it("the plaintext never reaches the database files", async () => {
    await manager.__test__.saveMitmSettings(true, PLAINTEXT);
    await updateSettings({ mitmSudoEncrypted: legacyEncrypt(PLAINTEXT, { machineBound: true }) });
    await manager.loadEncryptedPassword(); // migration path writes too
    expect(persistedBytes().includes(Buffer.from(PLAINTEXT, "utf8"))).toBe(false);
  });

  it("clearing still removes the stored password", async () => {
    await manager.__test__.saveMitmSettings(true, PLAINTEXT);
    await manager.clearEncryptedPassword();
    expect(await stored()).toBeNull();
    expect(await manager.loadEncryptedPassword()).toBeNull();
  });
});

describe("fails closed", () => {
  it("a wrong master key yields null and leaves the record untouched", async () => {
    await manager.__test__.saveMitmSettings(true, PLAINTEXT);
    const value = await stored();
    writes = 0;

    useKey(OTHER_KEY);
    expect(await manager.loadEncryptedPassword()).toBeNull();
    expect(await stored()).toBe(value);
    expect(writes).toBe(0);
  });

  it("a dxr1 envelope never falls back to the legacy machine-id keys", () => {
    // Legacy key applied to envelope bytes would be a format confusion; the envelope
    // is only ever tried with the master key.
    const env = sudo.sealSudoPassword(PLAINTEXT);
    useKey(OTHER_KEY);
    expect(sudo.openSudoPassword(env)).toEqual({ plaintext: null, format: "dxr1" });
  });

  it("legacy ciphertext is never read as a master-key envelope, and vice versa", () => {
    const legacy = legacyEncrypt(PLAINTEXT, { machineBound: true });
    expect(sudo.openSudoPassword(legacy).format).toBe("legacy");
    expect(sudo.openSudoPassword(`${ENVELOPE_PREFIX}${legacy}`).plaintext).toBeNull();
  });

  it("an unrecognised stored value is not treated as a plaintext password", () => {
    // decryptSecret() returns non-envelope strings unchanged; the sudo path must not.
    expect(sudo.openSudoPassword("hunter2")).toEqual({ plaintext: null, format: "unknown" });
  });

  const badKeys = [
    ["an invalid master key", () => useKey("not-a-valid-key")],
    ["no master key at all", useNoKey],
  ];
  const records = [
    ["legacy", () => legacyEncrypt(PLAINTEXT, { machineBound: true })],
    ["dxr1", () => sudo.sealSudoPassword(PLAINTEXT)],
  ];

  describe.each(badKeys)("%s", (_keyLabel, breakKey) => {
    it.each(records)(
      "a %s record: no password is returned, the record is neither changed nor removed, and it opens again once the key is back",
      async (_fmt, makeRecord) => {
        const record = makeRecord(); // written while the real key is active
        await updateSettings({ mitmSudoEncrypted: record });
        writes = 0;

        breakKey();
        const returned = await manager.loadEncryptedPassword();
        expect(returned).toBeNull(); // not exposed, not even from the legacy format
        expect(await stored()).toBe(record); // byte-identical: not discarded, not rewritten
        expect(writes).toBe(0);

        useKey(TEST_KEY); // key restored: the preserved record is still usable
        expect(await manager.loadEncryptedPassword()).toBe(PLAINTEXT);
        expect((await stored()).startsWith(ENVELOPE_PREFIX)).toBe(true);
      }
    );

    it("a new write persists nothing rather than a weaker format", async () => {
      await updateSettings({ mitmSudoEncrypted: null });
      breakKey();
      await manager.__test__.saveMitmSettings(true, PLAINTEXT);
      useKey(TEST_KEY);
      expect(await stored()).toBeNull();
      expect(persistedBytes().includes(Buffer.from(PLAINTEXT, "utf8"))).toBe(false);
    });
  });
});
