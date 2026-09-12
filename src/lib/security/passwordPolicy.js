/**
 * Dashboard password rules, shared by every path that can set one.
 *
 * There was no password policy in this codebase before this file. The only
 * checks lived in the login and profile forms as HTML `required` attributes, so
 * an API or CLI caller could send `newPassword: ""` and get a 200 back with
 * nothing changed — indistinguishable from success.
 *
 * The rule below is the one the product already implied: a password has to be
 * something. No length or character-class minimum is invented, because every
 * stricter rule would reject a password an operator can actually remember, and
 * "a password I can remember" is the whole point of being allowed to choose one.
 *
 * Callers must not trim before hashing — whitespace inside a password is part
 * of the password. Only the emptiness test trims, so "   " is rejected while
 * " correct horse " is stored exactly as typed.
 */

/**
 * Longest password bcrypt will actually use.
 *
 * bcrypt hashes at most 72 bytes and silently discards the rest, so two
 * passwords sharing a 72-byte prefix are interchangeable. This is recorded here
 * rather than enforced: rejecting a longer passphrase would refuse something the
 * operator can still sign in with consistently, and the collision it guards
 * against requires an attacker who already knows the first 72 bytes.
 */
export const BCRYPT_MAX_BYTES = 72;

/**
 * Validate a password supplied by whoever is setting it.
 *
 * @param {unknown} value raw value straight off a request body or prompt
 * @returns {string|null} an operator-facing message, or null when acceptable
 */
export function validateNewPassword(value) {
  if (typeof value !== "string") {
    return "Password must be a string";
  }
  if (value.length === 0) {
    return "Password must not be empty";
  }
  if (value.trim().length === 0) {
    return "Password must not be only whitespace";
  }
  return null;
}
