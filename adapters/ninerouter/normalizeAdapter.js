/**
 * `normalizeAdapter` — 9Router request → `NormalizedRequest` (§11.1).
 *
 * This is the inbound half of the only bilingual layer in the codebase. It speaks
 * 9Router (raw client bodies, endpoint paths, header bags, the 14-value `FORMATS`
 * enum) and it speaks the port (five protocols, flat system/messages/tools). The
 * engine gets the second and never the first.
 *
 * M1 status: called from the request path for OBSERVATION ONLY, through
 * `sessionObserver.js`. Nothing routes on its output; routing still goes
 * 9Router-only and shadow mode still lands in M3.
 *
 * Permitted imports per §11.4: request shapes and protocol constants. It must not
 * write to the store, and it must not decide anything.
 */

import { FORMATS, detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { detectFormat } from "open-sse/services/provider.js";
import { createNormalizedRequest } from "../../continuity/ports/normalizedRequest.js";

/**
 * 9Router distinguishes far more formats than the engine needs, because it also
 * names *provider* wire formats (kiro, cursor, commandcode). The engine only cares
 * which client dialect the prompt arrived in, so several collapse onto one
 * protocol.
 */
export const PROTOCOL_BY_FORMAT = Object.freeze({
  [FORMATS.OPENAI]: "openai",
  [FORMATS.CLAUDE]: "anthropic",
  [FORMATS.GEMINI]: "gemini",
  [FORMATS.GEMINI_CLI]: "gemini",
  [FORMATS.VERTEX]: "gemini",
  [FORMATS.ANTIGRAVITY]: "gemini",
  [FORMATS.OPENAI_RESPONSES]: "responses",
  [FORMATS.OPENAI_RESPONSE]: "responses",
  [FORMATS.CODEX]: "responses",
  [FORMATS.OLLAMA]: "ollama",
});

/**
 * Headers a coding agent may use to name its own session. First match wins, and
 * `x-dxr-session` is first because it is the one header this router itself defines
 * (§4.2): when a client sends both, the explicit DXRouter key wins over whatever
 * session id the client's own SDK happened to attach.
 */
const SESSION_HEADERS = [
  "x-dxr-session",
  "x-session-id",
  "x-9r-session-id",
  "x-conversation-id",
  "x-request-session",
  "anthropic-session-id",
];

export class NormalizeAdapterError extends Error {
  constructor(message, { code = "NORMALIZE_FAILED", format = null } = {}) {
    super(message);
    this.name = "NormalizeAdapterError";
    this.code = code;
    this.format = format;
  }
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Map a 9Router format string onto one of the five port protocols. */
export function toProtocol(format) {
  const protocol = PROTOCOL_BY_FORMAT[format];
  if (!protocol) {
    throw new NormalizeAdapterError(
      `no port protocol is defined for 9Router format "${format}". ` +
        `Add it to PROTOCOL_BY_FORMAT — do not guess a protocol, the prefix hash depends on it.`,
      { code: "UNMAPPED_FORMAT", format }
    );
  }
  return protocol;
}

/** Flatten the system prompt of each dialect to a single string (or null). */
function extractSystem(protocol, body) {
  if (protocol === "anthropic") {
    const s = body.system;
    if (typeof s === "string") return s || null;
    if (Array.isArray(s)) {
      const text = s.map((b) => (typeof b === "string" ? b : b?.text || "")).join("\n");
      return text || null;
    }
    return null;
  }
  if (protocol === "gemini") {
    const si = body.systemInstruction || body.system_instruction || body.request?.systemInstruction;
    if (!si) return null;
    if (typeof si === "string") return si || null;
    const parts = si.parts || si.content?.parts || [];
    const text = parts.map((p) => p?.text || "").join("\n");
    return text || null;
  }
  if (protocol === "responses") {
    return typeof body.instructions === "string" ? body.instructions || null : null;
  }
  // openai / ollama: system lives as leading message(s)
  if (Array.isArray(body.messages)) {
    const systems = body.messages
      .filter((m) => m?.role === "system" || m?.role === "developer")
      .map((m) => (typeof m.content === "string" ? m.content : contentToText(m.content)));
    const text = systems.join("\n");
    return text || null;
  }
  return null;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (typeof p?.text === "string") return p.text;
      return "";
    })
    .join("");
}

