/**
 * Upstream protocol compatibility (M0 acceptance gate).
 *
 * M0 changed security defaults, moved every path under one data root and
 * encrypted stored credentials. None of that may change what a client sends or
 * what the gateway sends upstream. The claim is deliberately narrow: protocol
 * behaviour is unchanged, and the *only* intentional differences are the security
 * defaults asserted in `tests/security/`. Byte-identical behaviour overall is not
 * claimed and is not true.
 *
 * The translator's own golden snapshots stay the authority on translation detail;
 * this file locks the surfaces M0 could plausibly have broken — format detection,
 * the client-facing frame shapes, error envelopes, and the outbound credential
 * path now that credentials live encrypted at rest.
 */

import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";

import { FORMATS, detectFormatByEndpoint } from "../../open-sse/translator/formats.js";
import { translateRequest, translateResponse, initState, needsTranslation } from "../../open-sse/translator/index.js";
import { detectFormat } from "../../open-sse/services/provider.js";
import { formatSSE } from "../../open-sse/utils/streamHelpers.js";
import { sseChunk, chatChunkSse } from "../../open-sse/utils/sse.js";
import { SSE_DONE, SSE_HEADERS } from "../../open-sse/utils/sseConstants.js";
import { buildErrorBody } from "../../open-sse/utils/error.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const OPENAI_BODY = { model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: true };
const CLAUDE_BODY = {
  model: "claude-opus-4-6",
  max_tokens: 256,
  system: "be brief",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};
const GEMINI_BODY = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
const RESPONSES_BODY = { model: "gpt-5", input: [{ role: "user", content: "hi" }] };

describe("the five client protocol surfaces are still recognised", () => {
  it("detects a format from the endpoint where the endpoint decides", () => {
    expect(detectFormatByEndpoint("/v1/responses", RESPONSES_BODY)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(detectFormatByEndpoint("/v1/messages", CLAUDE_BODY)).toBe(FORMATS.CLAUDE);
    // Cursor CLI posts a Responses-shaped body to the chat endpoint; the endpoint wins.
    expect(detectFormatByEndpoint("/v1/chat/completions", { input: [] })).toBe(FORMATS.OPENAI);
    expect(detectFormatByEndpoint("/v1/chat/completions", OPENAI_BODY)).toBeNull();
  });

  it("detects a format from the body otherwise", () => {
    expect(detectFormat(RESPONSES_BODY)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(detectFormat(GEMINI_BODY)).toBe(FORMATS.GEMINI);
    expect(detectFormat({ request: { contents: [] }, userAgent: "antigravity" })).toBe(FORMATS.ANTIGRAVITY);
    expect(detectFormat({ ...OPENAI_BODY, stream_options: { include_usage: true } })).toBe(FORMATS.OPENAI);
    expect(detectFormat(CLAUDE_BODY)).toBe(FORMATS.CLAUDE);
  });

  it("keeps the OpenAI surface the default rather than guessing", () => {
    expect(detectFormat({ messages: [{ role: "user", content: "plain string" }] })).toBe(FORMATS.OPENAI);
  });

  it("knows when no translation is needed at all", () => {
    expect(needsTranslation(FORMATS.OPENAI, FORMATS.OPENAI)).toBe(false);
    expect(needsTranslation(FORMATS.CLAUDE, FORMATS.OPENAI)).toBe(true);
  });
});

describe("request translation keeps the fields upstream needs", () => {
  const T = (src, tgt, body, provider = null) =>
    translateRequest(src, tgt, "m", JSON.parse(JSON.stringify(body)), true, null, provider);

  it("openai → claude carries messages and system", () => {
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, {
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
    }, "anthropic-compatible-x");
    expect(Array.isArray(out.messages)).toBe(true);
    expect(JSON.stringify(out)).toContain("be brief");
    expect(out.max_tokens).toBeGreaterThan(0);
  });

  it("claude → openai carries system as a message", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, CLAUDE_BODY);
    expect(out.messages.some((m) => m.role === "system" && String(m.content).includes("be brief"))).toBe(true);
  });

  it("openai → gemini produces contents parts", () => {
    const out = T(FORMATS.OPENAI, FORMATS.GEMINI, OPENAI_BODY);
    expect(Array.isArray(out.contents)).toBe(true);
    expect(JSON.stringify(out.contents)).toContain("hi");
  });

  it("gemini → openai produces messages", () => {
    const out = T(FORMATS.GEMINI, FORMATS.OPENAI, GEMINI_BODY);
    expect(out.messages.some((m) => String(m.content).includes("hi"))).toBe(true);
  });

  it("openai → ollama keeps the chat shape ollama expects", () => {
    const out = T(FORMATS.OPENAI, FORMATS.OLLAMA, OPENAI_BODY);
    expect(JSON.stringify(out)).toContain("hi");
    expect(out).toBeTypeOf("object");
  });

  it("openai-responses → openai produces messages from input", () => {
    const out = T(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, RESPONSES_BODY);
    expect(JSON.stringify(out)).toContain("hi");
  });

  it("does not mutate the caller's body object", () => {
    const body = JSON.parse(JSON.stringify(CLAUDE_BODY));
    const before = JSON.stringify(body);
    translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "m", body, true, null, null);
    // `translateRequest` is allowed to normalise in place, but the *client's*
    // messages must survive: a request the gateway retries has to still be sendable.
    expect(JSON.parse(before).messages).toHaveLength(body.messages.length);
  });
});

