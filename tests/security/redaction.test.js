/**
 * Unconditional redaction (M0 section 2).
 *
 * The requirement is that authorization headers, API keys and cookies are
 * redacted *unconditionally* -- there is no flag that turns this off, so the
 * tests are about coverage and about the two failure modes that matter: a secret
 * that slips through, and a token *count* destroyed because its key happens to
 * contain the word "token".
 */

import { describe, it, expect } from "vitest";

import {
  REDACTED,
  isSecretKey,
  redactString,
  redactSecrets,
  redactUrl,
  redactHeaders,
} from "@/lib/security/redact.js";

describe("isSecretKey", () => {
  const secret = [
    "authorization", "Authorization", "proxy-authorization", "WWW-Authenticate",
    "cookie", "Set-Cookie", "x-api-key", "apiKey", "api_key", "x-goog-api-key",
    "access_token", "accessToken", "refresh_token", "refreshToken", "id_token", "idToken",
    "session_token", "sessionToken", "client_secret", "clientSecret", "private_key",
    "secret", "password", "passwd", "credential", "bearer", "jwt", "signature", "token",
  ];

  it.each(secret)("treats %s as secret", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  const counts = [
    "tokens", "prompt_tokens", "completion_tokens", "total_tokens",
    "cache_read_input_tokens", "cacheReadInputTokens", "token_count", "tokenCount",
    "cached_tokens", "input_tokens", "output_tokens",
  ];

  it.each(counts)("does not redact the token count %s", (key) => {
    // Redacting these protects nothing and strips usage metrics out of every
    // diagnostic, which is how observability quietly stops working.
    expect(isSecretKey(key)).toBe(false);
  });

  it("still redacts singular token-ish keys that only look like counts", () => {
    expect(isSecretKey("token")).toBe(true);
    expect(isSecretKey("x-session-token")).toBe(true);
    expect(isSecretKey("tokenSecret")).toBe(true);
  });

  it("never throws on a non-string key", () => {
    expect(isSecretKey(undefined)).toBe(false);
    expect(isSecretKey(7)).toBe(false);
    expect(isSecretKey(null)).toBe(false);
  });
});

describe("redactString", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnop1234", "bearer header"],
    ["key sk-abcdefghijklmnopqrstuvwx", "openai key"],
    ["key sk-ant-abcdefghijklmnopqrstuvwx", "anthropic key"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "google key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz01", "github token"],
    ["ya29.abcdefghijklmnopqrstuvwxyz", "google oauth token"],
    ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "jwt"],
    ["dxr1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", "our own envelope"],
  ];

  it.each(cases)("scrubs a secret out of free text: %s", (text) => {
    expect(redactString(text)).toContain(REDACTED);
  });

  it("leaves ordinary prose alone", () => {
    const text = "the model returned 512 tokens in 1.2s";
    expect(redactString(text)).toBe(text);
  });

  it("passes through non-strings unchanged", () => {
    expect(redactString(5)).toBe(5);
    expect(redactString(null)).toBe(null);
  });
});

describe("redactSecrets in mask mode, for transient logs", () => {
  it("masks a secret key but keeps its presence visible", () => {
    const out = redactSecrets({ authorization: "Bearer abc123", model: "gpt-5" });
    expect(out.authorization).toBe(REDACTED);
    expect(out.model).toBe("gpt-5");
  });

  it("reaches secrets nested in arrays and objects", () => {
    const out = redactSecrets({ attempts: [{ headers: { "x-api-key": "sk-live-1234567890123456" } }] });
    expect(out.attempts[0].headers["x-api-key"]).toBe(REDACTED);
  });

  it("does not mutate the input", () => {
    const input = { apiKey: "sk-abcdefghijklmnopqrst" };
    redactSecrets(input);
    expect(input.apiKey).toBe("sk-abcdefghijklmnopqrst");
  });

  it("keeps usage numbers intact while masking the credential beside them", () => {
    const out = redactSecrets({
      authorization: "Bearer xyz",
      tokens: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
    });
    expect(out.tokens).toEqual({ prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 });
    expect(out.authorization).toBe(REDACTED);
  });
});

