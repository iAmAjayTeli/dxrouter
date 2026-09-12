/**
 * Encryption of provider-credential material at rest.
 *
 * `providerConnections.data` is a JSON blob holding OAuth tokens, API keys and
 * per-provider session material. Upstream stored all of it in plaintext (while
 * the provider-add UI told users it "will be encrypted and stored securely").
 * M0 encrypts each secret field individually with AES-256-GCM before the row is
 * written, and decrypts on read, so the only representation on disk is the
 * `dxr1:` envelope.
 *
 * Design notes:
 *  - Field-level, not whole-blob: non-secret fields (priority, testStatus,
 *    rateLimitedUntil, …) stay readable, so operational queries and manual
 *    inspection still work.
 *  - `providerSpecificData` is encrypted as a whole because its shape varies per
 *    provider and several providers keep cookies/session tokens in it. It is
 *    stored under the same key as an envelope string and re-parsed on read, so
 *    no caller sees a new field name.
 *  - Both directions are idempotent: encrypting an envelope is a no-op, and
 *    decrypting plaintext returns it unchanged. A half-migrated table therefore
 *    reads correctly.
 *  - A value that cannot be decrypted becomes `null` rather than throwing. The
 *    connection then fails upstream auth and the user re-authenticates, which is
 *    strictly better than the whole router refusing to serve.
 */

import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/security/crypto";

/** Scalar string fields encrypted in place. */
export const ENCRYPTED_FIELDS = ["accessToken", "refreshToken", "idToken", "apiKey"];

/** Object fields serialised to JSON and encrypted as a whole. */
export const ENCRYPTED_JSON_FIELDS = ["providerSpecificData"];

/** True when a `data`-blob object still holds any plaintext secret. */
export function hasPlaintextSecret(extra) {
  if (!extra || typeof extra !== "object") return false;
  for (const f of ENCRYPTED_FIELDS) {
    const v = extra[f];
    if (typeof v === "string" && v.length > 0 && !isEncrypted(v)) return true;
  }
  for (const f of ENCRYPTED_JSON_FIELDS) {
    const v = extra[f];
    if (v && typeof v === "object" && Object.keys(v).length > 0) return true;
    if (typeof v === "string" && v.length > 0 && !isEncrypted(v)) return true;
  }
  return false;
}

/**
 * Encrypt the secret fields of a `data`-blob object.
 * @param {object} extra
 * @param {Buffer|string} [key] explicit key (migrations/tests); defaults to the master key
 * @returns {object} a new object — the input is never mutated
 */
export function encryptConnectionSecrets(extra, key) {
  if (!extra || typeof extra !== "object") return extra;
  const out = { ...extra };

  for (const f of ENCRYPTED_FIELDS) {
    const v = out[f];
    if (typeof v === "string" && v.length > 0) out[f] = encryptSecret(v, key);
  }

  for (const f of ENCRYPTED_JSON_FIELDS) {
    const v = out[f];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      out[f] = isEncrypted(v) ? v : encryptSecret(v, key);
      continue;
    }
    if (typeof v === "object") {
      if (Object.keys(v).length === 0) continue; // keep `{}` as-is; nothing to protect
      out[f] = encryptSecret(JSON.stringify(v), key);
    }
  }

  return out;
}

/**
 * Decrypt the secret fields of a `data`-blob object.
 * @param {object} extra
 * @param {Buffer|string} [key]
 * @returns {object} a new object
 */
export function decryptConnectionSecrets(extra, key) {
  if (!extra || typeof extra !== "object") return extra;
  const out = { ...extra };

  for (const f of ENCRYPTED_FIELDS) {
    const v = out[f];
    if (typeof v === "string" && v.length > 0) out[f] = decryptSecret(v, key);
  }

  for (const f of ENCRYPTED_JSON_FIELDS) {
    const v = out[f];
    if (typeof v !== "string" || v.length === 0) continue;
    const plain = decryptSecret(v, key);
    if (plain === null) {
      out[f] = undefined;
      continue;
    }
    try {
      out[f] = JSON.parse(plain);
    } catch {
      // Not JSON (should not happen) — surface the string rather than losing it.
      out[f] = plain;
    }
  }

  return out;
}