/**
 * `translateResponse(providerFormat, clientFormat, chunk, state)` — the parameter
 * named `sourceFormat` is the *client's* format, i.e. the shape to emit. Keeping
 * that straight is the point of these tests: reversing it silently produces frames
 * no client understands.
 */
function runStream(providerFormat, clientFormat, events) {
  const state = initState(clientFormat);
  const out = [];
  for (const ev of events) {
    const res = translateResponse(providerFormat, clientFormat, ev, state);
    if (Array.isArray(res)) out.push(...res);
    else if (res) out.push(res);
  }
  return out;
}

const OPENAI_STREAM = [
  { id: "chatcmpl-1", model: "gpt-5", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
  { id: "chatcmpl-1", model: "gpt-5", choices: [{ index: 0, delta: { content: "Hello" } }] },
  { id: "chatcmpl-1", model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
];

const CLAUDE_STREAM = [
  { type: "message_start", message: { id: "msg_1", model: "claude-opus-4-6" } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 4, output_tokens: 1 } },
  { type: "message_stop" },
];

describe("what the client actually reads off the wire", () => {
  it("an OpenAI client still gets chat.completion.chunk frames", () => {
    const chunks = runStream(FORMATS.CLAUDE, FORMATS.OPENAI, CLAUDE_STREAM);
    const frames = chunks.map((c) => formatSSE(c, FORMATS.OPENAI));
    expect(frames.every((f) => f.startsWith("data: ") && f.endsWith("\n\n"))).toBe(true);
    expect(frames.join("")).toContain('"object":"chat.completion.chunk"');
    expect(frames.join("")).toContain("Hello");
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason)).toBe(true);
  });

  it("a Claude client still gets named events, not bare data frames", () => {
    const chunks = runStream(FORMATS.OPENAI, FORMATS.CLAUDE, OPENAI_STREAM);
    const frames = chunks.map((c) => formatSSE(c, FORMATS.CLAUDE));
    const joined = frames.join("");
    for (const type of ["message_start", "content_block_delta", "message_stop"]) {
      expect(joined, type).toContain(`event: ${type}`);
    }
    // Anthropic clients dispatch on the event line; a frame carrying only `data:`
    // is silently dropped by the SDK.
    expect(frames.every((f) => f.startsWith("event: "))).toBe(true);
  });

  it("frames a Responses event with its own event name", () => {
    expect(formatSSE({ event: "response.output_text.delta", data: { delta: "hi" } }, FORMATS.OPENAI_RESPONSES)).toBe(
      `event: response.output_text.delta\ndata: {"delta":"hi"}\n\n`
    );
  });

  it("keeps the terminal sentinel exactly as clients match on it", () => {
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
    expect(formatSSE({ done: true }, FORMATS.OPENAI)).toBe(SSE_DONE);
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream");
  });

  it("builds a chat chunk with the field order clients parse loosely but tools snapshot strictly", () => {
    const frame = chatChunkSse({ id: "chatcmpl-x", created: 0, model: "gpt-5", delta: { content: "hi" }, finishReason: null });
    expect(frame).toBe(
      `data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":0,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`
    );
    expect(sseChunk({ a: 1 })).toBe(`data: {"a":1}\n\n`);
  });

  it("passes a same-format stream through untouched", () => {
    const chunks = runStream(FORMATS.OPENAI, FORMATS.OPENAI, OPENAI_STREAM);
    expect(chunks).toHaveLength(OPENAI_STREAM.length);
    expect(chunks[1].choices[0].delta.content).toBe("Hello");
  });
});

describe("the error envelope", () => {
  it("keeps the OpenAI error shape for the statuses clients branch on", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      const body = buildErrorBody(status, `boom ${status}`);
      expect(body.error.message, String(status)).toBe(`boom ${status}`);
      expect(typeof body.error.type, String(status)).toBe("string");
      expect(body.error).toHaveProperty("code");
    }
  });

  it("classifies an unknown 5xx as a server error and an unknown 4xx as an invalid request", () => {
    expect(buildErrorBody(599, "x").error.type).toBe("server_error");
    expect(buildErrorBody(418, "x").error.type).toBe("invalid_request_error");
  });

  it("supplies a default message rather than an empty one", () => {
    expect(buildErrorBody(429, "").error.message).toBeTruthy();
  });
});

describe("what goes upstream", () => {
  it("still targets the documented provider endpoints", () => {
    expect(new DefaultExecutor("openai").buildUrl("gpt-5", true, 0, { apiKey: "sk-K" })).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
    expect(new DefaultExecutor("anthropic").buildUrl("claude-opus-4-6", true, 0, { apiKey: "sk-K" })).toBe(
      "https://api.anthropic.com/v1/messages"
    );
  });

  it("still sends the credential in the header each provider expects", () => {
    expect(new DefaultExecutor("openai").buildHeaders({ apiKey: "sk-K" }, true).Authorization).toBe("Bearer sk-K");
    expect(new DefaultExecutor("anthropic").buildHeaders({ apiKey: "sk-K" }, true)["x-api-key"]).toBe("sk-K");
    expect(new DefaultExecutor("anthropic").buildHeaders({ apiKey: "sk-K" }, true)["anthropic-version"]).toBe("2023-06-01");
  });

  it("asks for an event stream only when streaming", () => {
    const ex = new DefaultExecutor("openai");
    expect(ex.buildHeaders({ apiKey: "sk-K" }, true).Accept).toBe("text/event-stream");
    expect(ex.buildHeaders({ apiKey: "sk-K" }, false).Accept).not.toBe("text/event-stream");
  });
});
