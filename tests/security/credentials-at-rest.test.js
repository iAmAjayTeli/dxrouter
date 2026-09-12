/**
 * Provider credentials encrypted at rest (M0 section 2).
 *
 * Upstream stored OAuth tokens and API keys as plaintext JSON inside
 * `providerConnections.data` while the provider-add UI told users they "will be
 * encrypted and stored securely". The assertions that matter here therefore read
 * the raw column out of a real SQLite file: a test that stubs the crypto layer
 * proves only that the stub was called.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const ACCESS = "ya29.plaintext-access-token-value-0001";
const REFRESH = "1//plaintext-refresh-token-value-0002";
const API_KEY = "sk-plaintext-api-key-value-0003";
const COOKIE = "session=plaintext-cookie-value-0004";
const ALL_SECRETS = [ACCESS, REFRESH, API_KEY, COOKIE];

const KEY_HEX = "ab".repeat(32);
const OTHER_KEY_HEX = "cd".repeat(32);

const savedEnv = {};
let tmpDir;
let db;
let adapter;
let cryptoMod;
let credCrypto;

function stashEnv(name, value) {
  savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxr-cred-"));
  stashEnv("DXR_DATA_DIR", tmpDir);
  stashEnv("DXR_MASTER_KEY", KEY_HEX);

  global._dbAdapter = null;
  global._dxrMasterKey = null;
  vi.resetModules();

  cryptoMod = await import("@/lib/security/crypto.js");
  credCrypto = await import("@/lib/db/helpers/credentialCrypto.js");
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    adapter?.close?.();
  } catch {
    /* best effort */
  }
  global._dbAdapter = null;
  global._dxrMasterKey = null;
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("the envelope", () => {
  it("is AES-256-GCM under a versioned prefix", () => {
    const out = cryptoMod.encryptSecret(ACCESS);
    expect(out.startsWith("dxr1:")).toBe(true);
    expect(cryptoMod.isEncrypted(out)).toBe(true);
    // iv(12) + tag(16) + ciphertext, so the envelope is strictly longer than the
    // plaintext by the AEAD overhead.
    const raw = Buffer.from(out.slice("dxr1:".length), "base64url");
    expect(raw.length).toBe(12 + 16 + Buffer.byteLength(ACCESS));
  });

  it("round-trips", () => {
    expect(cryptoMod.decryptSecret(cryptoMod.encryptSecret(ACCESS))).toBe(ACCESS);
  });

  it("uses a fresh IV every time, so equal secrets do not produce equal ciphertext", () => {
    expect(cryptoMod.encryptSecret(ACCESS)).not.toBe(cryptoMod.encryptSecret(ACCESS));
  });

  it("is idempotent, so a half-migrated table cannot double-encrypt", () => {
    const once = cryptoMod.encryptSecret(ACCESS);
    expect(cryptoMod.encryptSecret(once)).toBe(once);
  });

  it("returns plaintext unchanged, so rows written before M0 still read", () => {
    expect(cryptoMod.decryptSecret("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("leaves empty and non-string input alone", () => {
    expect(cryptoMod.encryptSecret("")).toBe("");
    expect(cryptoMod.encryptSecret(null)).toBe(null);
    expect(cryptoMod.decryptSecret(undefined)).toBe(undefined);
  });

  it("returns null rather than throwing when the key is wrong", () => {
    const out = cryptoMod.encryptSecret(ACCESS, Buffer.from(KEY_HEX, "hex"));
    // Losing one stored credential must not take the router down: the account
    // simply needs re-authentication.
    expect(cryptoMod.decryptSecret(out, Buffer.from(OTHER_KEY_HEX, "hex"))).toBeNull();
  });

  it("returns null when the ciphertext has been tampered with", () => {
    const out = cryptoMod.encryptSecret(ACCESS);
    const raw = Buffer.from(out.slice(5), "base64url");
    raw[raw.length - 1] ^= 0xff;
    expect(cryptoMod.decryptSecret(`dxr1:${raw.toString("base64url")}`)).toBeNull();
  });

  it("returns null on a truncated envelope", () => {
    expect(cryptoMod.decryptSecret("dxr1:AAAA")).toBeNull();
  });

  it("refuses a key that is not 256 bits", () => {
    expect(() => cryptoMod.encryptSecret(ACCESS, Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it("generates 256-bit keys", () => {
    const hex = cryptoMod.generateMasterKeyHex();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).not.toBe(cryptoMod.generateMasterKeyHex());
  });
});

describe("field-level encryption of a connection blob", () => {
  const blob = () => ({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    apiKey: API_KEY,
    idToken: "",
    providerSpecificData: { cookie: COOKIE, region: "us-east-1" },
    priority: 3,
    testStatus: "ok",
    rateLimitedUntil: null,
  });

  it("encrypts every secret field and nothing else", () => {
    const out = credCrypto.encryptConnectionSecrets(blob());
    for (const f of credCrypto.ENCRYPTED_FIELDS) {
      if (f === "idToken") continue; // empty string, nothing to protect
      expect(cryptoMod.isEncrypted(out[f]), f).toBe(true);
    }
    expect(cryptoMod.isEncrypted(out.providerSpecificData)).toBe(true);
    // Operational fields stay readable so manual inspection and queries work.
    expect(out.priority).toBe(3);
    expect(out.testStatus).toBe("ok");
    expect(out.rateLimitedUntil).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = blob();
    credCrypto.encryptConnectionSecrets(input);
    expect(input.accessToken).toBe(ACCESS);
    expect(input.providerSpecificData).toEqual({ cookie: COOKIE, region: "us-east-1" });
  });

  it("round-trips, including the JSON field", () => {
    const out = credCrypto.decryptConnectionSecrets(credCrypto.encryptConnectionSecrets(blob()));
    expect(out.accessToken).toBe(ACCESS);
    expect(out.refreshToken).toBe(REFRESH);
    expect(out.apiKey).toBe(API_KEY);
    expect(out.providerSpecificData).toEqual({ cookie: COOKIE, region: "us-east-1" });
  });

  it("is idempotent in both directions", () => {
    const once = credCrypto.encryptConnectionSecrets(blob());
    expect(credCrypto.encryptConnectionSecrets(once)).toEqual(once);
    const plain = credCrypto.decryptConnectionSecrets(once);
    expect(credCrypto.decryptConnectionSecrets(plain)).toEqual(plain);
  });

  it("reports whether a blob still holds plaintext", () => {
    expect(credCrypto.hasPlaintextSecret(blob())).toBe(true);
    expect(credCrypto.hasPlaintextSecret(credCrypto.encryptConnectionSecrets(blob()))).toBe(false);
    expect(credCrypto.hasPlaintextSecret({ priority: 1 })).toBe(false);
    expect(credCrypto.hasPlaintextSecret(null)).toBe(false);
  });

  it("keeps an empty providerSpecificData as-is", () => {
    const out = credCrypto.encryptConnectionSecrets({ providerSpecificData: {} });
    expect(out.providerSpecificData).toEqual({});
  });
});

describe("what SQLite actually holds", () => {
  let rawRow;
  let created;

  beforeAll(async () => {
    created = await db.createProviderConnection({
      provider: "anthropic",
      authType: "oauth",
      name: "at-rest",
      email: "at-rest@example.test",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      apiKey: API_KEY,
      providerSpecificData: { cookie: COOKIE, region: "us-east-1" },
      priority: 1,
    });
    rawRow = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [created.id]).data;
  });

  it.each(ALL_SECRETS)("does not contain the plaintext secret %s", (secret) => {
    expect(rawRow).not.toContain(secret);
  });

  it("holds envelopes instead", () => {
    const stored = JSON.parse(rawRow);
    expect(cryptoMod.isEncrypted(stored.accessToken)).toBe(true);
    expect(cryptoMod.isEncrypted(stored.refreshToken)).toBe(true);
    expect(cryptoMod.isEncrypted(stored.apiKey)).toBe(true);
    expect(cryptoMod.isEncrypted(stored.providerSpecificData)).toBe(true);
  });

  it("is not readable without the master key", () => {
    const stored = JSON.parse(rawRow);
    expect(cryptoMod.decryptSecret(stored.accessToken, Buffer.from(OTHER_KEY_HEX, "hex"))).toBeNull();
  });

  it("does not leak into the whole database file either", () => {
    // The WAL and any page slack are part of the artefact an attacker copies, so
    // the check is against the bytes on disk, not just the column we selected.
    const dbFile = path.join(tmpDir, "db", "data.sqlite");
    const files = [dbFile, `${dbFile}-wal`].filter((f) => fs.existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    const bytes = Buffer.concat(files.map((f) => fs.readFileSync(f))).toString("latin1");
    for (const secret of ALL_SECRETS) expect(bytes).not.toContain(secret);
  });

  it("still hands the caller the plaintext back", async () => {
    const readBack = await db.getProviderConnectionById(created.id);
    expect(readBack.accessToken).toBe(ACCESS);
    expect(readBack.refreshToken).toBe(REFRESH);
    expect(readBack.apiKey).toBe(API_KEY);
    expect(readBack.providerSpecificData).toEqual({ cookie: COOKIE, region: "us-east-1" });
  });

  it("keeps the non-secret columns queryable", () => {
    const row = adapter.get(`SELECT provider, authType, email, priority FROM providerConnections WHERE id = ?`, [created.id]);
    expect(row.provider).toBe("anthropic");
    expect(row.authType).toBe("oauth");
    expect(row.email).toBe("at-rest@example.test");
  });
});

describe("a database written before M0", () => {
  const legacyId = "legacy-plaintext-row";

  beforeAll(() => {
    // Exactly what upstream wrote: the whole credential blob as plaintext JSON.
    adapter.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, 'openai', 'oauth', 'legacy', 'legacy@example.test', 1, 1, ?, ?, ?)`,
      [
        legacyId,
        JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH, providerSpecificData: { cookie: COOKIE } }),
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
  });

  it("is plaintext until the migration runs", () => {
    expect(adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [legacyId]).data).toContain(ACCESS);
  });

  it("is encrypted in place by migration 002", async () => {
    const migration = (await import("@/lib/db/migrations/002-encrypt-credentials.js")).default;
    expect(migration.version).toBe(2);
    migration.up(adapter);

    const after = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [legacyId]).data;
    for (const secret of [ACCESS, REFRESH, COOKIE]) expect(after).not.toContain(secret);

    const readBack = await db.getProviderConnectionById(legacyId);
    expect(readBack.accessToken).toBe(ACCESS);
    expect(readBack.providerSpecificData).toEqual({ cookie: COOKIE });
  });

  it("is left alone on a second pass", async () => {
    const migration = (await import("@/lib/db/migrations/002-encrypt-credentials.js")).default;
    const before = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [legacyId]).data;
    migration.up(adapter);
    // Re-encrypting would rotate the IV on every boot and make the row churn.
    expect(adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [legacyId]).data).toBe(before);
  });
});

describe("import and export", () => {
  it("exports envelopes, never plaintext", async () => {
    const dump = await db.exportDb();
    const serialised = JSON.stringify(dump.providerConnections);
    for (const secret of ALL_SECRETS) expect(serialised).not.toContain(secret);
  });

  it("encrypts a legacy plaintext payload on the way in", async () => {
    await db.importDb({
      providerConnections: [
        {
          id: "imported-1",
          provider: "gemini",
          authType: "apikey",
          name: "imported",
          apiKey: API_KEY,
        },
      ],
    });
    const raw = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, ["imported-1"]).data;
    expect(raw).not.toContain(API_KEY);
    expect((await db.getProviderConnectionById("imported-1")).apiKey).toBe(API_KEY);
  });
});
