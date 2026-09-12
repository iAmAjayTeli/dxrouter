/**
 * Master-key resolution for credential encryption at rest.
 *
 * Resolution order (first hit wins):
 *   1. `DXR_MASTER_KEY`            — 64 hex chars or 32 bytes base64/base64url.
 *   2. OS keychain-backed keyfile  — Windows DPAPI (per-user), macOS Keychain,
 *                                    Linux libsecret via `secret-tool`.
 *   3. Refuse                      — unless `DXR_KEY_STORE=file`, which stores
 *                                    a 0600 keyfile and warns loudly.
 *
 * No new native dependency: the OS keychain is reached through the tools that
 * ship with each platform (`powershell`, `security`, `secret-tool`).
 */

import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir";
import { SecurityBootstrapError } from "./errors.js";

const KEY_BYTES = 32;
const SERVICE = "dxrouter";
const ACCOUNT = "master-key";

const DPAPI_FILE = () => path.join(DATA_DIR, "master.key.dpapi");
const PLAIN_FILE = () => path.join(DATA_DIR, "master.key");

/** Cached across Next hot-reloads, like the DB adapter. */
function cache() {
  if (!global._dxrMasterKey) global._dxrMasterKey = { key: null, source: null };
  return global._dxrMasterKey;
}

function parseKeyMaterial(raw, origin) {
  const s = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fall through */
  }
  throw new SecurityBootstrapError(
    `${origin} is not a valid 256-bit key (expected 64 hex characters or 32 bytes base64).`,
    { code: "MASTER_KEY_INVALID", remedy: "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" }
  );
}

function randomKey() {
  return nodeCrypto.randomBytes(KEY_BYTES);
}

function writePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

function run(cmd, args, input) {
  return execFileSync(cmd, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15000,
  });
}

/* ------------------------------------------------------------------ Windows */

// DPAPI via PowerShell: ConvertFrom-SecureString without -Key encrypts with the
// current user's DPAPI master key, so the ciphertext is useless to other users.
function winProtect(hex) {
  const script =
    "$ErrorActionPreference='Stop';" +
    "$s=[Console]::In.ReadToEnd().Trim();" +
    "$sec=ConvertTo-SecureString -String $s -AsPlainText -Force;" +
    "[Console]::Out.Write((ConvertFrom-SecureString -SecureString $sec))";
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], hex).trim();
}

function winUnprotect(blob) {
  const script =
    "$ErrorActionPreference='Stop';" +
    "$b=[Console]::In.ReadToEnd().Trim();" +
    "$sec=ConvertTo-SecureString -String $b;" +
    "$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);" +
    "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}" +
    "finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}";
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], blob).trim();
}

function fromWindowsKeychain() {
  const file = DPAPI_FILE();
  if (fs.existsSync(file)) {
    const hex = winUnprotect(fs.readFileSync(file, "utf8"));
    return { key: parseKeyMaterial(hex, "DPAPI-protected keyfile"), source: "windows-dpapi" };
  }
  const hex = randomKey().toString("hex");
  writePrivate(file, winProtect(hex));
  return { key: Buffer.from(hex, "hex"), source: "windows-dpapi", created: true };
}

/* -------------------------------------------------------------------- macOS */

function fromMacKeychain() {
  try {
    const hex = run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).trim();
    if (hex) return { key: parseKeyMaterial(hex, "macOS Keychain item"), source: "macos-keychain" };
  } catch {
    /* not stored yet */
  }
  const hex = randomKey().toString("hex");
  run("security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", hex, "-U"]);
  return { key: Buffer.from(hex, "hex"), source: "macos-keychain", created: true };
}

/* -------------------------------------------------------------------- Linux */

function fromLinuxKeychain() {
  const attrs = ["service", SERVICE, "account", ACCOUNT];
  const existing = run("secret-tool", ["lookup", ...attrs]).trim();
  if (existing) return { key: parseKeyMaterial(existing, "libsecret item"), source: "linux-libsecret" };

  const hex = randomKey().toString("hex");
  run("secret-tool", ["store", "--label=dxrouter master key", ...attrs], hex);
  return { key: Buffer.from(hex, "hex"), source: "linux-libsecret", created: true };
}

/* --------------------------------------------------------- explicit keyfile */

function fromPlainFile() {
  const file = PLAIN_FILE();
  if (fs.existsSync(file)) {
    return {
      key: parseKeyMaterial(fs.readFileSync(file, "utf8"), "keyfile"),
      source: "file",
    };
  }
  const hex = randomKey().toString("hex");
  writePrivate(file, hex);
  return { key: Buffer.from(hex, "hex"), source: "file", created: true };
}

function keychainProvider() {
  if (process.platform === "win32") return fromWindowsKeychain;
  if (process.platform === "darwin") return fromMacKeychain;
  return fromLinuxKeychain;
}

/**
 * Resolve (and on first run create) the master key.
 * @throws {SecurityBootstrapError} when no key can be protected.
 * @returns {{key: Buffer, source: string, created?: boolean}}
 */
export function resolveMasterKey() {
  const c = cache();
  if (c.key) return c;

  if (process.env.DXR_MASTER_KEY) {
    c.key = parseKeyMaterial(process.env.DXR_MASTER_KEY, "DXR_MASTER_KEY");
    c.source = "env";
    return c;
  }

  const store = (process.env.DXR_KEY_STORE || "").toLowerCase();

  if (store !== "file") {
    try {
      const resolved = keychainProvider()();
      Object.assign(c, resolved);
      return c;
    } catch (e) {
      if (store === "keychain") {
        throw new SecurityBootstrapError(
          `DXR_KEY_STORE=keychain was requested but the OS keychain is unavailable: ${e.message}`,
          { code: "MASTER_KEY_UNAVAILABLE" }
        );
      }
      throw new SecurityBootstrapError(
        "Provider credentials cannot be encrypted: no master key is available. " +
          `The OS keychain could not be used (${e.message?.split("\n")[0] || e.code || "unknown error"}).`,
        {
          code: "MASTER_KEY_UNAVAILABLE",
          remedy:
            "Set DXR_MASTER_KEY to a 64-hex-character key (generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"), " +
            "or set DXR_KEY_STORE=file to accept a 0600 keyfile in the data directory.",
        }
      );
    }
  }

  const resolved = fromPlainFile();
  Object.assign(c, resolved);
  console.warn(
    "[security] DXR_KEY_STORE=file — the credential-encryption key is stored on disk " +
      `(${PLAIN_FILE()}, mode 0600). Anyone who can read that file and the database can read your provider credentials.`
  );
  return c;
}

/** The active 32-byte key. Throws `SecurityBootstrapError` if unavailable. */
export function getMasterKeySync() {
  return resolveMasterKey().key;
}

/** Where the active key came from: env | windows-dpapi | macos-keychain | linux-libsecret | file. */
export function getMasterKeySource() {
  return resolveMasterKey().source;
}

/** True when a key can be resolved without throwing. Used by diagnostics only. */
export function isEncryptionAvailable() {
  try {
    getMasterKeySync();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the cached key so the next call re-resolves. */
export function __resetMasterKeyCache() {
  global._dxrMasterKey = { key: null, source: null };
}
