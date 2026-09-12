/**
 * Port: `NormalizedRequest` (inbound) — §11.1.
 *
 * The engine's only view of an inbound request. It never sees a Next.js or Express
 * request, a header map, or a provider-specific body: `normalizeAdapter` flattens
 * all of that into this shape on the host side of the boundary.
 *
 * `createNormalizedRequest` validates and freezes. Validation is not decoration —
 * a silently-missing `messages` array would turn into a wrong prefix hash, and a
 * wrong prefix hash is indistinguishable from a real cache miss.
 *
 * `client_hint` is the port's one widening point, and it is kept deliberately narrow:
 * three named scalars, never a header bag. M1 added `project_root`, because session
 * inference must not match a candidate from another checkout and the engine cannot
 * read a cwd or an env var itself (invariant I1) — so the host passes the root in.
 * Anything added here must be non-secret by construction: whatever lands in
 * `client_hint` can reach the session store.
 */

/** Client protocols the router accepts. Exhaustive and persisted as strings. */
export const PROTOCOLS = Object.freeze(["openai", "anthropic", "gemini", "responses", "ollama"]);

export class PortContractError extends Error {
  constructor(message, { port = "NormalizedRequest", field = null } = {}) {
    super(message);
    this.name = "PortContractError";
    this.code = "PORT_CONTRACT_VIOLATION";
    this.port = port;
    this.field = field;
  }
}

function fail(message, field) {
  throw new PortContractError(message, { port: "NormalizedRequest", field });
}

/**
 * @param {object} input
 * @param {string} input.protocol one of PROTOCOLS
 * @param {string} input.requested_model model as the client asked for it
 * @param {Array|null} input.tools serialized tool definitions, or null
 * @param {string|null} input.system flattened system prompt, or null
 * @param {Array} input.messages ordered messages
 * @param {object} [input.params] temperature/max_tokens/stream/response_format/tool_choice
 * @param {object} [input.client_hint] session_header / user_agent / project_root
 * @param {number} input.arrived_at epoch ms
 * @returns {Readonly<object>}
 */
export function createNormalizedRequest(input) {
  if (!input || typeof input !== "object") fail("NormalizedRequest must be an object");

  const {
    protocol,
    requested_model,
    tools = null,
    system = null,
    messages,
    params = {},
    client_hint = {},
    arrived_at,
  } = input;

  if (!PROTOCOLS.includes(protocol)) {
    fail(`unknown protocol "${protocol}"; expected one of ${PROTOCOLS.join(", ")}`, "protocol");
  }
  if (typeof requested_model !== "string" || requested_model.length === 0) {
    fail("requested_model must be a non-empty string", "requested_model");
  }
  if (tools !== null && !Array.isArray(tools)) fail("tools must be an array or null", "tools");
  if (system !== null && typeof system !== "string") fail("system must be a string or null", "system");
  if (!Array.isArray(messages)) fail("messages must be an array", "messages");
  if (typeof arrived_at !== "number" || !Number.isFinite(arrived_at)) {
    fail("arrived_at must be an epoch-ms number (inject it from the Clock port)", "arrived_at");
  }
  if (params === null || typeof params !== "object") fail("params must be an object", "params");
  if (client_hint === null || typeof client_hint !== "object") fail("client_hint must be an object", "client_hint");

  return Object.freeze({
    protocol,
    requested_model,
    tools: tools === null ? null : Object.freeze([...tools]),
    system,
    messages: Object.freeze([...messages]),
    params: Object.freeze({
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      stream: params.stream === true,
      response_format: params.response_format,
      tool_choice: params.tool_choice,
    }),
    client_hint: Object.freeze({
      // The explicit session key the resolver validates before trusting it: a header
      // value is client input, so it crosses the boundary as a hint, not as an id.
      session_header: client_hint.session_header,
      user_agent: client_hint.user_agent,
      // Workspace the request belongs to. Scopes inferred identity to one checkout;
      // stored as a path, or as a salted `pr1:` hash when DXR_HASH_PROJECT_PATHS=1.
      project_root: client_hint.project_root,
    }),
    arrived_at,
  });
}

/** True when `value` satisfies the port. Never throws. */
export function isNormalizedRequest(value) {
  try {
    createNormalizedRequest(value);
    return true;
  } catch {
    return false;
  }
}
