// Wire-level request tracing, opt-in via ENABLE_REQUEST_LOGS=true.
//
// M0 changes two inherited behaviours here:
//  - Header masking was commented out ("keep full token for testing"), so every
//    traced request wrote the upstream Authorization header to disk in clear.
//    Redaction is now unconditional and covers bodies and SSE chunks too, not
//    just header bags — there is no flag to turn it off.
//  - Logs went to `process.cwd()/logs`, i.e. a repo-relative store outside the
//    single data root. They now live under DXR_DATA_DIR/logs.

import { redactSecrets, redactString } from "@/lib/security/redact.js";

// Check if running in Node.js environment (has fs module)
const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// Check if logging is enabled via environment variable (default: false)
const LOGGING_ENABLED = typeof process !== "undefined" && process.env?.ENABLE_REQUEST_LOGS === 'true';

let fs = null;
let path = null;
let LOGS_DIR = null;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || !LOGGING_ENABLED || fs) return;
  try {
    fs = await import("fs");
    path = await import("path");
    // dataDir.js pulls in node:fs/os/path, so it is imported here rather than at
    // module scope: this file is also loaded in Worker/browser bundles.
    const { LOGS_DIR: dataLogsDir } = await import("@/lib/dataDir.js");
    LOGS_DIR = dataLogsDir;
  } catch {
    // Running in a non-Node environment (Worker, Browser, etc.), or the data root
    // could not be resolved. Leaving LOGS_DIR null disables writing rather than
    // falling back to a repo-relative directory.
    LOGS_DIR = null;
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const timestamp = formatTimestamp();
    const safeModel = (model || "unknown").replace(/[/:]/g, "-");
    const folderName = `${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
    const sessionPath = path.join(LOGS_DIR, folderName);
    
    fs.mkdirSync(sessionPath, { recursive: true });
    
    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

// Write JSON file. Every payload passes through the shared redactor first, so a
// secret cannot reach disk regardless of which log stage produced it.
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;

  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(redactSecrets(data), null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, err.message);
  }
}

// Append a raw stream chunk with secret-shaped substrings scrubbed.
function appendChunk(sessionPath, filename, chunk) {
  if (!fs || !sessionPath) return;
  try {
    fs.appendFileSync(path.join(sessionPath, filename), redactString(String(chunk ?? "")));
  } catch {
    // Ignore append errors
  }
}

/**
 * Hard-redact a header bag: secret headers keep their name (useful when reading a
 * trace) but never their value. Unconditional — the old "disabled for testing"
 * escape hatch is gone.
 */
function maskSensitiveHeaders(headers) {
  if (!headers) return {};
  const plain = typeof headers.entries === "function" && typeof headers.forEach === "function"
    ? Object.fromEntries(headers.entries())
    : headers;
  return redactSecrets(plain);
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {}
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model) {
  // Return no-op logger if logging is disabled
  if (!LOGGING_ENABLED) {
    return createNoOpLogger();
  }
  
  // Wait for session to be created before returning logger
  const sessionPath = await createLogSession(sourceFormat, targetFormat, model);
  
  return {
    get sessionPath() { return sessionPath; },
    
    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body
      });
    },
    
    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 5. Append streaming chunk to provider response
    appendProviderChunk(chunk) {
      appendChunk(sessionPath, "5_res_provider.txt", chunk);
    },
    
    // 6. Append OpenAI intermediate chunks (target → openai)
    appendOpenAIChunk(chunk) {
      appendChunk(sessionPath, "6_res_openai.txt", chunk);
    },
    
    // 7. Log converted response to client (for non-streaming)
    logConvertedResponse(body) {
      writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body
      });
    },
    
    // 7. Append streaming chunk to converted response
    appendConvertedChunk(chunk) {
      appendChunk(sessionPath, "7_res_client.txt", chunk);
    },
    
    // 6. Log error
    logError(error, requestBody = null) {
      writeJsonFile(sessionPath, "6_error.json", {
        timestamp: new Date().toISOString(),
        error: error?.message || String(error),
        stack: error?.stack,
        requestBody
      });
    }
  };
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url,
      error: error?.message || String(error),
      stack: error?.stack,
      requestBody
    };
    
    fs.appendFileSync(logPath, JSON.stringify(redactSecrets(logEntry)) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
