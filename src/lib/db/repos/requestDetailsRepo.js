import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { isSecretKey, redactSecrets } from "../../security/redact.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

/**
 * Request/response bodies are prompts and completions — user content, not
 * telemetry. M0 requires them OFF by default even when diagnostics are on, so
 * persistence needs an explicit yes from the UI (`settings.persistRequestBodies`)
 * or the environment (`DXR_PERSIST_REQUEST_BODIES`). With bodies off the record
 * still carries the shape of the exchange (model, stream, message/tool counts,
 * finish_reason), which is what the observability screens actually chart.
 */
function resolvePersistBodies(settings) {
  const env = process.env.DXR_PERSIST_REQUEST_BODIES;
  if (env !== undefined && env !== "") return /^(1|true|yes|on)$/i.test(env.trim());
  if (settings && typeof settings.persistRequestBodies === "boolean") return settings.persistRequestBodies;
  return false;
}

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
        persistBodies: resolvePersistBodies(settings),
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    // M0: opt-in, not opt-out. Upstream treated an absent OBSERVABILITY_ENABLED as
    // "on", so a settings row that predates the UI flag silently persisted request
    // bodies. Diagnostics now require an explicit yes from either the UI or the env.
    const envFallback = process.env.OBSERVABILITY_ENABLED === "true";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      persistBodies: resolvePersistBodies(settings),
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
      persistBodies: false,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

/**
 * Drop secret headers outright (not mask): a persisted row that never carries the
 * header cannot leak it through a later re-serialisation, and the dashboard has no
 * use for knowing that an Authorization header was present. Backed by the shared
 * key list in security/redact.js rather than a local copy that drifts.
 */
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSecretKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

const BODY_OMITTED = { _bodyOmitted: true };

/** Shape-only view of the client request: no messages, no tool payloads. */
function summarizeRequest(request) {
  if (!request || typeof request !== "object") return { ...BODY_OMITTED };
  const out = { ...BODY_OMITTED };
  if (request.model !== undefined) out.model = request.model;
  if (request.stream !== undefined) out.stream = request.stream;
  if (Array.isArray(request.messages)) out.messageCount = request.messages.length;
  if (Array.isArray(request.tools)) out.toolCount = request.tools.length;
  if (request.headers) out.headers = sanitizeHeaders(request.headers);
  return out;
}

/** Replace every body-bearing field with a shape summary. */
function stripBodies(item) {
  const out = { ...item, request: summarizeRequest(item.request) };
  for (const field of ["providerRequest", "providerResponse"]) {
    if (out[field] !== undefined && out[field] !== null) out[field] = { ...BODY_OMITTED };
  }
  if (out.response && typeof out.response === "object") {
    out.response = { ...BODY_OMITTED };
    if (item.response.finish_reason !== undefined) out.response.finish_reason = item.response.finish_reason;
  } else if (out.response !== undefined && out.response !== null) {
    out.response = { ...BODY_OMITTED };
  }
  return out;
}

export const __test__ = { sanitizeHeaders, summarizeRequest, stripBodies, resolvePersistBodies, truncateField };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    // No `_preview`: upstream stored the first 200 characters of the oversized
    // payload, which is exactly where a pasted key or an echoed Authorization
    // header tends to sit. Size alone is enough to explain the truncation.
    return { _truncated: true, _originalSize: str.length };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const raw of items) {
          const item = config.persistBodies ? { ...raw } : stripBodies(raw);
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
          };

          // Unconditional, whole-record redaction: secret-looking keys are dropped
          // (see redact.js `drop`) and secret-shaped strings inside free text are
          // scrubbed, wherever they sit in the tree. Nothing reaches SQLite unredacted.
          const safeRecord = redactSecrets(record, { drop: true });

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(safeRecord)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
