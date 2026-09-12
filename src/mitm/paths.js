// The MITM server is a separate CommonJS process (it must not load the SQLite
// native binding), so it cannot import `@/lib/dataDir`. It duplicates that
// module's precedence — DXR_DATA_DIR → DATA_DIR → platform default — and must be
// kept in step with it. There is still only one root; this is one reader of it.
const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DXR_DATA_DIR || process.env.DATA_DIR;
  if (!configured) return defaultDir();
  // A Unix path from a Linux-targeted .env is not valid here (mirrors dataDir.js).
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR };
