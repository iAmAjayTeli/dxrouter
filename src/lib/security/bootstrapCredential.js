/**
 * First-run dashboard credential.
 *
 * Upstream 9Router shipped with a public default password ("123456") that was
 * accepted whenever no hash had been stored. M0 removes that entirely: on the
 * first start with no stored hash and no explicit `INITIAL_PASSWORD`, a random
 * credential is generated, bcrypt-hashed into settings, and shown exactly once
 * (stdout + a 0600 file that is deleted after the first successful login).
 */

import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";

/** Unambiguous alphabet: no O/0, I/l/1, so the credential survives being read aloud. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const LENGTH = 26;

export const INITIAL_CREDENTIAL_FILE = () => path.join(DATA_DIR, "initial-credential.txt");

/** Cryptographically uniform random credential (rejection sampling, no modulo bias). */
export function generateCredential(length = LENGTH) {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  while (out.length < length) {
    for (const byte of nodeCrypto.randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function writeCredentialFile(credential) {
  const file = INITIAL_CREDENTIAL_FILE();
  const body =
    `dxrouter initial dashboard credential\n` +
    `generated: ${new Date().toISOString()}\n\n` +
    `${credential}\n\n` +
    `Sign in at /dashboard, then change it. This file is deleted automatically\n` +
    `after the first successful login.\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* filesystems without POSIX modes */
    }
    return file;
  } catch (e) {
    console.warn(`[security] could not write ${file}: ${e.message}`);
    return null;
  }
}

function banner(credential, file) {
  const line = "─".repeat(64);
  console.log(
    [
      "",
      line,
      "  FIRST RUN — dashboard credential generated",
      "",
      `    ${credential}`,
      "",
      "  Shown once. Sign in at /dashboard and change it.",
      file ? `  Also written to: ${file}` : "  (could not be written to disk — copy it now)",
      line,
      "",
    ].join("\n")
  );
}

/**
 * Ensure a dashboard credential exists.
 *
 * @param {object} deps injected so this is testable without the app DB
 * @param {() => Promise<object>} deps.getSettings
 * @param {(u: object) => Promise<object>} deps.updateSettings
 * @param {(pw: string) => Promise<string>} deps.hash
 * @returns {Promise<{status: "existing"|"env"|"generated"|"failed", file?: string|null, error?: string}>}
 */
export async function ensureDashboardCredential({ getSettings, updateSettings, hash }) {
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    // A database that cannot be read is reported by the DB layer; credential
    // bootstrap must not mask that failure with its own.
    return { status: "failed", error: e.message };
  }

  if (settings?.password) return { status: "existing" };

  if (process.env.INITIAL_PASSWORD) {
    const stored = await hash(process.env.INITIAL_PASSWORD);
    await updateSettings({ password: stored });
    console.log("[security] Dashboard credential initialised from INITIAL_PASSWORD.");
    return { status: "env" };
  }

  const credential = generateCredential();
  const stored = await hash(credential);
  await updateSettings({ password: stored });
  const file = writeCredentialFile(credential);
  banner(credential, file);
  return { status: "generated", file };
}

/** Remove the one-time credential file. Called after the first successful login. */
export function consumeInitialCredentialFile() {
  const file = INITIAL_CREDENTIAL_FILE();
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      return true;
    }
  } catch (e) {
    console.warn(`[security] could not remove ${file}: ${e.message}`);
  }
  return false;
}
