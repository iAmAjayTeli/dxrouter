import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

/**
 * Single data root.
 *
 * Precedence: `DXR_DATA_DIR` → `DATA_DIR` (deprecated, warns) → platform default.
 *
 * The directory *name* deliberately stays `9router` / `.9router`: renaming it
 * would orphan every existing install's credentials and usage history. What M0
 * requires is one configured root that everything uses — not a new name.
 */

let resolvedSource = "default";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function readConfigured() {
  if (process.env.DXR_DATA_DIR) return { value: process.env.DXR_DATA_DIR, source: "DXR_DATA_DIR" };
  if (process.env.DATA_DIR) {
    console.warn("[DATA_DIR] DATA_DIR is deprecated — use DXR_DATA_DIR (DATA_DIR is still honoured).");
    return { value: process.env.DATA_DIR, source: "DATA_DIR" };
  }
  return null;
}

export function getDataDir() {
  const configured = readConfigured();
  if (!configured) {
    resolvedSource = "default";
    return defaultDir();
  }

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured.value)) {
    console.warn(`[DATA_DIR] '${configured.value}' is a Unix path on Windows → fallback to default`);
    resolvedSource = "default (invalid override)";
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured.value, { recursive: true });
    resolvedSource = configured.source;
    return configured.value;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured.value}' not writable → fallback ~/.${APP_NAME}`);
      resolvedSource = "default (override not writable)";
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();

/** Where `DATA_DIR` came from, for the startup diagnostic. Never contains secrets. */
export const DATA_DIR_SOURCE = resolvedSource;

/** All diagnostic output lives under the one data root — never `process.cwd()`. */
export const LOGS_DIR = path.join(DATA_DIR, "logs");

/** Scratch space for the dashboard's translator inspector. */
export const TRANSLATOR_LOGS_DIR = path.join(LOGS_DIR, "translator");