describe("redactSecrets in drop mode, for persisted diagnostics", () => {
  it("omits the key entirely rather than recording that it existed", () => {
    const out = redactSecrets({ authorization: "Bearer abc", cookie: "a=b", model: "gpt-5" }, { drop: true });
    expect(Object.keys(out)).toEqual(["model"]);
    // A row that never carries the key cannot leak it through a later
    // re-serialisation into a dashboard payload or a support bundle.
    expect(JSON.stringify(out)).not.toContain("authorization");
  });

  it("drops inside Maps and Headers too", () => {
    const map = new Map([["set-cookie", "s=1"], ["model", "gpt-5"]]);
    expect(redactSecrets(map, { drop: true })).toEqual({ model: "gpt-5" });

    const headers = new Headers({ authorization: "Bearer abc", "content-type": "application/json" });
    const out = redactSecrets(headers, { drop: true });
    expect(out.authorization).toBeUndefined();
    expect(out["content-type"]).toBe("application/json");
  });
});

describe("redactSecrets against hostile shapes", () => {
  it("survives a cycle", () => {
    const a = { name: "a" };
    a.self = a;
    expect(redactSecrets(a).self).toBe("[CIRCULAR]");
  });

  it("summarises Buffers instead of dumping key material", () => {
    expect(redactSecrets({ blob: Buffer.from("sk-secret") }).blob).toBe("[Buffer 9]");
  });

  it("survives a getter that throws", () => {
    const obj = {};
    Object.defineProperty(obj, "boom", { get() { throw new Error("nope"); }, enumerable: true });
    expect(redactSecrets(obj).boom).toBe("[UNREADABLE]");
  });

  it("flattens Errors and scrubs their message", () => {
    const err = new Error("upstream said Bearer abcdefghijklmnopqr");
    const out = redactSecrets({ err });
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toContain(REDACTED);
  });

  it("stops at a depth limit instead of recursing forever", () => {
    let deep = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain("[TRUNCATED_DEPTH]");
  });

  it("renders Dates and URLs as strings", () => {
    const out = redactSecrets({ at: new Date(0), url: new URL("https://x.test/?api_key=abc") });
    expect(out.at).toBe("1970-01-01T00:00:00.000Z");
    expect(out.url).toContain("REDACTED");
    expect(out.url).not.toContain("abc");
  });

  it("drops functions and symbols", () => {
    const out = redactSecrets({ fn: () => {}, keep: 1 });
    expect(out).toEqual({ keep: 1 });
  });
});

describe("redactUrl", () => {
  it("replaces a bare ?key= API key, which is how Google takes one", () => {
    // `key` is not a secret *property* name, so the object-level list cannot carry
    // it; as a query parameter it is a live credential. A URL like this is exactly
    // what the executor records for every Gemini call.
    const out = redactUrl("https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyA1234567890abcdefghij");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("AIzaSyA1234567890abcdefghij");
  });

  it("replaces the other credential-bearing parameters", () => {
    for (const param of ["access_token", "auth", "token", "code", "sig", "signature", "password", "api-key"]) {
      const out = redactUrl(`https://x.test/cb?${param}=supersecretvalue123&model=gpt-5`);
      expect(out, param).not.toContain("supersecretvalue123");
      expect(out, param).toContain("model=gpt-5");
    }
  });

  it("redacts a URL embedded in free text too", () => {
    const out = redactUrl("upstream said GET https://x.test/v1?key=abcdefgh failed");
    expect(out).not.toContain("abcdefgh");
  });

  it("leaves a clean URL byte-identical", () => {
    const url = "https://api.openai.com/v1/chat/completions";
    expect(redactUrl(url)).toBe(url);
  });

  it("falls back to string scrubbing when the input is not a URL", () => {
    expect(redactUrl("not a url sk-abcdefghijklmnopqrst")).toContain(REDACTED);
  });
});

describe("redactHeaders", () => {
  it("always returns an object", () => {
    expect(redactHeaders(null)).toEqual({});
    expect(redactHeaders(undefined)).toEqual({});
  });

  it("masks by default and drops on request", () => {
    const h = { Authorization: "Bearer abc", "x-request-id": "r1" };
    expect(redactHeaders(h).Authorization).toBe(REDACTED);
    expect(redactHeaders(h, { drop: true })).toEqual({ "x-request-id": "r1" });
  });
});
