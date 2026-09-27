/**
 * The cached host sudo password (settings.mitmSudoEncrypted), sealed with the master key.
 *
 * Current format: the standard `dxr1:` envelope from ./crypto.js (master key, AES-256-GCM),
 * the same format as every other secret DXRouter stores. No second format is introduced.
 *
 * Legacy format (read-only; src/mitm/manager.js re-seals it with the master key on first
 * read and returns it only once that succeeded):
 * `ivHex(24):tagHex(32):ctHex`, AES-256-GCM under sha256(machineId + LEGACY_SALT), or
 * sha256(LEGACY_SALT) alone when node-machine-id was unavailable when it was written.
 * That key is derivable from the machine id (or from nothing), which is why it is retired.
 *
 * The two are told apart by shape alone, so neither is ever tried with the other's key:
 * a `dxr1:` value is only opened with the master key, a legacy-shaped value only with the
 * legacy keys, and anything else is "unknown" and yields no password. In particular a
 * stray plaintext value is NOT returned as the password (decryptSecret alone would
 * pass non-envelope strings through unchanged).
 */

import crypto from "node:crypto";
import machineId from "node-machine-id";
import { encryptSecret, decryptSecret, isEncrypted } from "./crypto.js";

const LEGACY_SALT = "9router-mitm-pwd";
const LEGACY_FORMAT = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

/** Both keys the legacy writer could have used, machine-bound first. */
function legacyKeys() {
  const keys = [];
  try {
    keys.push(crypto.createHash("sha256").update(machineId.machineIdSync() + LEGACY_SALT).digest());
  } catch {
    /* node-machine-id unavailable: the legacy writer fell back to the salt alone */
  }
  keys.push(crypto.createHash("sha256").update(LEGACY_SALT).digest());
  return keys;
}

function openLegacy(stored) {
  const [ivHex, tagHex, ctHex] = stored.split(":");
  for (const key of legacyKeys()) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
      d.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([d.update(Buffer.from(ctHex, "hex")), d.final()]).toString("utf8");
    } catch {
      /* wrong key: GCM authentication failed, try the next one */
    }
  }
  return null;
}

/**
 * Seal a sudo password with the master key. Throws when no master key can be resolved,
 * so a caller can never fall back to storing something weaker.
 */
export function sealSudoPassword(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("empty sudo password");
  const sealed = encryptSecret(plaintext);
  if (!isEncrypted(sealed)) throw new Error("sudo password was not sealed");
  return sealed;
}

/**
 * Open a stored value.
 * @returns {{plaintext: string|null, format: "dxr1"|"legacy"|"unknown"|"empty"}}
 *   `format: "legacy"` with a plaintext means the caller should re-seal it.
 */
export function openSudoPassword(stored) {
  if (typeof stored !== "string" || stored.length === 0) return { plaintext: null, format: "empty" };
  if (isEncrypted(stored)) {
    const plaintext = decryptSecret(stored);
    return { plaintext: typeof plaintext === "string" && plaintext.length > 0 ? plaintext : null, format: "dxr1" };
  }
  if (LEGACY_FORMAT.test(stored)) return { plaintext: openLegacy(stored), format: "legacy" };
  return { plaintext: null, format: "unknown" };
}
