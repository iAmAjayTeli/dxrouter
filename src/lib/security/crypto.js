/**
 * Symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * Envelope: `dxr1:` + base64url( iv(12) || tag(16) || ciphertext )
 *
 * Design notes for M0:
 *  - `encryptSecret` is idempotent: an already-enveloped string is returned
 *    unchanged, so a partially-migrated table cannot double-encrypt.
 *  - `decryptSecret` never throws. A value that cannot be decrypted (wrong or
 *    rotated key, truncated row) returns `null` and warns once per distinct
 *    reason. Losing access to one stored credential must not take the router
 *    down; the account simply needs re-authentication.
 */

import crypto from "node:crypto";
import { getMasterKeySync } from "./masterKey.js";

export const ENVELOPE_PREFIX = "dxr1:";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const AAD = Buffer.from("dxr1");

const warned = new Set();
function warnOnce(reason) {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`[security] ${reason}`);
}

/** True when `value` is already an encrypted envelope. */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

function resolveKey(key) {
  if (key) {
    const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, "hex");
    if (buf.length !== 32) throw new Error("master key must be 32 bytes");
    return buf;
  }
  return getMasterKeySync();
}

/**
 * Encrypt a string. Returns the envelope, or the input unchanged when it is
 * already encrypted / not a non-empty string.
 * @param {string} plaintext
 * @param {Buffer|string} [key] 32-byte key, defaults to the active master key.
 */
export function encryptSecret(plaintext, key) {
  if (typeof plaintext !== "string" || plaintext.length === 0) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const k = resolveKey(key);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENVELOPE_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

/**
 * Decrypt an envelope. Plaintext input is returned unchanged (tolerates rows
 * written before encryption landed). Undecryptable input returns `null`.
 * @param {string} value
 * @param {Buffer|string} [key]
 * @returns {string|null}
 */
export function decryptSecret(value, key) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!isEncrypted(value)) return value;

  let k;
  try {
    k = resolveKey(key);
  } catch (e) {
    warnOnce(`stored credential could not be read: ${e.message}`);
    return null;
  }

  try {
    const raw = Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64url");
    if (raw.length <= IV_LEN + TAG_LEN) throw new Error("envelope too short");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, k, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    warnOnce(
      "a stored credential could not be decrypted with the current master key — " +
        "re-authenticate that provider connection (DXR_MASTER_KEY may have changed)"
    );
    return null;
  }
}

/** Generate a fresh 32-byte master key as lowercase hex. */
export function generateMasterKeyHex() {
  return crypto.randomBytes(32).toString("hex");
}
