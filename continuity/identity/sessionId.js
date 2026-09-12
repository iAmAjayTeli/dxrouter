/**
 * Session identity input validation.
 *
 * A client-supplied session key is untrusted input that ends up in a database row,
 * in a CLI listing and in log lines, so it is validated by a whitelist before it is
 * used for anything. A whitelist is the point: with a blacklist, path traversal and
 * quoting tricks are a question of which case somebody remembered. With
 *
 *     key matches ^[A-Za-z0-9._@-]{1,128}$   (after NFC normalization)
 *
 * a key structurally cannot be a path (no separator, no drive colon, no NUL), cannot
 * carry a control character, cannot contain a quote or a semicolon, and cannot be
 * long enough to be a smuggled payload. SQL safety comes from parameterized
 * statements everywhere in the store; this is the second layer, not the only one.
 *
 * Two further rules that are easy to overlook:
 *  - A key that looks like a credential is rejected. Clients do occasionally paste an
 *    API key into the wrong header, and a rejected session key costs one inferred
 *    session while a persisted one is a secret in a database that promised not to
 *    hold any (section 14). The shapes are duplicated from the host redaction list on
 *    purpose: I1 forbids importing it, and a short local list beats an import.
 *  - The validated key is never the primary key of a session row. It is stored beside
 *    an internally generated id (see session/observer.js), so a client can reuse a
 *    key after a close without colliding with a closed session, and no client string
 *    is ever a foreign key target.
 *
 * Pure: node:crypto for the project-root hash, nothing else.
 */

import { sha256Hex } from "../canonical/serialize.js";

export const MAX_SESSION_KEY_LENGTH = 128;
export const MAX_PROJECT_ROOT_LENGTH = 512;
export const UNKNOWN_PROJECT_ROOT = "unknown";

const SESSION_KEY_PATTERN = /^[A-Za-z0-9._@-]+$/;

/** Credential shapes. Mirrors src/lib/security/redact.js; see module comment. */
const SECRET_SHAPES = [
  /^sk-/i,
  /^gh[pousr]_/,
  /^ya29\./,
  /^AIza/,
  /^dxr1:/,
  /^ey[A-Za-z0-9_-]{8,}\./,
  /^Bearer/i,
];

export const SESSION_KEY_REJECTION = Object.freeze({
  ABSENT: "absent",
  NOT_A_STRING: "not_a_string",
  EMPTY: "empty",
  TOO_LONG: "too_long",
  ILLEGAL_CHARACTER: "illegal_character",
  PATH_LIKE: "path_like",
  SECRET_LIKE: "secret_like",
});

/**
 * Validate a client-supplied session key.
 * @param {*} raw
 * @returns {{ok: boolean, key: string|null, reason: string|null}}
 */
export function validateSessionKey(raw) {
  if (raw === null || raw === undefined) return { ok: false, key: null, reason: SESSION_KEY_REJECTION.ABSENT };
  if (typeof raw !== "string") return { ok: false, key: null, reason: SESSION_KEY_REJECTION.NOT_A_STRING };

  const key = raw.normalize("NFC").trim();
  if (key.length === 0) return { ok: false, key: null, reason: SESSION_KEY_REJECTION.EMPTY };
  if (key.length > MAX_SESSION_KEY_LENGTH) return { ok: false, key: null, reason: SESSION_KEY_REJECTION.TOO_LONG };
  if (!SESSION_KEY_PATTERN.test(key)) {
    return { ok: false, key: null, reason: SESSION_KEY_REJECTION.ILLEGAL_CHARACTER };
  }
  // The charset already excludes separators; these are the remaining shapes that
  // read as a path to a human or to a careless join().
  if (key === "." || key === ".." || key.includes("..")) {
    return { ok: false, key: null, reason: SESSION_KEY_REJECTION.PATH_LIKE };
  }
  if (SECRET_SHAPES.some((re) => re.test(key))) {
    return { ok: false, key: null, reason: SESSION_KEY_REJECTION.SECRET_LIKE };
  }
  return { ok: true, key, reason: null };
}

/** Convenience: the validated key, or null. */
export function normalizeSessionKey(raw) {
  return validateSessionKey(raw).key;
}

/**
 * Sanitize a project root for storage. Never rejects: an unusable value becomes the
 * literal "unknown" so `project_root NOT NULL` holds without inventing a path.
 *
 * No content-derived guessing happens here or anywhere else: deriving a project from
 * prompt text is the project-name heuristic the milestone explicitly forbids.
 */
export function sanitizeProjectRoot(raw) {
  if (typeof raw !== "string") return UNKNOWN_PROJECT_ROOT;
  let value = raw.normalize("NFC").trim();
  if (value.length === 0) return UNKNOWN_PROJECT_ROOT;
  // Strip control characters rather than reject: a path with a stray tab is still a
  // useful label once the tab is gone.
  value = [...value].filter((ch) => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f).join("");
  if (value.length === 0) return UNKNOWN_PROJECT_ROOT;
  if (value.length > MAX_PROJECT_ROOT_LENGTH) value = value.slice(0, MAX_PROJECT_ROOT_LENGTH);
  return value;
}

/**
 * Salted hash of a project root, for DXR_HASH_PROJECT_PATHS=1 (section 14.2).
 * Salted so the hash is not a rainbow-table lookup of common repository paths.
 */
export function hashProjectRoot(root, salt) {
  const value = sanitizeProjectRoot(root);
  if (value === UNKNOWN_PROJECT_ROOT) return UNKNOWN_PROJECT_ROOT;
  if (typeof salt !== "string" || salt.length === 0) {
    throw new Error("[continuity] hashProjectRoot requires a non-empty salt");
  }
  return `pr1:${sha256Hex(`${salt}|${value}`)}`;
}

/** True for a value produced by hashProjectRoot. */
export function isHashedProjectRoot(value) {
  return typeof value === "string" && /^pr1:[0-9a-f]{64}$/.test(value);
}

export default validateSessionKey;