/** The ordered conversation, in whatever shape the dialect uses. */
function extractMessages(protocol, body) {
  if (protocol === "gemini") {
    const contents = body.contents || body.request?.contents;
    return Array.isArray(contents) ? contents : [];
  }
  if (protocol === "responses") {
    if (Array.isArray(body.input)) return body.input;
    if (typeof body.input === "string") return [{ role: "user", content: body.input }];
    return Array.isArray(body.messages) ? body.messages : [];
  }
  if (!Array.isArray(body.messages)) return [];
  // Non-system only: the system layer is hashed separately (prefix layers are
  // tools / system / messages, and mixing them would defeat layer-wise caching).
  return body.messages.filter((m) => m?.role !== "system" && m?.role !== "developer");
}

function extractTools(protocol, body) {
  if (protocol === "gemini") {
    const tools = body.tools || body.request?.tools;
    return Array.isArray(tools) ? tools : null;
  }
  return Array.isArray(body.tools) ? body.tools : null;
}

function extractParams(protocol, body) {
  const gen = body.generationConfig || body.request?.generationConfig || {};
  return {
    temperature: body.temperature ?? gen.temperature,
    max_tokens:
      body.max_tokens ??
      body.max_completion_tokens ??
      body.max_output_tokens ??
      gen.maxOutputTokens,
    stream: body.stream === true || protocol === "gemini",
    response_format: body.response_format ?? body.text?.format,
    tool_choice: body.tool_choice ?? body.toolConfig ?? body.tool_config,
  };
}

/** Headers a client may use to name its own workspace. First match wins. */
const PROJECT_ROOT_HEADERS = ["x-dxr-project-root", "x-project-root", "x-workspace-root"];

/**
 * @param {object} input
 * @param {object} input.body raw client body, exactly as 9Router received it
 * @param {string} [input.pathname] request path, used for endpoint-based detection
 * @param {*} [input.headers] Headers instance or plain object
 * @param {string} [input.format] explicit 9Router format, skips detection
 * @param {number} [input.arrivedAt] epoch ms; inject from the Clock port
 * @param {string|null} [input.projectRoot] host-configured workspace, used only when
 *        the client named none. Never the server's own cwd: the workspace belongs to
 *        the agent on the other end of the socket, and guessing it would merge two
 *        checkouts into one identity bucket.
 * @returns {Readonly<object>} NormalizedRequest
 */
export function normalizeRequest({
  body,
  pathname = "",
  headers = null,
  format = null,
  arrivedAt = null,
  projectRoot = null,
} = {}) {
  if (!body || typeof body !== "object") {
    throw new NormalizeAdapterError("normalizeRequest requires the parsed client body");
  }

  const detected = format || detectFormatByEndpoint(pathname, body) || detectFormat(body);
  const protocol = toProtocol(detected);

  let sessionHeader;
  for (const name of SESSION_HEADERS) {
    const v = headerValue(headers, name);
    if (v) {
      sessionHeader = v;
      break;
    }
  }

  let root;
  for (const name of PROJECT_ROOT_HEADERS) {
    const v = headerValue(headers, name);
    if (v) {
      root = v;
      break;
    }
  }
  if (!root && typeof projectRoot === "string" && projectRoot) root = projectRoot;

  return createNormalizedRequest({
    protocol,
    requested_model: body.model || body.request?.model || "unknown",
    tools: extractTools(protocol, body),
    system: extractSystem(protocol, body),
    messages: extractMessages(protocol, body),
    params: extractParams(protocol, body),
    client_hint: {
      session_header: sessionHeader,
      user_agent: headerValue(headers, "user-agent") || body.userAgent || undefined,
      project_root: root,
    },
    // Caller-injected time keeps the adapter deterministic under replay; the
    // fallback is only for ad-hoc use.
    arrived_at: typeof arrivedAt === "number" ? arrivedAt : Date.now(),
  });
}

export default normalizeRequest;
